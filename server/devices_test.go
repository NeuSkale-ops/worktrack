package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
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
	workerID := uuid.NewString()
	// Leftover users make the server skip owner bootstrap, so every row that
	// references these users must go before the users themselves.
	defer func() {
		for _, c := range []struct {
			q    string
			args []any
		}{
			{"DELETE FROM device_events WHERE device_id IN (SELECT id FROM devices WHERE upn=$1)", []any{upn}},
			{"DELETE FROM admin_audit WHERE actor_id=$1", []any{ownerID}},
			{"DELETE FROM devices WHERE upn=$1", []any{upn}},
			{"DELETE FROM device_enrollments WHERE created_by=$1", []any{ownerID}},
			{"DELETE FROM credentials WHERE user_id IN ($1,$2)", []any{ownerID, workerID}},
			{"DELETE FROM users WHERE id IN ($1,$2)", []any{ownerID, workerID}},
		} {
			if _, e := db.Exec(ctx, c.q, c.args...); e != nil {
				t.Errorf("cleanup %q: %v", c.q, e)
			}
		}
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

	// A used or invalid secret is rejected; the valid one enrolls unassigned.
	call("", "POST", "/api/devices/enroll", map[string]any{"secret": "nope", "upn": upn}, 401)
	enrolled := call("", "POST", "/api/devices/enroll", map[string]any{"secret": secret, "upn": upn, "hostname": "LAPTOP-1"}, 200)
	deviceID = enrolled["device_id"].(string)
	deviceToken := enrolled["token"].(string)
	// Intune hands the same secret to every laptop, so it enrolls a second
	// device, until the owner revokes it.
	call("", "POST", "/api/devices/enroll", map[string]any{"secret": secret, "upn": upn, "hostname": "LAPTOP-2"}, 200)
	if revoked := call(ownerToken, "POST", "/api/devices/enrollments/revoke", map[string]any{}, 200)["revoked"]; revoked.(float64) < 1 {
		t.Fatalf("revoked want >=1 got %v", revoked)
	}
	call("", "POST", "/api/devices/enroll", map[string]any{"secret": secret, "upn": upn}, 401)

	// Enrollment never links a laptop to a person, even when the UPN matches a
	// user's email. Assignment is an explicit owner or manager action.
	var unassigned bool
	if e = db.QueryRow(ctx, "SELECT user_id IS NULL FROM devices WHERE id=$1", deviceID).Scan(&unassigned); e != nil || !unassigned {
		t.Fatalf("enrollment assigned the laptop by email: unassigned=%v %v", unassigned, e)
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
	if acked = call(deviceToken, "POST", "/api/devices/events", map[string]any{"events": batch}, 200); acked["acked_seq"].(float64) != 3 {
		t.Fatalf("replay acked_seq want 3 got %v", acked["acked_seq"])
	}
	var count int
	if e = db.QueryRow(ctx, "SELECT count(*) FROM device_events WHERE device_id=$1", deviceID).Scan(&count); e != nil || count != 3 {
		t.Fatalf("duplicate suppression failed: %d %v", count, e)
	}
	// Resume from high-water mark with the next batch.
	acked = call(deviceToken, "POST", "/api/devices/events", map[string]any{"events": []map[string]any{ev(4, "logoff")}}, 200)
	if acked["acked_seq"].(float64) != 4 {
		t.Fatalf("resume acked_seq want 4 got %v", acked["acked_seq"])
	}

	// A recreated local buffer restarts seq at 1 with new event ids. Those are
	// new events: stored, and acked at the batch's own seq, not the old maximum.
	acked = call(deviceToken, "POST", "/api/devices/events", map[string]any{"events": []map[string]any{ev(1, "logon")}}, 200)
	if e = db.QueryRow(ctx, "SELECT count(*) FROM device_events WHERE device_id=$1", deviceID).Scan(&count); e != nil || count != 5 || acked["acked_seq"].(float64) != 1 {
		t.Fatalf("seq reset lost data: count=%d acked=%v %v", count, acked["acked_seq"], e)
	}

	// Screenshot: JPEG goes to object storage under a key derived from the
	// event, then the event references it. Only owners see it, signed.
	var stored []string
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "PUT" {
			t.Errorf("unexpected storage method %s", r.Method)
		}
		stored = append(stored, r.URL.Path)
		w.WriteHeader(200)
	}))
	defer storage.Close()
	a.s3 = s3.New(s3.Options{Region: "auto", BaseEndpoint: aws.String(storage.URL), UsePathStyle: true, Credentials: credentials.NewStaticCredentialsProvider("test", "test", "")})
	a.signer = s3.NewPresignClient(a.s3)
	a.bucket = "test"
	shot := func(eventID, ctype string, body []byte, want int) map[string]any {
		t.Helper()
		r := httptest.NewRequest("PUT", "/api/device-screenshots/"+eventID, strings.NewReader(string(body)))
		r.Header.Set("Authorization", "Bearer "+deviceToken)
		r.Header.Set("Content-Type", ctype)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("screenshot: want %d got %d %s", want, w.Code, w.Body.String())
		}
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return out
	}
	jpeg := []byte{0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3}
	shotID := uuid.NewString()
	shot(shotID, "image/png", jpeg, 400)
	shot(shotID, "image/jpeg", []byte("not a jpeg"), 400)
	shot("nope", "image/jpeg", jpeg, 400)
	key := shot(shotID, "image/jpeg", jpeg, 200)["screenshot_key"].(string)
	if key != "devices/"+deviceID+"/"+shotID+".jpg" || len(stored) != 1 || !strings.HasSuffix(stored[0], key) {
		t.Fatalf("screenshot key %q stored %v", key, stored)
	}
	shotEv := ev(2, "screenshot")
	shotEv["event_id"] = shotID
	shotEv["payload"] = map[string]any{"screenshot_key": key, "app": "code.exe"}
	// A forged key pointing elsewhere is stored but never signed.
	forged := ev(3, "screenshot")
	forged["payload"] = map[string]any{"screenshot_key": "other-user/secret.jpg"}
	call(deviceToken, "POST", "/api/devices/events", map[string]any{"events": []map[string]any{shotEv, forged}}, 200)
	activity := func(bearer string, want int) []map[string]any {
		t.Helper()
		r := httptest.NewRequest("GET", "/api/devices/"+deviceID+"/activity", nil)
		r.Header.Set("Authorization", "Bearer "+bearer)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("activity: want %d got %d %s", want, w.Code, w.Body.String())
		}
		var out []map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return out
	}
	signed, unsigned := 0, 0
	for _, e := range activity(ownerToken, 200) {
		if e["kind"] != "screenshot" {
			continue
		}
		if _, leaked := e["payload"].(map[string]any)["screenshot_key"]; leaked {
			t.Fatal("raw object key leaked to the dashboard")
		}
		if u, _ := e["screenshot_url"].(string); strings.Contains(u, key) {
			signed++
		} else {
			unsigned++
		}
	}
	if signed != 1 || unsigned != 1 {
		t.Fatalf("signed=%d unsigned=%d, want 1 each", signed, unsigned)
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

	// Uninstall is one-way. Check-in must still work so the agent learns it has
	// to remove itself; only further uploads are refused.
	call(ownerToken, "POST", "/api/devices/"+deviceID+"/command", map[string]any{"command": "uninstall"}, 200)
	if ci = call(deviceToken, "POST", "/api/devices/checkin", map[string]any{"agent_version": "1.0.0"}, 200); ci["uninstall"] != true {
		t.Fatal("uninstall command not delivered")
	}
	call(deviceToken, "POST", "/api/devices/events", map[string]any{"events": []map[string]any{ev(9, "idle")}}, 403)

	// Owner lists the fleet; a non-owner cannot.
	workerPw := token()
	if _, e = db.Exec(ctx, "INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,'W','worker',$3)", workerID, workerID+"@example.test", passwordHash(workerPw)); e != nil {
		t.Fatal(e)
	}
	workerToken := call("", "POST", "/api/auth/login", map[string]any{"email": workerID + "@example.test", "password": workerPw, "device_name": "t"}, 200)["device_token"].(string)
	call(workerToken, "GET", "/api/devices", nil, 403)
	activity(workerToken, 403)
	// After uninstall the device can no longer upload screenshots.
	shot(uuid.NewString(), "image/jpeg", jpeg, 403)

	// This owner produced 4 audit rows: revoke-enrollments, config, pause, uninstall.
	var mine int
	if e = db.QueryRow(ctx, "SELECT count(*) FROM admin_audit WHERE actor_id=$1", ownerID).Scan(&mine); e != nil || mine != 4 {
		t.Fatalf("expected 4 audit rows, got %d %v", mine, e)
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
