package main

import (
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

// Admin surface for the managed-device fleet. Enrollment secrets are owner
// only. Owners manage every device, managers the devices of their org. A
// device's org is its own field (devices.org_id), set by an owner.
// Mutations are recorded in admin_audit. These power the dashboard Devices page.

func (a *app) requireOwner(w http.ResponseWriter, r *http.Request) bool {
	if current(r).Role != "owner" {
		fail(w, 403, "owner access required")
		return false
	}
	return true
}

// requireAdmin admits owners and managers.
func (a *app) requireAdmin(w http.ResponseWriter, r *http.Request) bool {
	if current(r).Role == "worker" {
		fail(w, 403, "manager access required")
		return false
	}
	return true
}

// deviceVisible validates the path device id and checks the caller may manage
// it. A device in another org is reported as not found.
func (a *app) deviceVisible(w http.ResponseWriter, r *http.Request) (string, bool) {
	if !a.requireAdmin(w, r) {
		return "", false
	}
	id := r.PathValue("id")
	if !validID(id) {
		fail(w, 400, "invalid device id")
		return "", false
	}
	cond, args := sees(r, "d.user_id", "d.org_id", 2)
	var found bool
	if e := a.db.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM devices d WHERE d.id=$1 AND "+cond+")", append([]any{id}, args...)...).Scan(&found); e != nil {
		fail(w, 503, "device unavailable")
		return "", false
	}
	if !found {
		fail(w, 404, "device not found")
		return "", false
	}
	return id, true
}

// createEnrollment mints a secret for Intune to pass to the agent. It enrolls
// any number of devices until it expires or revokeEnrollments runs.
func (a *app) createEnrollment(w http.ResponseWriter, r *http.Request) {
	if !a.requireOwner(w, r) {
		return
	}
	secret := token()
	if _, err := a.db.Exec(r.Context(),
		"INSERT INTO device_enrollments(secret_hash,created_by,expires_at) VALUES($1,$2,now()+interval '7 days')",
		digest(secret), current(r).ID); err != nil {
		fail(w, 503, "could not create enrollment")
		return
	}
	writeJSON(w, 200, map[string]any{"secret": secret, "expires_in_days": 7})
}

// revokeEnrollments invalidates every outstanding enrollment secret, for use
// when a rollout is finished or a secret has leaked. Enrolled devices keep
// their own tokens.
func (a *app) revokeEnrollments(w http.ResponseWriter, r *http.Request) {
	if !a.requireOwner(w, r) {
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		fail(w, 503, "revoke unavailable")
		return
	}
	defer tx.Rollback(r.Context())
	tag, err := tx.Exec(r.Context(),
		"UPDATE device_enrollments SET revoked_at=now() WHERE revoked_at IS NULL AND expires_at>now()")
	if err == nil {
		err = a.audit(r.Context(), tx, current(r).ID, "revoke-enrollments", nil, map[string]any{"revoked": tag.RowsAffected()})
	}
	if err != nil || tx.Commit(r.Context()) != nil {
		fail(w, 503, "revoke unavailable")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "revoked": tag.RowsAffected()})
}

