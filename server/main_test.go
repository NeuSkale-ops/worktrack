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

func TestPasswordAndToken(t *testing.T) {
	p := token()
	h := passwordHash(p)
	if !passwordOK(p, h) || passwordOK(p+"x", h) || passwordOK(p, "bad") {
		t.Fatal("password verification")
	}
	if len(digest(p)) != 64 || strings.Contains(h, p) {
		t.Fatal("unsafe hash")
	}
}
func TestSecurity(t *testing.T) {
	a := &app{origin: "https://work.test", dev: true}
	handler := a.security(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { ok(w) }))
	for _, tc := range []struct {
		method, origin, auth string
		want                 int
	}{{"POST", "", "", 403}, {"POST", "https://evil.test", "", 403}, {"POST", "https://work.test", "", 200}, {"POST", "http://localhost:5173", "", 200}, {"POST", "http://localhost.evil.test", "", 403}, {"POST", "", "Bearer abc", 200}, {"OPTIONS", "http://localhost:5173", "", 204}} {
		r := httptest.NewRequest(tc.method, "/api/heartbeat", nil)
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("Authorization", tc.auth)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Errorf("%+v got %d", tc, w.Code)
		}
	}
	a.dev = false
	if a.allowed("http://localhost:5173") {
		t.Fatal("production localhost CORS enabled")
	}
}
func TestValidationHTTP(t *testing.T) {
	a := &app{origin: "https://work.test", authSlots: make(chan struct{}, 4)}
	for _, tc := range []struct {
		path, body string
		want       int
	}{{"/api/auth/login", `{"email":"x","password":""}`, 400}, {"/api/auth/login", `{} {}`, 400}, {"/api/auth/login", `{"unknown":true}`, 400}, {"/api/auth/accept-invite", `{"name":"Test","password":"short","token":"x"}`, 400}} {
		r := httptest.NewRequest("POST", tc.path, strings.NewReader(tc.body))
		r.Header.Set("Origin", a.origin)
		w := httptest.NewRecorder()
		a.routes().ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Errorf("%s got %d", tc.path, w.Code)
		}
	}
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, httptest.NewRequest("GET", "/api/auth/me", nil))
	if w.Code != 401 {
		t.Fatal("missing auth accepted")
	}
	now := time.Now().UTC().Truncate(time.Second).Add(-time.Hour)
	b := block{ID: uuid.NewString(), SessionID: uuid.NewString(), Start: now, End: now.Add(30 * time.Second), Active: 20}
	if b.validate("user") != nil {
		t.Fatal("valid partial block rejected")
	}
	b.Active = 31
	if b.validate("user") == nil {
		t.Fatal("excess activity accepted")
	}
	b.Active = 20
	b.End = now.Add(601 * time.Second)
	if b.validate("user") == nil {
		t.Fatal("oversize block accepted")
	}
	b.End = now.Add(30 * time.Second)
	b.Screenshot = "other/key"
	if b.validate("user") == nil {
		t.Fatal("foreign screenshot accepted")
	}
}
func TestRateLimit(t *testing.T) {
	a := &app{}
	r := httptest.NewRequest("POST", "/", nil)
	for n := 0; n < 10; n++ {
		if !a.allowLogin(httptest.NewRecorder(), r, "TEST@example.test") {
			t.Fatal("early throttle")
		}
	}
	w := httptest.NewRecorder()
	if a.allowLogin(w, r, "test@example.test") || w.Code != 429 {
		t.Fatal("missing account throttle")
	}
}

