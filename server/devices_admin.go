package main

import (
	"net/http"
	"time"
)

// Admin surface for the managed-device fleet. Owner-only, mutations recorded in
// admin_audit. These power the dashboard Devices page.

func (a *app) requireOwner(w http.ResponseWriter, r *http.Request) bool {
	if current(r).Role != "owner" {
		fail(w, 403, "owner access required")
		return false
	}
	return true
}

// createEnrollment mints a one-time secret for Intune to pass to the agent.
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

// listDevices returns fleet health for the dashboard.
func (a *app) listDevices(w http.ResponseWriter, r *http.Request) {
	if !a.requireOwner(w, r) {
		return
	}
	rows, err := a.db.Query(r.Context(), `SELECT d.id::text,d.upn,d.hostname,u.name,
	  d.enabled,d.paused,d.uninstall,d.agent_version,d.config_version,
	  d.last_checkin_at,d.last_sync_at,d.buffer_depth,d.dropped_events,d.acked_seq
	 FROM devices d LEFT JOIN users u ON u.id=d.user_id
	 ORDER BY d.last_checkin_at DESC NULLS LAST`)
	if err != nil {
		fail(w, 503, "devices unavailable")
		return
	}
	defer rows.Close()
	type dev struct {
		ID            string     `json:"id"`
		UPN           string     `json:"upn"`
		Hostname      string     `json:"hostname"`
		Name          *string    `json:"name"`
		Enabled       bool       `json:"enabled"`
		Paused        bool       `json:"paused"`
		Uninstall     bool       `json:"uninstall"`
		AgentVersion  string     `json:"agent_version"`
		ConfigVersion int        `json:"config_version"`
		LastCheckinAt *time.Time `json:"last_checkin_at"`
		LastSyncAt    *time.Time `json:"last_sync_at"`
		BufferDepth   int        `json:"buffer_depth"`
		DroppedEvents int64      `json:"dropped_events"`
		AckedSeq      int64      `json:"acked_seq"`
	}
	out := []dev{}
	for rows.Next() {
		var d dev
		if err = rows.Scan(&d.ID, &d.UPN, &d.Hostname, &d.Name, &d.Enabled, &d.Paused,
			&d.Uninstall, &d.AgentVersion, &d.ConfigVersion, &d.LastCheckinAt, &d.LastSyncAt,
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
	if !a.requireOwner(w, r) {
		return
	}
	id := r.PathValue("id")
	if !validID(id) {
		fail(w, 400, "invalid device id")
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
	if !a.requireOwner(w, r) {
		return
	}
	id := r.PathValue("id")
	if !validID(id) {
		fail(w, 400, "invalid device id")
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