// listDevices returns fleet health for the dashboard.
func (a *app) listDevices(w http.ResponseWriter, r *http.Request) {
	if !a.requireAdmin(w, r) {
		return
	}
	cond, args := sees(r, "d.user_id", "d.org_id", 1)
	rows, err := a.db.Query(r.Context(), `SELECT d.id::text,d.user_id::text,d.org_id,d.upn,d.hostname,u.name,
	  d.enabled,d.paused,d.uninstall,d.agent_version,d.config_version,d.config,
	  d.last_checkin_at,d.last_sync_at,d.buffer_depth,d.dropped_events,d.acked_seq
	 FROM devices d LEFT JOIN users u ON u.id=d.user_id
	 WHERE `+cond+`
	 ORDER BY d.last_checkin_at DESC NULLS LAST`, args...)
	if err != nil {
		fail(w, 503, "devices unavailable")
		return
	}
	defer rows.Close()
	type dev struct {
		ID            string         `json:"id"`
		UserID        *string        `json:"user_id"`
		OrgID         *string        `json:"org_id"`
		UPN           string         `json:"upn"`
		Hostname      string         `json:"hostname"`
		Name          *string        `json:"name"`
		Enabled       bool           `json:"enabled"`
		Paused        bool           `json:"paused"`
		Uninstall     bool           `json:"uninstall"`
		AgentVersion  string         `json:"agent_version"`
		ConfigVersion int            `json:"config_version"`
		Config        map[string]any `json:"config"`
		LastCheckinAt *time.Time     `json:"last_checkin_at"`
		LastSyncAt    *time.Time     `json:"last_sync_at"`
		BufferDepth   int            `json:"buffer_depth"`
		DroppedEvents int64          `json:"dropped_events"`
		AckedSeq      int64          `json:"acked_seq"`
	}
	out := []dev{}
	for rows.Next() {
		var d dev
		if err = rows.Scan(&d.ID, &d.UserID, &d.OrgID, &d.UPN, &d.Hostname, &d.Name, &d.Enabled, &d.Paused,
			&d.Uninstall, &d.AgentVersion, &d.ConfigVersion, &d.Config, &d.LastCheckinAt, &d.LastSyncAt,
			&d.BufferDepth, &d.DroppedEvents, &d.AckedSeq); err != nil {
			fail(w, 503, "devices unavailable")
			return
		}
		out = append(out, d)
	}
	if rows.Err() != nil {
		fail(w, 503, "devices unavailable")
		return
	}
	writeJSON(w, 200, out)
}

// updateConfig replaces capture config and bumps config_version so the next
// check-in delivers it.
func (a *app) updateConfig(w http.ResponseWriter, r *http.Request) {
	id, okay := a.deviceVisible(w, r)
	if !okay {
		return
	}
	var cfg map[string]any
	if !decode(w, r, &cfg) {
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		fail(w, 503, "config unavailable")
		return
	}
	defer tx.Rollback(r.Context())
	tag, err := tx.Exec(r.Context(),
		"UPDATE devices SET config=$2, config_version=config_version+1 WHERE id=$1", id, cfg)
	if err != nil {
		fail(w, 503, "config unavailable")
		return
	}
	if tag.RowsAffected() != 1 {
		fail(w, 404, "device not found")
		return
	}
	if err = a.audit(r.Context(), tx, current(r).ID, "config", &id, cfg); err != nil {
		fail(w, 503, "config unavailable")
		return
	}
	if tx.Commit(r.Context()) != nil {
		fail(w, 503, "config unavailable")
		return
	}
	ok(w)
}

// deviceCommand sets desired lifecycle state: enable/disable, pause/resume,
// uninstall. Applied by the agent on next check-in.
func (a *app) deviceCommand(w http.ResponseWriter, r *http.Request) {
	id, okay := a.deviceVisible(w, r)
	if !okay {
		return
	}
	var in struct {
		Command string `json:"command"`
	}
	if !decode(w, r, &in) {
		return
	}
	// column=value per command. Uninstall is one-way.
	set := map[string]string{
		"enable":    "enabled=true",
		"disable":   "enabled=false",
		"pause":     "paused=true",
		"resume":    "paused=false",
		"uninstall": "uninstall=true",
	}[in.Command]
	if set == "" {
		fail(w, 400, "unknown command")
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		fail(w, 503, "command unavailable")
		return
	}
	defer tx.Rollback(r.Context())
	tag, err := tx.Exec(r.Context(), "UPDATE devices SET "+set+" WHERE id=$1", id)
	if err != nil {
		fail(w, 503, "command unavailable")
		return
	}
	if tag.RowsAffected() != 1 {
		fail(w, 404, "device not found")
		return
	}
	if err = a.audit(r.Context(), tx, current(r).ID, in.Command, &id, map[string]any{}); err != nil {
		fail(w, 503, "command unavailable")
		return
	}
	if tx.Commit(r.Context()) != nil {
		fail(w, 503, "command unavailable")
		return
	}
	ok(w)
}

