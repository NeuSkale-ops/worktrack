package main

import (
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/google/uuid"
)

func (a *app) authCapacity(w http.ResponseWriter) bool {
	select {
	case a.authSlots <- struct{}{}:
		return true
	default:
		fail(w, 429, "too many authentication requests")
		return false
	}
}
func (a *app) login(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email      string `json:"email"`
		Password   string `json:"password"`
		DeviceName string `json:"device_name"`
	}
	if !decode(w, r, &in) {
		return
	}
	if len(in.Email) > 254 || len(in.Password) > 1024 || in.Password == "" || len(in.DeviceName) > 200 {
		fail(w, 400, "invalid credentials")
		return
	}
	if in.DeviceName == "" && r.Header.Get("Origin") == "" {
		fail(w, 403, "Origin required for browser login")
		return
	}
	if !a.allowLogin(w, r, in.Email) {
		return
	}
	if !a.authCapacity(w) {
		return
	}
	defer func() { <-a.authSlots }()
	var u user
	var hash string
	e := a.db.QueryRow(r.Context(), "SELECT id::text,email,name,role,org_id,password_hash FROM users WHERE email=$1 AND disabled_at IS NULL", strings.ToLower(strings.TrimSpace(in.Email))).Scan(&u.ID, &u.Email, &u.Name, &u.Role, &u.OrgID, &hash)
	if e != nil {
		hash = "AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	}
	valid := passwordOK(in.Password, hash)
	if e != nil || !valid {
		fail(w, 401, "invalid email or password")
		return
	}
	raw := token()
	kind := "browser"
	ttl := 24 * time.Hour
	if in.DeviceName != "" {
		kind = "device"
		ttl = 90 * 24 * time.Hour
	}
	_, e = a.db.Exec(r.Context(), "INSERT INTO credentials(token_hash,user_id,kind,device_name,expires_at) VALUES($1,$2,$3,$4,$5)", digest(raw), u.ID, kind, in.DeviceName, time.Now().Add(ttl))
	if e != nil {
		fail(w, 500, "could not create session")
		return
	}
	out := map[string]any{"user": u}
	if kind == "device" {
		out["device_token"] = raw
	} else {
		http.SetCookie(w, &http.Cookie{Name: "worktrack_session", Value: raw, Path: "/api", HttpOnly: true, Secure: !a.dev, SameSite: http.SameSiteStrictMode, MaxAge: int(ttl.Seconds())})
	}
	writeJSON(w, 200, out)
}
func (a *app) logout(w http.ResponseWriter, r *http.Request) {
	_, e := a.db.Exec(r.Context(), "DELETE FROM credentials WHERE token_hash=$1", current(r).hash)
	if e != nil {
		fail(w, 500, "logout failed")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: "worktrack_session", Value: "", Path: "/api", MaxAge: -1, HttpOnly: true, Secure: !a.dev, SameSite: http.SameSiteStrictMode})
	ok(w)
}
func (a *app) invite(w http.ResponseWriter, r *http.Request) {
	u := current(r)
	if u.Role == "worker" {
		fail(w, 403, "manager access required")
		return
	}
	var in struct {
		Email string `json:"email"`
		Role  string `json:"role"`
		OrgID string `json:"org_id"`
	}
	if !decode(w, r, &in) {
		return
	}
	in.Email = strings.ToLower(strings.TrimSpace(in.Email))
	if in.Role == "" {
		in.Role = "worker"
	}
	addr, e := mail.ParseAddress(in.Email)
	if e != nil || addr.Address != in.Email || len(in.Email) > 254 || (in.Role != "worker" && in.Role != "manager") {
		fail(w, 400, "invalid email or role")
		return
	}
	if in.Role == "manager" && u.Role != "owner" {
		fail(w, 403, "only owner may invite managers")
		return
	}
	// Managers always invite into their own org. Owners choose one, or leave
	// the person unassigned for the Organisations page.
	org := u.OrgID
	if u.Role == "owner" {
		org = nil
		if in.OrgID != "" {
			org = &in.OrgID
		}
	} else if org == nil {
		fail(w, 403, "manager has no organisation")
		return
	}
	raw := token()
	expiry := time.Now().UTC().Add(7 * 24 * time.Hour)
	_, e = a.db.Exec(r.Context(), "INSERT INTO invites(token_hash,email,role,expires_at,org_id) VALUES($1,$2,$3,$4,$5)", digest(raw), in.Email, in.Role, expiry, org)
	if e != nil {
		fail(w, 400, "invite failed: check the organisation")
		return
	}
	writeJSON(w, 201, map[string]any{"token": raw, "url": a.origin + "/invite?token=" + raw, "expires_at": expiry})
}
func (a *app) acceptInvite(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token    string `json:"token"`
		Name     string `json:"name"`
		Password string `json:"password"`
	}
	if !decode(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	if len(in.Password) < 12 || len(in.Password) > 1024 || in.Name == "" || len(in.Name) > 200 || len(in.Token) > 100 {
		fail(w, 400, "name and password (12+ characters) required")
		return
	}
	if !a.allowLogin(w, r, "invite:"+digest(in.Token)) {
		return
	}
	if !a.authCapacity(w) {
		return
	}
	defer func() { <-a.authSlots }()
	hash := passwordHash(in.Password)
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		fail(w, 500, "invite failed")
		return
	}
	defer tx.Rollback(r.Context())
	var email, role string
	var org *string
	e = tx.QueryRow(r.Context(), "UPDATE invites SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING email,role,org_id", digest(in.Token)).Scan(&email, &role, &org)
	if e != nil {
		fail(w, 400, "invalid or expired invite")
		return
	}
	_, e = tx.Exec(r.Context(), "INSERT INTO users(id,email,name,role,password_hash,org_id) VALUES($1,$2,$3,$4,$5,$6)", uuid.NewString(), email, in.Name, role, hash, org)
	if e != nil {
		fail(w, 409, "email already registered")
		return
	}
	if tx.Commit(r.Context()) != nil {
		fail(w, 500, "invite failed")
		return
	}
	ok(w)
}
func (a *app) heartbeat(w http.ResponseWriter, r *http.Request) {
	_, e := a.db.Exec(r.Context(), "UPDATE users SET last_seen_at=now() WHERE id=$1", current(r).ID)
	if e != nil {
		fail(w, 500, "heartbeat failed")
		return
	}
	ok(w)
}
func (a *app) team(w http.ResponseWriter, r *http.Request) {
	cond, args := sees(r, "u.id", "u.org_id", 1)
	rows, e := a.db.Query(r.Context(), `SELECT u.id::text,u.email,u.name,u.role,u.org_id,u.last_seen_at,EXISTS(SELECT 1 FROM work_sessions s WHERE s.user_id=u.id AND s.stopped_at IS NULL) AND u.last_seen_at>now()-interval '2 minutes',u.disabled_at IS NOT NULL FROM users u WHERE `+cond+` ORDER BY u.name,u.id`, args...)
	if e != nil {
		fail(w, 500, "team unavailable")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var v user
		var seen *time.Time
		var working *bool
		var disabled bool
		if e = rows.Scan(&v.ID, &v.Email, &v.Name, &v.Role, &v.OrgID, &seen, &working, &disabled); e != nil {
			fail(w, 500, "team unavailable")
			return
		}
		out = append(out, map[string]any{"id": v.ID, "email": v.Email, "name": v.Name, "role": v.Role, "org_id": v.OrgID, "last_seen_at": seen, "working": working != nil && *working, "disabled": disabled})
	}
	if rows.Err() != nil {
		fail(w, 500, "team unavailable")
		return
	}
	writeJSON(w, 200, out)
}
