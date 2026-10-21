package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestClientIP(t *testing.T) {
	proxies, e := parseProxies("172.16.0.0/12, 10.0.0.1")
	if e != nil || len(proxies) != 2 {
		t.Fatal(proxies, e)
	}
	if _, e = parseProxies("not-an-ip"); e == nil {
		t.Fatal("invalid proxy accepted")
	}
	a := &app{proxies: proxies}
	for _, tc := range []struct{ peer, xff, want string }{
		{"203.0.113.9:1", "198.51.100.1", "203.0.113.9"},           // untrusted peer cannot spoof
		{"172.18.0.5:1", "198.51.100.1", "198.51.100.1"},           // Caddy forwards the client
		{"172.18.0.5:1", "6.6.6.6, 198.51.100.1", "198.51.100.1"},  // client-prepended entry ignored
		{"172.18.0.5:1", "198.51.100.1, 10.0.0.1", "198.51.100.1"}, // chain of trusted proxies
		{"172.18.0.5:1", "", "172.18.0.5"},                         // no header keeps peer
		{"172.18.0.5:1", "garbage", "172.18.0.5"},                  // malformed header keeps peer
	} {
		r := httptest.NewRequest("POST", "/api/auth/login", nil)
		r.RemoteAddr = tc.peer
		if tc.xff != "" {
			r.Header.Set("X-Forwarded-For", tc.xff)
		}
		if got := a.clientIP(r); got != tc.want {
			t.Errorf("%+v: got %s", tc, got)
		}
	}
}

func TestCanManage(t *testing.T) {
	owner := identity{user: user{ID: "o", Role: "owner"}}
	manager := identity{user: user{ID: "m", Role: "manager"}}
	worker := identity{user: user{ID: "w", Role: "worker"}}
	if canManage(owner, "o", "owner") || !canManage(owner, "m", "manager") || !canManage(owner, "w", "worker") {
		t.Fatal("owner rules")
	}
	if !canManage(manager, "w", "worker") || canManage(manager, "x", "manager") || canManage(manager, "o", "owner") {
		t.Fatal("manager rules")
	}
	if canManage(worker, "x", "worker") {
		t.Fatal("worker rules")
	}
}

