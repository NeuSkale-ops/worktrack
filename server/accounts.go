package main

import (
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

// canManage: owners manage everyone except themselves, managers manage workers only.
func canManage(actor identity, targetID, targetRole string) bool {
	if actor.ID == targetID {
		return false
	}
	return actor.Role == "owner" || (actor.Role == "manager" && targetRole == "worker")
}

// target loads a user the caller may administer, writing the error response otherwise.
func (a *app) target(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := r.PathValue("id")
	if !validID(id) {
		fail(w, 400, "invalid user ID")
		return "", false
	}
	var role string
	e := a.db.QueryRow(r.Context(), "SELECT role FROM users WHERE id=$1", id).Scan(&role)
	if errors.Is(e, pgx.ErrNoRows) {
		fail(w, 404, "user not found")
		return "", false
	}
	if e != nil {
		fail(w, 500, "user unavailable")
		return "", false
	}
	if !canManage(current(r), id, role) {
		fail(w, 403, "not allowed to manage this user")
		return "", false
	}
	return id, true
}

// disableUser blocks sign-in, revokes every credential and closes any open
// session at its last uploaded block, never inventing tracked time.
func (a *app) disableUser(w http.ResponseWriter, r *http.Request) {
	id, okay := a.target(w, r)
	if !okay {
		return
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		fail(w, 500, "disable failed")
		return
	}
	defer tx.Rollback(r.Context())
	for _, q := range []string{
		"SELECT id FROM users WHERE id=$1 FOR UPDATE",
		"UPDATE users SET disabled_at=COALESCE(disabled_at,now()) WHERE id=$1",
		"DELETE FROM credentials WHERE user_id=$1",
		"UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL",
		"UPDATE work_sessions s SET stopped_at=GREATEST(s.started_at,(SELECT max(end_at) FROM blocks WHERE session_id=s.id)) WHERE s.user_id=$1 AND s.stopped_at IS NULL",
	} {
		if _, e = tx.Exec(r.Context(), q, id); e != nil {
			fail(w, 500, "disable failed")
			return
		}
	}
	if tx.Commit(r.Context()) != nil {
		fail(w, 500, "disable failed")
		return
	}
	ok(w)
}
func (a *app) enableUser(w http.ResponseWriter, r *http.Request) {
	id, okay := a.target(w, r)
	if !okay {
		return
	}
	if _, e := a.db.Exec(r.Context(), "UPDATE users SET disabled_at=NULL WHERE id=$1", id); e != nil {
		fail(w, 500, "enable failed")
		return
	}
	ok(w)
}
func (a *app) revokeDevices(w http.ResponseWriter, r *http.Request) {
	id, okay := a.target(w, r)
	if !okay {
		return
	}
	tag, e := a.db.Exec(r.Context(), "DELETE FROM credentials WHERE user_id=$1 AND kind='device'", id)
	if e != nil {
		fail(w, 500, "revoke failed")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "revoked": tag.RowsAffected()})
}

// createPasswordReset issues a one-time 24-hour link. Like invites, the admin
// delivers it out of band, so no email service is needed.
func (a *app) createPasswordReset(w http.ResponseWriter, r *http.Request) {
	id, okay := a.target(w, r)
	if !okay {
		return
	}
	raw := token()
	expiry := time.Now().UTC().Add(24 * time.Hour)
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		fail(w, 500, "reset failed")
		return
	}
	defer tx.Rollback(r.Context())
	// Only the newest link stays valid.
	if _, e = tx.Exec(r.Context(), "UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL", id); e != nil {
		fail(w, 500, "reset failed")
		return
	}
	if _, e = tx.Exec(r.Context(), "INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES($1,$2,$3)", digest(raw), id, expiry); e != nil {
		fail(w, 500, "reset failed")
		return
	}
	if tx.Commit(r.Context()) != nil {
		fail(w, 500, "reset failed")
		return
	}
	writeJSON(w, 201, map[string]any{"token": raw, "url": a.origin + "/reset?token=" + raw, "expires_at": expiry})
}

// setPassword stores a new hash and revokes credentials, except keepHash when non-empty.
func setPassword(r *http.Request, tx pgx.Tx, uid, password, keepHash string) error {
	if _, e := tx.Exec(r.Context(), "UPDATE users SET password_hash=$2 WHERE id=$1", uid, passwordHash(password)); e != nil {
		return e
	}
	if _, e := tx.Exec(r.Context(), "DELETE FROM credentials WHERE user_id=$1 AND token_hash<>$2", uid, keepHash); e != nil {
		return e
	}
	_, e := tx.Exec(r.Context(), "UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL", uid)
	return e
}
func validNewPassword(p string) bool { return len(p) >= 12 && len(p) <= 1024 }

func (a *app) resetPassword(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token    string `json:"token"`
		Password string `json:"password"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !validNewPassword(in.Password) || len(in.Token) > 100 {
		fail(w, 400, "password (12+ characters) required")
		return
	}
	if !a.allowLogin(w, r, "reset:"+digest(in.Token)) || !a.authCapacity(w) {
		return
	}
	defer func() { <-a.authSlots }()
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		fail(w, 500, "reset failed")
		return
	}
	defer tx.Rollback(r.Context())
	var uid string
	e = tx.QueryRow(r.Context(), "UPDATE password_resets p SET used_at=now() FROM users u WHERE p.token_hash=$1 AND p.used_at IS NULL AND p.expires_at>now() AND u.id=p.user_id AND u.disabled_at IS NULL RETURNING p.user_id::text", digest(in.Token)).Scan(&uid)
	if e != nil {
		fail(w, 400, "invalid or expired reset link")
		return
	}
	if setPassword(r, tx, uid, in.Password, "") != nil || tx.Commit(r.Context()) != nil {
		fail(w, 500, "reset failed")
		return
	}
	ok(w)
}

// changePassword keeps the caller's current credential and signs out everything else.
func (a *app) changePassword(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Current string `json:"current_password"`
		New     string `json:"new_password"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !validNewPassword(in.New) || len(in.Current) > 1024 {
		fail(w, 400, "new password (12+ characters) required")
		return
	}
	u := current(r)
	if !a.allowLogin(w, r, u.Email) || !a.authCapacity(w) {
		return
	}
	defer func() { <-a.authSlots }()
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		fail(w, 500, "password change failed")
		return
	}
	defer tx.Rollback(r.Context())
	var hash string
	if e = tx.QueryRow(r.Context(), "SELECT password_hash FROM users WHERE id=$1 FOR UPDATE", u.ID).Scan(&hash); e != nil {
		fail(w, 500, "password change failed")
		return
	}
	if !passwordOK(in.Current, hash) {
		fail(w, 403, "current password is incorrect")
		return
	}
	if setPassword(r, tx, u.ID, in.New, u.hash) != nil || tx.Commit(r.Context()) != nil {
		fail(w, 500, "password change failed")
		return
	}
	ok(w)
}
