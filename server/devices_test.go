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

// Exercises the managed-device control plane against real Postgres: enroll,
// idempotent event ingest with resume, config versioning, command delivery and
// the tamper-evident audit chain.
func TestDevicesHTTP(t *testing.T) {
	dsn := os.Getenv("WT_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set WT_TEST_DATABASE_URL to a disposable Postgres database")
	}
	ctx := context.Background()
	db, e := pgxpool.New(ctx, dsn)
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	a := &app{db: db, origin: "http://localhost:5173", dev: true, authSlots: make(chan struct{}, 4)}
	if e = a.migrate(ctx); e != nil {
		t.Fatal(e)
	}

	ownerID := uuid.NewString()
	ownerPw := token()
	upn := ownerID + "@example.test"
	if _, e = db.Exec(ctx, "INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,'Owner','owner',$3)", ownerID, upn, passwordHash(ownerPw)); e != nil {
		t.Fatal(e)
	}
	var deviceID string
	defer func() {
		if deviceID != "" {
			_, _ = db.Exec(ctx, "DELETE FROM device_events WHERE device_id=$1", deviceID)
			_, _ = db.Exec(ctx, "DELETE FROM admin_audit WHERE device_id=$1", deviceID)
			_, _ = db.Exec(ctx, "DELETE FROM devices WHERE id=$1", deviceID)
		}
		_, _ = db.Exec(ctx, "DELETE FROM admin_audit WHERE actor_id=$1", ownerID)
		_, _ = db.Exec(ctx, "DELETE FROM device_enrollments WHERE created_by=$1", ownerID)
		_, _ = db.Exec(ctx, "DELETE FROM users WHERE id=$1", ownerID)
	}()

	handler := a.routes()
	call := func(bearer, method, path string, body any, want int) map[string]any {
		t.Helper()
		data, _ := json.Marshal(body)
		r := httptest.NewRequest(method, path, strings.NewReader(string(data)))
		r.Header.Set("Origin", a.origin)
		if bearer != "" {
			r.Header.Set("Authorization", "Bearer "+bearer)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("%s %s: want %d got %d %s", method, path, want, w.Code, w.Body.String())
		}
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return out
	}

	ownerToken := call("", "POST", "/api/auth/login", map[string]any{"email": upn, "password": ownerPw, "device_name": "test"}, 200)["device_token"].(string)

	// Admin mints an enrollment secret.
	secret := call(ownerToken, "POST", "/api/devices/enrollments", map[string]any{}, 200)["secret"].(string)

	// A used or invalid secret is rejected; the valid one enrolls and maps UPN.
	call("", "POST", "/api/devices/enroll", map[string]any{"secret": "nope", "upn": upn}, 401)
	enrolled := call("", "POST", "/api/devices/enroll", map[string]any{"secret": secret, "upn": upn, "hostname": "LAPTOP-1"}, 200)
	deviceID = enrolled["device_id"].(string)
	deviceToken := enrolled["token"].(string)
	call("", "POST", "/api/devices/enroll", map[string]any{"secret": secret, "upn": upn}, 401) // one-time

	var mappedUser string
	if e = db.QueryRow(ctx, "SELECT user_id::text FROM devices WHERE id=$1", deviceID).Scan(&mappedUser); e != nil || mappedUser != ownerID {
		t.Fatalf("UPN not mapped: %s %v", mappedUser, e)
	}

	// Check-in reports health and receives desired state. config_version starts 1.
	ci := call(deviceToken, "POST", "/api/devices/checkin", map[string]any{"agent_version": "1.0.0", "buffer_depth": 3, "config_version": 1}, 200)
	if ci["enabled"] != true || ci["paused"] != false {
		t.Fatalf("unexpected desired state %+v", ci)
	}

	ev := func(seq int, kind string) map[string]any {
		return map[string]any{"seq": seq, "event_id": uuid.NewString(), "kind": kind, "occurred_at": time.Now().UTC().Format(time.RFC3339Nano)}
	}
	batch := []map[string]any{ev(1, "logon"), ev(2, "foreground"), ev(3, "idle")}
	acked := call(deviceToken, "POST", "/api/devices/events", map[string]any{"events": batch}, 200)
	if acked["acked_seq"].(float64) != 3 {
		t.Fatalf("acked_seq want 3 got %v", acked["acked_seq"])
	}
	// Replaying the same batch is idempotent: no duplicate rows, same high-water.
	call(deviceToken, "POST", "/api/devices/events", map[string]any{"events": batch}, 200)
	var count int
	if e = db.QueryRow(ctx, "SELECT count(*) FROM device_events WHERE device_id=$1", deviceID).Scan(&count); e != nil || count != 3 {
		t.Fatalf("duplicate suppression failed: %d %v", count, e)
	}
	// Resume from high-water mark with the next batch.
	acked = call(deviceToken, "POST", "/api/devices/events", map[string]any{"events": []map[string]any{ev(4, "logoff")}}, 200)
	if acked["acked_seq"].(float64) != 4 {
		t.Fatalf("resume acked_seq want 4 got %v", acked["acked_seq"])
	}

	// Admin changes config; version bumps and next check-in ships it.
	call(ownerToken, "PUT", "/api/devices/"+deviceID+"/config", map[string]any{"screenshots": true, "location": true}, 200)
	ci = call(deviceToken, "POST", "/api/devices/checkin", map[string]any{"agent_version": "1.0.0", "config_version": 1}, 200)
	if ci["config_version"].(float64) != 2 || ci["config"] == nil {
		t.Fatalf("stale config not delivered %+v", ci)
	}
	// Up-to-date agent gets no config body.
	ci = call(deviceToken, "POST", "/api/devices/checkin", map[string]any{"agent_version": "1.0.0", "config_version": 2}, 200)
	if ci["config"] != nil {
		t.Fatal("config resent to current agent")
	}

	// Pause command reaches the agent on next check-in.
	call(ownerToken, "POST", "/api/devices/"+deviceID+"/command", map[string]any{"command": "pause"}, 200)
	ci = call(deviceToken, "POST", "/api/devices/checkin", map[string]any{"agent_version": "1.0.0", "config_version": 2}, 200)
	if ci["paused"] != true {
		t.Fatal("pause command not delivered")
	}
	call(ownerToken, "POST", "/api/devices/"+deviceID+"/command", map[string]any{"command": "bogus"}, 400)

	// Uninstall is one-way and revokes the device token afterwards.
	call(ownerToken, "POST", "/api/devices/"+deviceID+"/command", map[string]any{"command": "uninstall"}, 200)
	call(deviceToken, "POST", "/api/devices/checkin", map[string]any{"agent_version": "1.0.0"}, 401)

	// Owner lists the fleet; a non-owner cannot.
	workerID := uuid.NewString()
	workerPw := token()
	if _, e = db.Exec(ctx, "INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,'W','worker',$3)", workerID, workerID+"@example.test", passwordHash(workerPw)); e != nil {
		t.Fatal(e)
	}
	defer db.Exec(ctx, "DELETE FROM users WHERE id=$1", workerID)
	workerToken := call("", "POST", "/api/auth/login", map[string]any{"email": workerID + "@example.test", "password": workerPw, "device_name": "t"}, 200)["device_token"].(string)
	call(workerToken, "GET", "/api/devices", nil, 403)

	// This owner produced 3 audit rows: config, pause, uninstall.
	var mine int
	if e = db.QueryRow(ctx, "SELECT count(*) FROM admin_audit WHERE actor_id=$1", ownerID).Scan(&mine); e != nil || mine != 3 {
		t.Fatalf("expected 3 audit rows, got %d %v", mine, e)
	}
	// The whole audit log is a contiguous hash chain: each prev_hash equals the
	// prior row's hash. Tamper with any row and the chain breaks here.
	rows, err := db.Query(ctx, "SELECT prev_hash,hash FROM admin_audit ORDER BY id")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	prev := ""
	for rows.Next() {
		var p, h string
		if err = rows.Scan(&p, &h); err != nil {
			t.Fatal(err)
		}
		if p != prev {
			t.Fatalf("audit chain broken: prev_hash=%s want=%s", p, prev)
		}
		prev = h
	}
}
