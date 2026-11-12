package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Managed-device control plane. Distinct from the per-user Tauri 'device'
// credential: these are company laptops running the disclosed Windows service.
// A device authenticates with its own bearer token (devices.token_hash) and is
// mapped to a WorkTrack user by UPN (email) at enrollment.

type managedDevice struct {
	id        string
	userID    *string
	upn       string
	uninstall bool
}

// deviceToken resolves a managed-device bearer token to the device row. A
// device marked for uninstall still authenticates so check-in can deliver the
// uninstall command; deviceEvents refuses its uploads.
func (a *app) deviceToken(r *http.Request) (managedDevice, bool) {
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		return managedDevice{}, false
	}
	hash := digest(strings.TrimPrefix(h, "Bearer "))
	var d managedDevice
	e := a.db.QueryRow(r.Context(),
		"SELECT id::text,user_id::text,upn,uninstall FROM devices WHERE token_hash=$1",
		hash).Scan(&d.id, &d.userID, &d.upn, &d.uninstall)
	if e != nil {
		return managedDevice{}, false
	}
	return d, true
}

// enroll exchanges an enrollment secret for a durable device token. The secret
// is minted by an admin (createEnrollment) and passed to the agent on the
// Intune install command line, which is shared by every laptop in the
// assignment, so it stays valid until it expires or an owner revokes it.
func (a *app) enroll(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Secret   string `json:"secret"`
		UPN      string `json:"upn"`
		Hostname string `json:"hostname"`
	}
	if !decode(w, r, &in) {
		return
	}
	in.UPN = strings.ToLower(strings.TrimSpace(in.UPN))
	if in.Secret == "" || in.UPN == "" || len(in.Hostname) > 255 {
		fail(w, 400, "secret and upn required")
		return
	}
	if !a.limiter.allow("enroll:"+a.clientIP(r), 10) {
		w.Header().Set("Retry-After", "60")
		fail(w, 429, "enrollment limit reached")
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		fail(w, 503, "enrollment unavailable")
		return
	}
	defer tx.Rollback(r.Context())
	tag, err := tx.Exec(r.Context(),
		"UPDATE device_enrollments SET used_at=now() WHERE secret_hash=$1 AND revoked_at IS NULL AND expires_at>now()",
		digest(in.Secret))
	if err != nil {
		fail(w, 503, "enrollment unavailable")
		return
	}
	if tag.RowsAffected() != 1 {
		fail(w, 401, "invalid, expired or revoked enrollment secret")
		return
	}
	// Map UPN to an existing user. Unknown UPNs still enroll (user_id NULL) so IT
	// can link the account later rather than losing the device.
	var userID *string
	var id string
	if e := tx.QueryRow(r.Context(), "SELECT id::text FROM users WHERE email=$1", in.UPN).Scan(&id); e == nil {
		userID = &id
	} else if !errors.Is(e, pgx.ErrNoRows) {
		fail(w, 503, "enrollment unavailable")
		return
	}
	deviceID, plain := uuid.NewString(), token()
	if _, err = tx.Exec(r.Context(),
		"INSERT INTO devices(id,token_hash,user_id,upn,hostname) VALUES($1,$2,$3,$4,$5)",
		deviceID, digest(plain), userID, in.UPN, in.Hostname); err != nil {
		fail(w, 503, "enrollment unavailable")
		return
	}
	if tx.Commit(r.Context()) != nil {
		fail(w, 503, "enrollment unavailable")
		return
	}
	writeJSON(w, 200, map[string]string{"device_id": deviceID, "token": plain})
}