// Run with WT_TEST_DATABASE_URL pointing only to a disposable Postgres database.
func TestPostgresHTTP(t *testing.T) {
	dsn := os.Getenv("WT_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set WT_TEST_DATABASE_URL for real Postgres HTTP coverage")
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
	uid := uuid.NewString()
	email := uid + "@example.test"
	password := token()
	_, e = db.Exec(ctx, "INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,'Test','worker',$3)", uid, email, passwordHash(password))
	if e != nil {
		t.Fatal(e)
	}
	defer func() {
		for _, table := range []string{"uploads", "blocks", "work_sessions", "credentials"} {
			_, _ = db.Exec(ctx, "DELETE FROM "+table+" WHERE user_id=$1", uid)
		}
		_, _ = db.Exec(ctx, "DELETE FROM users WHERE id=$1", uid)
	}()
	handler := a.routes()
	bearer := ""
	request := func(method, path string, body any, want int) map[string]any {
		t.Helper()
		data, _ := json.Marshal(body)
		r := httptest.NewRequest(method, path, strings.NewReader(string(data)))
		if bearer != "" {
			r.Header.Set("Authorization", "Bearer "+bearer)
		} else {
			r.Header.Set("Origin", a.origin)
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
	login := request("POST", "/api/auth/login", map[string]any{"email": email, "password": password, "device_name": "test"}, 200)
	bearer = login["device_token"].(string)
	// An auth lookup failure must not masquerade as successful prior revocation.
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	failedLogout := httptest.NewRequest("POST", "/api/auth/logout", strings.NewReader("{}")).WithContext(canceled)
	failedLogout.Header.Set("Authorization", "Bearer "+bearer)
	failedResponse := httptest.NewRecorder()
	handler.ServeHTTP(failedResponse, failedLogout)
	if failedResponse.Code != 503 {
		t.Fatalf("auth lookup failure: want 503 got %d", failedResponse.Code)
	}
	request("GET", "/api/auth/me", nil, 200)
	var stored string
	if e = db.QueryRow(ctx, "SELECT token_hash FROM credentials WHERE user_id=$1", uid).Scan(&stored); e != nil || stored == bearer || stored != digest(bearer) {
		t.Fatal("raw bearer persisted")
	}
	sid := uuid.NewString()
	now := time.Now().UTC().Truncate(time.Second).Add(-20 * time.Minute)
	start := map[string]any{"id": sid, "started_at": now}
	request("POST", "/api/sessions/start", start, 200)
	request("POST", "/api/sessions/start", start, 200)
	b := block{ID: uuid.NewString(), SessionID: sid, Start: now, End: now.Add(30 * time.Second), Active: 20}
	body := map[string]any{"blocks": []block{b}}
	request("POST", "/api/blocks", body, 200)
	request("POST", "/api/blocks", body, 200)
	b.Active = 21
	request("POST", "/api/blocks", map[string]any{"blocks": []block{b}}, 409)
	request("POST", "/api/sessions/stop", map[string]any{"id": sid, "stopped_at": now.Add(29 * time.Second)}, 409)
	request("POST", "/api/sessions/stop", map[string]any{"id": sid, "stopped_at": now.Add(30 * time.Second)}, 200)
	request("GET", "/api/timeline?user="+uuid.NewString(), nil, 404)
	request("POST", "/api/invites", map[string]string{"email": "new@example.test", "role": "worker"}, 403)
	// Real AWS presigner with a local S3-compatible delete endpoint, no live secrets.
	failDelete := true
	deleted := 0
	missingKey := "never-matches"
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "HEAD" {
			if strings.Contains(r.URL.Path, missingKey) {
				w.WriteHeader(404)
			}
			return
		}
		if r.Method != "DELETE" {
			t.Errorf("unexpected storage method %s", r.Method)
		}
		if failDelete {
			w.WriteHeader(503)
			return
		}
		deleted++
		w.WriteHeader(204)
	}))
	defer storage.Close()
	a.s3 = s3.New(s3.Options{Region: "eu-central", BaseEndpoint: aws.String(storage.URL), UsePathStyle: true, Credentials: credentials.NewStaticCredentialsProvider("test", "test", "")})
	a.signer = s3.NewPresignClient(a.s3)
	a.bucket = "test"
	bid := uuid.NewString()
	signed := request("POST", "/api/uploads/screenshot-url", map[string]any{"block_id": bid, "content_type": "image/jpeg", "size_bytes": 123}, 200)
	if !strings.Contains(signed["upload_url"].(string), "content-length") {
		t.Fatal("upload size not signed")
	}
	// Insert a screenshot-bearing block after stop, inside the stopped interval.
	_, e = db.Exec(ctx, "DELETE FROM blocks WHERE id=$1", b.ID)
	if e != nil {
		t.Fatal(e)
	}
	b.ID = bid
	b.Active = 20
	b.Screenshot = signed["object_key"].(string)
	// A reservation without an uploaded object must make the agent re-upload.
	missingKey = bid
	if out := request("POST", "/api/blocks", map[string]any{"blocks": []block{b}}, 400); out["code"] != "upload_expired" {
		t.Fatalf("missing object accepted: %v", out)
	}
	missingKey = "never-matches"
	request("POST", "/api/blocks", map[string]any{"blocks": []block{b}}, 200)
	request("DELETE", "/api/blocks/"+bid+"/screenshot", nil, 503)
	var seconds int
	if e = db.QueryRow(ctx, "SELECT duration_seconds FROM blocks WHERE id=$1 AND deleted_at IS NULL AND screenshot_deleted_at IS NOT NULL", bid).Scan(&seconds); e != nil || seconds != 30 {
		t.Fatal("screenshot deletion changed time")
	}
	_, _ = db.Exec(ctx, "UPDATE uploads SET expires_at=now()-interval '1 minute' WHERE block_id=$1", bid)
	failDelete = false
	a.cleanUploadsOnce(ctx)
	if deleted == 0 {
		t.Fatal("queued object deletion not retried")
	}
	var count int
	_ = db.QueryRow(ctx, "SELECT count(*) FROM uploads WHERE block_id=$1", bid).Scan(&count)
	if count != 0 {
		t.Fatal("cleanup reservation not removed")
	}
	request("DELETE", "/api/blocks/"+bid, nil, 200)
	if request("GET", "/api/sessions/current", nil, 200) != nil {
		t.Fatal("closed session must not be offered for recovery")
	}
	recoveryID := uuid.NewString()
	recoveryStart := time.Now().UTC().Truncate(time.Second).Add(-5 * time.Minute)
	request("POST", "/api/sessions/start", map[string]any{"id": recoveryID, "started_at": recoveryStart}, 200)
	open := request("GET", "/api/sessions/current", nil, 200)
	if open["id"] != recoveryID || open["recoverable"] != false {
		t.Fatal("fresh session must not be recoverable")
	}
	request("POST", "/api/sessions/recover", map[string]string{"id": recoveryID}, 409)
	request("POST", "/api/sessions/recover", map[string]string{"id": "invalid"}, 400)
	recoveryBlock := block{ID: uuid.NewString(), SessionID: recoveryID, Start: recoveryStart, End: recoveryStart.Add(30 * time.Second), Active: 15}
	request("POST", "/api/blocks", map[string]any{"blocks": []block{recoveryBlock}}, 200)
	request("DELETE", "/api/blocks/"+recoveryBlock.ID, nil, 200)
	if _, e = db.Exec(ctx, "UPDATE users SET last_seen_at=now()-interval '3 minutes' WHERE id=$1", uid); e != nil {
		t.Fatal(e)
	}
	if request("GET", "/api/sessions/current", nil, 200)["recoverable"] != true {
		t.Fatal("stale session must be recoverable")
	}
	otherUser, otherSession := uuid.NewString(), uuid.NewString()
	if _, e = db.Exec(ctx, "INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,'Other','worker','unused')", otherUser, otherUser+"@example.test"); e != nil {
		t.Fatal(e)
	}
	defer func() {
		_, _ = db.Exec(ctx, "DELETE FROM work_sessions WHERE user_id=$1", otherUser)
		_, _ = db.Exec(ctx, "DELETE FROM users WHERE id=$1", otherUser)
	}()
	if _, e = db.Exec(ctx, "INSERT INTO work_sessions(id,user_id,started_at) VALUES($1,$2,$3)", otherSession, otherUser, recoveryStart); e != nil {
		t.Fatal(e)
	}
	request("POST", "/api/sessions/recover", map[string]string{"id": otherSession}, 409)
	request("POST", "/api/sessions/recover", map[string]string{"id": sid}, 409)
	request("POST", "/api/sessions/recover", map[string]string{"id": recoveryID}, 200)
	var recoveredAt time.Time
	if e = db.QueryRow(ctx, "SELECT stopped_at FROM work_sessions WHERE id=$1", recoveryID).Scan(&recoveredAt); e != nil || !recoveredAt.Equal(recoveryBlock.End) {
		t.Fatalf("recovery must preserve all block bounds without adding time: %v %v", recoveredAt, e)
	}
	// A stale recovery request must not close a newer session.
	nextID := uuid.NewString()
	request("POST", "/api/sessions/start", map[string]string{"id": nextID}, 200)
	if _, e = db.Exec(ctx, "UPDATE users SET last_seen_at=now()-interval '3 minutes' WHERE id=$1", uid); e != nil {
		t.Fatal(e)
	}
	request("POST", "/api/sessions/recover", map[string]string{"id": recoveryID}, 409)
	if request("GET", "/api/sessions/current", nil, 200)["id"] != nextID {
		t.Fatal("recovery affected another session")
	}
	// Empty sessions remain recoverable after the ordinary seven-day upload window.
	oldStart := time.Now().UTC().Truncate(time.Second).Add(-8 * 24 * time.Hour)
	if _, e = db.Exec(ctx, "UPDATE work_sessions SET started_at=$2 WHERE id=$1", nextID, oldStart); e != nil {
		t.Fatal(e)
	}
	request("POST", "/api/sessions/recover", map[string]string{"id": nextID}, 200)
	if e = db.QueryRow(ctx, "SELECT stopped_at FROM work_sessions WHERE id=$1", nextID).Scan(&recoveredAt); e != nil || !recoveredAt.Equal(oldStart) {
		t.Fatalf("empty session must close at its start: %v %v", recoveredAt, e)
	}
	request("POST", "/api/auth/logout", map[string]any{}, 200)
	request("GET", "/api/auth/me", nil, 401)
}