func TestAccountsHTTP(t *testing.T) {
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
	// Re-running applies nothing twice and records each file once.
	if e = a.migrate(ctx); e != nil {
		t.Fatal(e)
	}
	var applied int
	if e = db.QueryRow(ctx, "SELECT count(*) FROM schema_migrations WHERE name IN ('001_init.sql','002_accounts.sql')").Scan(&applied); e != nil || applied != 2 {
		t.Fatalf("migrations recorded %d %v", applied, e)
	}
	ids := map[string]string{}
	passwords := map[string]string{}
	for _, role := range []string{"owner", "manager", "worker", "worker2"} {
		id := uuid.NewString()
		ids[role] = id
		passwords[role] = token()
		dbRole := strings.TrimSuffix(role, "2")
		if _, e = db.Exec(ctx, "INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)", id, id+"@example.test", role, dbRole, passwordHash(passwords[role])); e != nil {
			t.Fatal(e)
		}
	}
	defer func() {
		for _, id := range ids {
			for _, table := range []string{"password_resets", "blocks", "work_sessions", "credentials"} {
				_, _ = db.Exec(ctx, "DELETE FROM "+table+" WHERE user_id=$1", id)
			}
			_, _ = db.Exec(ctx, "DELETE FROM users WHERE id=$1", id)
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
	login := func(role, password string, want int) string {
		t.Helper()
		out := call("", "POST", "/api/auth/login", map[string]any{"email": ids[role] + "@example.test", "password": password, "device_name": "test"}, want)
		token, _ := out["device_token"].(string)
		return token
	}
	owner, manager, worker := login("owner", passwords["owner"], 200), login("manager", passwords["manager"], 200), login("worker", passwords["worker"], 200)

	// Role boundaries.
	call(worker, "POST", "/api/users/"+ids["worker2"]+"/disable", nil, 403)
	call(manager, "POST", "/api/users/"+ids["owner"]+"/disable", nil, 403)
	call(owner, "POST", "/api/users/"+ids["owner"]+"/disable", nil, 403)
	call(owner, "POST", "/api/users/"+uuid.NewString()+"/disable", nil, 404)
	call(owner, "POST", "/api/users/bad/disable", nil, 400)

	// Device revocation signs the worker out of the desktop.
	if out := call(manager, "POST", "/api/users/"+ids["worker"]+"/revoke-devices", nil, 200); out["revoked"] != float64(1) {
		t.Fatalf("revoked %v", out)
	}
	call(worker, "GET", "/api/auth/me", nil, 401)
	worker = login("worker", passwords["worker"], 200)

	// Disable closes the open session without adding time, then blocks all access.
	sid := uuid.NewString()
	call(worker, "POST", "/api/sessions/start", map[string]any{"id": sid}, 200)
	call(manager, "POST", "/api/users/"+ids["worker"]+"/disable", nil, 200)
	call(worker, "GET", "/api/auth/me", nil, 401)
	login("worker", passwords["worker"], 401)
	var stoppedEqualsStart bool
	if e = db.QueryRow(ctx, "SELECT stopped_at=started_at FROM work_sessions WHERE id=$1", sid).Scan(&stoppedEqualsStart); e != nil || !stoppedEqualsStart {
		t.Fatalf("disable must close empty session at its start: %v", e)
	}
	team := []map[string]any{}
	r := httptest.NewRequest("GET", "/api/team", nil)
	r.Header.Set("Authorization", "Bearer "+owner)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	_ = json.Unmarshal(w.Body.Bytes(), &team)
	found := false
	for _, member := range team {
		if member["id"] == ids["worker"] {
			found = member["disabled"] == true
		}
	}
	if !found {
		t.Fatal("team must report disabled worker")
	}
	// Reset links cannot revive a disabled account.
	reset := call(owner, "POST", "/api/users/"+ids["worker"]+"/password-reset", nil, 201)
	call("", "POST", "/api/auth/reset-password", map[string]any{"token": reset["token"], "password": "another-long-password"}, 400)
	call(owner, "POST", "/api/users/"+ids["worker"]+"/enable", nil, 200)
	worker = login("worker", passwords["worker"], 200)

	// Reset: only the newest link works, it is single use and revokes sessions.
	first := call(manager, "POST", "/api/users/"+ids["worker"]+"/password-reset", nil, 201)
	second := call(manager, "POST", "/api/users/"+ids["worker"]+"/password-reset", nil, 201)
	if !strings.Contains(second["url"].(string), "/reset?token=") {
		t.Fatal("reset URL")
	}
	call("", "POST", "/api/auth/reset-password", map[string]any{"token": first["token"], "password": "brand-new-password-1"}, 400)
	call("", "POST", "/api/auth/reset-password", map[string]any{"token": second["token"], "password": "short"}, 400)
	call("", "POST", "/api/auth/reset-password", map[string]any{"token": second["token"], "password": "brand-new-password-1"}, 200)
	call("", "POST", "/api/auth/reset-password", map[string]any{"token": second["token"], "password": "brand-new-password-2"}, 400)
	call(worker, "GET", "/api/auth/me", nil, 401)
	login("worker", passwords["worker"], 401)
	worker = login("worker", "brand-new-password-1", 200)
	other := login("worker", "brand-new-password-1", 200)

	// Self-service change keeps the current credential, revokes the others.
	call(worker, "POST", "/api/auth/password", map[string]any{"current_password": "wrong", "new_password": "brand-new-password-3"}, 403)
	call(worker, "POST", "/api/auth/password", map[string]any{"current_password": "brand-new-password-1", "new_password": "brand-new-password-3"}, 200)
	call(worker, "GET", "/api/auth/me", nil, 200)
	call(other, "GET", "/api/auth/me", nil, 401)
	login("worker", "brand-new-password-3", 200)
}