// checkin is the heartbeat and command channel. The agent reports observed
// state; the server returns desired state and config if newer. Poll model works
// through NAT/VPN with no inbound port.
func (a *app) checkin(w http.ResponseWriter, r *http.Request) {
	d, okAuth := a.deviceToken(r)
	if !okAuth {
		fail(w, 401, "device token required")
		return
	}
	var in struct {
		AgentVersion  string `json:"agent_version"`
		BufferDepth   int    `json:"buffer_depth"`
		DroppedEvents int64  `json:"dropped_events"`
		ConfigVersion int    `json:"config_version"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.AgentVersion != "" && !agentVersion.MatchString(in.AgentVersion) {
		fail(w, 400, "invalid agent version")
		return
	}
	var out struct {
		Enabled       bool            `json:"enabled"`
		Paused        bool            `json:"paused"`
		Uninstall     bool            `json:"uninstall"`
		ConfigVersion int             `json:"config_version"`
		Config        *map[string]any `json:"config,omitempty"`
	}
	var cfg map[string]any
	e := a.db.QueryRow(r.Context(), `UPDATE devices SET
	  agent_version=COALESCE(NULLIF($2,''),agent_version),
	  buffer_depth=$3, dropped_events=$4, last_checkin_at=now()
	 WHERE id=$1
	 RETURNING enabled,paused,uninstall,config_version,config`,
		d.id, in.AgentVersion, in.BufferDepth, in.DroppedEvents).
		Scan(&out.Enabled, &out.Paused, &out.Uninstall, &out.ConfigVersion, &cfg)
	if e != nil {
		fail(w, 503, "check-in unavailable")
		return
	}
	// Only ship config when the agent's cached version is stale.
	if in.ConfigVersion < out.ConfigVersion {
		out.Config = &cfg
	}
	writeJSON(w, 200, out)
}

// events ingests a batch durably and idempotently. Returns acked_seq; the agent
// prunes its local buffer up to that point. Duplicate events are suppressed by
// the (device_id,event_id) primary key, so the agent must give every event a
// unique event_id. seq is only the agent's local ordering: it restarts at 1
// when the local buffer is recreated.
func (a *app) deviceEvents(w http.ResponseWriter, r *http.Request) {
	d, okAuth := a.deviceToken(r)
	if !okAuth {
		fail(w, 401, "device token required")
		return
	}
	if d.uninstall {
		fail(w, 403, "device is uninstalling")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	type ev struct {
		Seq        int64          `json:"seq"`
		EventID    string         `json:"event_id"`
		Kind       string         `json:"kind"`
		OccurredAt time.Time      `json:"occurred_at"`
		Payload    map[string]any `json:"payload"`
	}
	var in struct {
		Events []ev `json:"events"`
	}
	if !decode(w, r, &in) {
		return
	}
	if len(in.Events) < 1 || len(in.Events) > 500 {
		fail(w, 400, "1 to 500 events required")
		return
	}
	now := time.Now()
	var acked int64
	for _, e := range in.Events {
		acked = max(acked, e.Seq)
		if e.Seq < 1 || !validID(e.EventID) || e.Kind == "" || len(e.Kind) > 64 ||
			e.OccurredAt.IsZero() || e.OccurredAt.After(now.Add(2*time.Minute)) {
			fail(w, 400, "invalid event")
			return
		}
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		fail(w, 503, "ingest unavailable")
		return
	}
	defer tx.Rollback(r.Context())
	for _, e := range in.Events {
		payload := e.Payload
		if payload == nil {
			payload = map[string]any{}
		}
		if _, err = tx.Exec(r.Context(),
			`INSERT INTO device_events(device_id,seq,event_id,kind,occurred_at,payload)
			 VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(device_id,event_id) DO NOTHING`,
			d.id, e.Seq, e.EventID, e.Kind, e.OccurredAt, payload); err != nil {
			fail(w, 503, "could not store events")
			return
		}
	}
	// Every event in this batch is now stored, by this request or an earlier
	// one, and the agent sends FIFO, so the highest seq in the batch is the safe
	// prune point. The stored maximum is not: it outlives a recreated buffer.
	if _, err = tx.Exec(r.Context(),
		"UPDATE devices SET acked_seq=$2, last_sync_at=now() WHERE id=$1", d.id, acked); err != nil {
		fail(w, 503, "ingest unavailable")
		return
	}
	if tx.Commit(r.Context()) != nil {
		fail(w, 503, "could not store events")
		return
	}
	writeJSON(w, 200, map[string]int64{"acked_seq": acked})
}

// audit appends a tamper-evident admin-action row, chaining the prior hash.
func (a *app) audit(ctx context.Context, tx pgx.Tx, actorID, action string, deviceID *string, detail map[string]any) error {
	var prev string
	if err := tx.QueryRow(ctx, "SELECT COALESCE((SELECT hash FROM admin_audit ORDER BY id DESC LIMIT 1),'')").Scan(&prev); err != nil {
		return err
	}
	at := time.Now().UTC().Format(time.RFC3339Nano)
	sum := sha256.Sum256([]byte(prev + actorID + action + at))
	h := hex.EncodeToString(sum[:])
	_, err := tx.Exec(ctx,
		"INSERT INTO admin_audit(actor_id,device_id,action,detail,prev_hash,hash) VALUES($1,$2,$3,$4,$5,$6)",
		actorID, deviceID, action, detail, prev, h)
	return err
}
