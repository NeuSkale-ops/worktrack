package main

import (
	"context"
	"log/slog"
	"net/http"
	"regexp"
	"time"
)

type logDefinition struct{ level, message string }

// Only fixed codes cross the diagnostic boundary, never arbitrary error text.
var agentLogCodes = map[string]logDefinition{
	"login_failed":          {"warn", "Sign-in request failed."},
	"sync_failed":           {"warn", "Tracking data could not be synced."},
	"capture_failed":        {"error", "Screenshot capture failed."},
	"activity_failed":       {"error", "Input activity sampling failed."},
	"queue_failed":          {"error", "Local tracking queue operation failed."},
	"heartbeat_failed":      {"warn", "Tracking heartbeat failed."},
	"update_check_failed":   {"warn", "Update check failed."},
	"update_install_failed": {"error", "Update download or installation failed."},
	"sync_rejected":         {"error", "A record refused by the server for 24 hours was set aside on the device."},
}
var agentVersion = regexp.MustCompile(`^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}$`)

type agentEvent struct {
	ID         string    `json:"id"`
	OccurredAt time.Time `json:"occurred_at"`
	Code       string    `json:"code"`
	Status     *int      `json:"status,omitempty"`
}

func (a *app) ingestAgentLogs(w http.ResponseWriter, r *http.Request) {
	u := current(r)
	if u.kind != "device" {
		fail(w, 403, "device credential required")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	var in struct {
		Version string       `json:"version"`
		Events  []agentEvent `json:"events"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !agentVersion.MatchString(in.Version) || len(in.Events) < 1 || len(in.Events) > 20 {
		fail(w, 400, "stable numeric version and 1 to 20 events required")
		return
	}
	now := time.Now()
	for _, event := range in.Events {
		_, known := agentLogCodes[event.Code]
		if !validID(event.ID) || !known || event.OccurredAt.IsZero() || event.OccurredAt.Before(now.Add(-7*24*time.Hour)) || event.OccurredAt.After(now.Add(2*time.Minute)) || (event.Status != nil && (*event.Status < 100 || *event.Status > 599)) {
			fail(w, 400, "invalid diagnostic event")
			return
		}
	}
	if !a.limiter.allow("agentlogs:"+u.ID, 6) {
		w.Header().Set("Retry-After", "60")
		fail(w, 429, "diagnostic request limit reached")
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		fail(w, 503, "diagnostics unavailable")
		return
	}
	defer tx.Rollback(r.Context())
	// Serialize the per-user storage budget across requests and API processes.
	if _, err = tx.Exec(r.Context(), "SELECT id FROM users WHERE id=$1 FOR UPDATE", u.ID); err != nil {
		fail(w, 503, "diagnostics unavailable")
		return
	}
	for _, event := range in.Events {
		_, err = tx.Exec(r.Context(), `INSERT INTO agent_logs(user_id,id,occurred_at,version,code,status) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,id) DO NOTHING`, u.ID, event.ID, event.OccurredAt, in.Version, event.Code, event.Status)
		if err != nil {
			fail(w, 503, "could not store diagnostics")
			return
		}
	}
	var count int
	if err = tx.QueryRow(r.Context(), "SELECT count(*) FROM agent_logs WHERE user_id=$1 AND received_at>now()-interval '1 hour'", u.ID).Scan(&count); err != nil {
		fail(w, 503, "diagnostics unavailable")
		return
	}
	if count > 120 {
		w.Header().Set("Retry-After", "3600")
		fail(w, 429, "diagnostic storage limit reached (120 events per hour)")
		return
	}
	if tx.Commit(r.Context()) != nil {
		fail(w, 503, "could not store diagnostics")
		return
	}
	ok(w)
}

func (a *app) agentLogs(w http.ResponseWriter, r *http.Request) {
	if current(r).Role != "owner" {
		fail(w, 403, "owner access required")
		return
	}
	// shortcut: newest 100 diagnostics only, add pagination when older retained events are needed.
	rows, err := a.db.Query(r.Context(), `SELECT l.user_id::text,u.name,l.id::text,l.occurred_at,l.version,l.code,l.status FROM agent_logs l JOIN users u ON u.id=l.user_id WHERE l.occurred_at>now()-interval '7 days' ORDER BY l.occurred_at DESC,l.id DESC LIMIT 100`)
	if err != nil {
		fail(w, 503, "diagnostics unavailable")
		return
	}
	defer rows.Close()
	type entry struct {
		agentEvent
		UserID  string `json:"user_id"`
		Name    string `json:"name"`
		Version string `json:"version"`
		Level   string `json:"level"`
		Message string `json:"message"`
	}
	out := []entry{}
	for rows.Next() {
		var v entry
		if err = rows.Scan(&v.UserID, &v.Name, &v.ID, &v.OccurredAt, &v.Version, &v.Code, &v.Status); err != nil {
			fail(w, 503, "diagnostics unavailable")
			return
		}
		definition := agentLogCodes[v.Code]
		v.Level, v.Message = definition.level, definition.message
		out = append(out, v)
	}
	if rows.Err() != nil {
		fail(w, 503, "diagnostics unavailable")
		return
	}
	writeJSON(w, 200, out)
}

func (a *app) pruneAgentLogs(ctx context.Context) error {
	_, err := a.db.Exec(ctx, "DELETE FROM agent_logs WHERE occurred_at<now()-interval '7 days'")
	return err
}

func (a *app) cleanupAgentLogs(ctx context.Context) {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		attempt, cancel := context.WithTimeout(ctx, 10*time.Second)
		if err := a.pruneAgentLogs(attempt); err != nil && ctx.Err() == nil {
			slog.Error("diagnostic retention cleanup failed", "error", err)
		}
		cancel()
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
