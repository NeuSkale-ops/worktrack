package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestAgentLogsHTTP(t *testing.T) {
	dsn := os.Getenv("WT_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set WT_TEST_DATABASE_URL to a disposable Postgres database")
	}
	ctx := context.Background()
	db, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	a := &app{db: db, origin: "https://work.test"}
	if err = a.migrate(ctx); err != nil {
		t.Fatal(err)
	}
	ids, tokens := map[string]string{}, map[string]string{}
	defer func() {
		for _, id := range ids {
			for _, table := range []string{"agent_logs", "credentials"} {
				_, _ = db.Exec(ctx, "DELETE FROM "+table+" WHERE user_id=$1", id)
			}
			_, _ = db.Exec(ctx, "DELETE FROM users WHERE id=$1", id)
		}
	}()
	for _, role := range []string{"owner", "manager", "worker"} {
		id, raw := uuid.NewString(), token()
		ids[role], tokens[role] = id, raw
		if _, err = db.Exec(ctx, "INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,$3,$3,'unused')", id, id+"@example.test", role); err != nil {
			t.Fatal(err)
		}
		if _, err = db.Exec(ctx, "INSERT INTO credentials(token_hash,user_id,kind,expires_at) VALUES($1,$2,'device',now()+interval '1 day')", digest(raw), id); err != nil {
			t.Fatal(err)
		}
	}
	browser := token()
	if _, err = db.Exec(ctx, "INSERT INTO credentials(token_hash,user_id,kind,expires_at) VALUES($1,$2,'browser',now()+interval '1 day')", digest(browser), ids["worker"]); err != nil {
		t.Fatal(err)
	}
	request := func(method, raw, body string, want int) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, "/api/agent/logs", strings.NewReader(body))
		if raw == browser {
			r.Header.Set("Cookie", "worktrack_session="+raw)
			r.Header.Set("Origin", a.origin)
		} else if raw != "" {
			r.Header.Set("Authorization", "Bearer "+raw)
		}
		w := httptest.NewRecorder()
		a.routes().ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("%s: want %d got %d %s", method, want, w.Code, w.Body.String())
		}
		return w
	}
	payload := func(events []agentEvent) string {
		data, err := json.Marshal(map[string]any{"version": "0.1.2", "events": events})
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}
	batch := func(n int) []agentEvent {
		out := make([]agentEvent, n)
		status := 503
		for i := range out {
			out[i] = agentEvent{ID: uuid.NewString(), OccurredAt: time.Now().UTC().Truncate(time.Second), Code: "sync_failed", Status: &status}
		}
		return out
	}
	request("GET", "", "", 401)
	request("POST", browser, payload(batch(1)), 403)
	request("GET", tokens["worker"], "", 403)
	request("GET", tokens["manager"], "", 403)
	request("GET", tokens["owner"], "", 200)
	for _, body := range []string{
		payload(nil), payload(batch(21)),
		strings.Replace(payload(batch(1)), "0.1.2", "https://secret.invalid/token", 1),
		strings.Replace(payload(batch(1)), "sync_failed", "password=secret", 1),
		strings.Replace(payload(batch(1)), `"events":`, `"user_id":"`+ids["owner"]+`","events":`, 1),
		strings.Replace(payload(batch(1)), `"code":`, `"message":"Bearer secret","code":`, 1),
		payload(batch(1)) + strings.Repeat(" ", 16<<10),
	} {
		request("POST", tokens["worker"], body, 400)
	}
	for _, mutate := range []func(*agentEvent){
		func(e *agentEvent) { e.ID = "bad" },
		func(e *agentEvent) { e.OccurredAt = time.Now().Add(-8 * 24 * time.Hour) },
		func(e *agentEvent) { e.OccurredAt = time.Now().Add(3 * time.Minute) },
		func(e *agentEvent) { n := 99; e.Status = &n },
		func(e *agentEvent) { n := 600; e.Status = &n },
	} {
		events := batch(2)
		mutate(&events[1])
		request("POST", tokens["worker"], payload(events), 400)
	}
	first := payload(batch(20))
	for i := 0; i < 6; i++ {
		request("POST", tokens["worker"], first, 200)
	}
	request("POST", tokens["worker"], first, 429)
	var count int
	if err = db.QueryRow(ctx, "SELECT count(*) FROM agent_logs WHERE user_id=$1", ids["worker"]).Scan(&count); err != nil || count != 20 {
		t.Fatalf("retries must not duplicate logs: %d %v", count, err)
	}
	oldID := uuid.NewString()
	if _, err = db.Exec(ctx, "INSERT INTO agent_logs(user_id,id,occurred_at,version,code) VALUES($1,$2,now()-interval '8 days','0.1.2','capture_failed')", ids["owner"], oldID); err != nil {
		t.Fatal(err)
	}
	var logs []struct {
		UserID                        string `json:"user_id"`
		Code, Level, Message, Version string
		Status                        int
	}
	body := request("GET", tokens["owner"], "", 200).Body.Bytes()
	if err = json.Unmarshal(body, &logs); err != nil || len(logs) != 20 {
		t.Fatalf("owner read/retention filter: %d %v", len(logs), err)
	}
	for _, entry := range logs {
		if entry.UserID != ids["worker"] || entry.Code != "sync_failed" || entry.Level != "warn" || entry.Message != "Tracking data could not be synced." || entry.Version != "0.1.2" || entry.Status != 503 {
			t.Fatalf("unsafe or incomplete diagnostic: %+v", entry)
		}
	}
	if err = a.pruneAgentLogs(ctx); err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRow(ctx, "SELECT count(*) FROM agent_logs WHERE id=$1", oldID).Scan(&count); err != nil || count != 0 {
		t.Fatal("retention did not remove expired logs", err)
	}
	// The hourly budget survives limiter resets/API restarts, and rejects a whole batch.
	for i := 0; i < 5; i++ {
		a.limiter = loginLimiter{}
		request("POST", tokens["worker"], payload(batch(20)), 200)
	}
	a.limiter = loginLimiter{}
	request("POST", tokens["worker"], payload(batch(2)), 429)
	request("POST", tokens["worker"], first, 200)
	if err = db.QueryRow(ctx, "SELECT count(*) FROM agent_logs WHERE user_id=$1", ids["worker"]).Scan(&count); err != nil || count != 120 {
		t.Fatalf("hourly budget rollback/idempotency: %d %v", count, err)
	}
	var allCodes []agentEvent
	for code := range agentLogCodes {
		allCodes = append(allCodes, agentEvent{ID: uuid.NewString(), OccurredAt: time.Now().UTC(), Code: code})
	}
	request("POST", tokens["owner"], payload(allCodes), 200)
	if err = json.Unmarshal(request("GET", tokens["owner"], "", 200).Body.Bytes(), &logs); err != nil || len(logs) != 100 {
		t.Fatalf("owner list must be bounded: %d %v", len(logs), err)
	}
}