// assignDevice links a laptop to the person who uses it, or unlinks it with
// null. Its activity from then on is shown under that person. Owners assign
// anyone. Managers reassign laptops they can already see to people in their
// own org, and cannot unassign. The person must be in the laptop's org. A
// laptop with no org takes the org of the person it is assigned to.
func (a *app) assignDevice(w http.ResponseWriter, r *http.Request) {
	id, okay := a.deviceVisible(w, r)
	if !okay {
		return
	}
	var in struct {
		UserID *string `json:"user_id"`
	}
	if !decode(w, r, &in) {
		return
	}
	actor := current(r)
	if in.UserID == nil && actor.Role != "owner" {
		fail(w, 403, "only an owner can unassign a laptop")
		return
	}
	if in.UserID != nil && !validID(*in.UserID) {
		fail(w, 400, "invalid user ID")
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		fail(w, 503, "assignment unavailable")
		return
	}
	defer tx.Rollback(r.Context())
	var org *string
	var role string
	if in.UserID != nil {
		err = tx.QueryRow(r.Context(), "SELECT org_id,role FROM users WHERE id=$1", *in.UserID).Scan(&org, &role)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && !sameOrg(actor, org)) {
			fail(w, 404, "user not found")
			return
		}
		if err != nil {
			fail(w, 503, "assignment unavailable")
			return
		}
	}
	var deviceOrg *string
	if err = tx.QueryRow(r.Context(), "SELECT org_id FROM devices WHERE id=$1 FOR UPDATE", id).Scan(&deviceOrg); err != nil {
		fail(w, 503, "assignment unavailable")
		return
	}
	// A laptop in an organisation goes only to that organisation's people, or to an owner.
	if in.UserID != nil && deviceOrg != nil && role != "owner" && (org == nil || *org != *deviceOrg) {
		fail(w, 409, "that person is in another organisation. Change the laptop's organisation first")
		return
	}
	// Saving the same person again must not move assigned_at, which would hide
	// the laptop's earlier activity.
	tag, err := tx.Exec(r.Context(), "UPDATE devices SET user_id=$2, assigned_at=now(), org_id=COALESCE(org_id,$3) WHERE id=$1 AND user_id IS DISTINCT FROM $2", id, in.UserID, org)
	if err == nil && tag.RowsAffected() == 1 {
		err = a.audit(r.Context(), tx, actor.ID, "assign", &id, map[string]any{"user_id": in.UserID})
	}
	if err != nil || tx.Commit(r.Context()) != nil {
		fail(w, 503, "assignment unavailable")
		return
	}
	ok(w)
}

// setDeviceOrg puts a laptop in an organisation, or in none with null. Owner
// only. Managers of that organisation see the laptop from then on, but not its
// earlier activity. A person who is not in the new organisation is unassigned.
func (a *app) setDeviceOrg(w http.ResponseWriter, r *http.Request) {
	if !a.requireOwner(w, r) {
		return
	}
	id := r.PathValue("id")
	if !validID(id) {
		fail(w, 400, "invalid device id")
		return
	}
	var in struct {
		OrgID *string `json:"org_id"`
	}
	if !decode(w, r, &in) {
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		fail(w, 503, "organisation change unavailable")
		return
	}
	defer tx.Rollback(r.Context())
	var found, known bool
	if err = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM devices WHERE id=$1), $2::text IS NULL OR EXISTS(SELECT 1 FROM orgs WHERE id=$2)", id, in.OrgID).Scan(&found, &known); err != nil {
		fail(w, 503, "organisation change unavailable")
		return
	}
	if !found || !known {
		fail(w, 404, "laptop or organisation not found")
		return
	}
	// assigned_at moves so the new organisation's managers do not inherit the
	// laptop's earlier activity. Saving the same organisation changes nothing.
	tag, err := tx.Exec(r.Context(), `UPDATE devices d SET org_id=$2, assigned_at=now(),
	  user_id=CASE WHEN $2::text IS NOT NULL AND EXISTS(SELECT 1 FROM users u WHERE u.id=d.user_id AND u.role<>'owner' AND u.org_id IS DISTINCT FROM $2::text) THEN NULL ELSE d.user_id END
	 WHERE d.id=$1 AND d.org_id IS DISTINCT FROM $2`, id, in.OrgID)
	if err == nil && tag.RowsAffected() == 1 {
		err = a.audit(r.Context(), tx, current(r).ID, "set-org", &id, map[string]any{"org_id": in.OrgID})
	}
	if err != nil || tx.Commit(r.Context()) != nil {
		fail(w, 503, "organisation change unavailable")
		return
	}
	ok(w)
}
