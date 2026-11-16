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

// Two orgs, one manager and one worker each, plus an unassigned worker and an
// owner. Each manager must see only their own org across every people and
// device route, and get 404 for anything in the other org.
func TestOrgIsolationHTTP(t *testing.T) {
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

	type seed struct{ role, org string }
	people := map[string]seed{
		"owner": {"owner", ""}, "nsMgr": {"manager", "neuskale"}, "nsWorker": {"worker", "neuskale"},
		"qpMgr": {"manager", "quantipeak"}, "qpWorker": {"worker", "quantipeak"}, "loose": {"worker", ""},
	}
	ids, tokens, devices := map[string]string{}, map[string]string{}, map[string]string{}
	for name, p := range people {
		ids[name], tokens[name] = uuid.NewString(), token()
		var org any
		if p.org != "" {
			org = p.org
		}
		if _, e = db.Exec(ctx, "INSERT INTO users(id,email,name,role,password_hash,org_id) VALUES($1,$2,$3,$4,'unused',$5)", ids[name], ids[name]+"@example.test", name, p.role, org); e != nil {
			t.Fatal(e)
		}
		if _, e = db.Exec(ctx, "INSERT INTO credentials(token_hash,user_id,kind,expires_at) VALUES($1,$2,'device',now()+interval '1 hour')", digest(tokens[name]), ids[name]); e != nil {
			t.Fatal(e)
		}
		devices[name] = uuid.NewString()
		if _, e = db.Exec(ctx, "INSERT INTO devices(id,token_hash,user_id,upn) VALUES($1,$2,$3,$4)", devices[name], token(), ids[name], ids[name]+"@example.test"); e != nil {
			t.Fatal(e)
		}
		sid := uuid.NewString()
		start := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
		if _, e = db.Exec(ctx, "INSERT INTO work_sessions(id,user_id,started_at,stopped_at) VALUES($1,$2,$3,$4)", sid, ids[name], start, start.Add(time.Minute)); e != nil {
			t.Fatal(e)
		}
		if _, e = db.Exec(ctx, "INSERT INTO blocks(id,user_id,session_id,start_at,end_at,duration_seconds,active_seconds) VALUES($1,$2,$3,$4,$5,60,60)", uuid.NewString(), ids[name], sid, start, start.Add(time.Minute)); e != nil {
			t.Fatal(e)
		}
	}
	defer func() {
		for _, id := range ids {
			for _, q := range []string{
				"DELETE FROM admin_audit WHERE actor_id=$1",
				"DELETE FROM devices WHERE user_id=$1",
				"DELETE FROM blocks WHERE user_id=$1",
				"DELETE FROM work_sessions WHERE user_id=$1",
				"DELETE FROM credentials WHERE user_id=$1",
				"DELETE FROM password_resets WHERE user_id=$1",
				"DELETE FROM users WHERE id=$1",
			} {
				_, _ = db.Exec(ctx, q, id)
			}
		}
	}()

	handler := a.routes()
	call := func(who, method, path string, body any, want int) []byte {
		t.Helper()
		data, _ := json.Marshal(body)
		r := httptest.NewRequest(method, path, strings.NewReader(string(data)))
		r.Header.Set("Authorization", "Bearer "+tokens[who])
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("%s %s %s: want %d got %d %s", who, method, path, want, w.Code, w.Body.String())
		}
		return w.Body.Bytes()
	}
	// ids returned by a list route, restricted to our seeded users.
	seen := func(who, path, key string) map[string]bool {
		t.Helper()
		var rows []map[string]any
		if e := json.Unmarshal(call(who, "GET", path, nil, 200), &rows); e != nil {
			t.Fatal(e)
		}
		out := map[string]bool{}
		for _, row := range rows {
			v, _ := row[key].(string)
			for name, id := range ids {
				if v == id || v == devices[name] {
					out[name] = true
				}
			}
		}
		return out
	}
	expect := func(got map[string]bool, want ...string) {
		t.Helper()
		if len(got) != len(want) {
			t.Fatalf("saw %v, want exactly %v", got, want)
		}
		for _, w := range want {
			if !got[w] {
				t.Fatalf("saw %v, want exactly %v", got, want)
			}
		}
	}
	day := time.Now().UTC().Format("2006-01-02")
	q := "?date=" + day + "&tz=UTC&from=" + day + "&to=" + day

	expect(seen("nsMgr", "/api/team", "id"), "nsMgr", "nsWorker")
	expect(seen("qpMgr", "/api/team", "id"), "qpMgr", "qpWorker")
	expect(seen("nsWorker", "/api/team", "id"), "nsWorker")
	expect(seen("owner", "/api/team", "id"), "owner", "nsMgr", "nsWorker", "qpMgr", "qpWorker", "loose")
	expect(seen("owner", "/api/team?org=quantipeak", "id"), "owner", "qpMgr", "qpWorker")
	// A manager cannot widen their view with ?org=.
	expect(seen("nsMgr", "/api/team?org=quantipeak", "id"), "nsMgr")
	expect(seen("nsMgr", "/api/reports/day"+q, "user_id"), "nsMgr", "nsWorker")
	expect(seen("qpMgr", "/api/reports/hours"+q, "user_id"), "qpMgr", "qpWorker")
	expect(seen("nsMgr", "/api/devices", "id"), "nsMgr", "nsWorker")
	expect(seen("owner", "/api/devices", "id"), "owner", "nsMgr", "nsWorker", "qpMgr", "qpWorker", "loose")

	// Cross-org targets look missing.
	call("nsMgr", "GET", "/api/timeline"+q+"&user="+ids["qpWorker"], nil, 404)
	call("nsMgr", "GET", "/api/timeline"+q+"&user="+ids["nsWorker"], nil, 200)
	call("nsMgr", "POST", "/api/users/"+ids["qpWorker"]+"/password-reset", nil, 404)
	call("nsMgr", "POST", "/api/users/"+ids["loose"]+"/disable", nil, 404)
	call("nsMgr", "GET", "/api/devices/"+devices["qpWorker"]+"/activity"+q, nil, 404)
	call("nsMgr", "PUT", "/api/devices/"+devices["qpWorker"]+"/config", map[string]any{}, 404)
	call("nsMgr", "POST", "/api/devices/"+devices["qpWorker"]+"/command", map[string]any{"command": "pause"}, 404)
	call("nsMgr", "POST", "/api/devices/"+devices["nsWorker"]+"/command", map[string]any{"command": "pause"}, 200)
	call("nsWorker", "GET", "/api/devices", nil, 403)

	// Assignment is owner only and moves visibility with the user.
	call("nsMgr", "PUT", "/api/users/"+ids["loose"]+"/org", map[string]any{"org_id": "neuskale"}, 403)
	call("owner", "PUT", "/api/users/"+ids["loose"]+"/org", map[string]any{"org_id": "nope"}, 404)
	call("owner", "PUT", "/api/users/"+ids["owner"]+"/org", map[string]any{"org_id": "neuskale"}, 404)
	call("owner", "PUT", "/api/users/"+ids["loose"]+"/org", map[string]any{"org_id": "neuskale"}, 200)
	expect(seen("nsMgr", "/api/team", "id"), "nsMgr", "nsWorker", "loose")
	call("owner", "PUT", "/api/users/"+ids["loose"]+"/org", map[string]any{"org_id": nil}, 200)
	expect(seen("nsMgr", "/api/team", "id"), "nsMgr", "nsWorker")

	// Promotion is owner only, never touches the owner, and widens the view.
	call("nsMgr", "PUT", "/api/users/"+ids["nsWorker"]+"/role", map[string]any{"role": "manager"}, 403)
	call("owner", "PUT", "/api/users/"+ids["owner"]+"/role", map[string]any{"role": "manager"}, 404)
	call("owner", "PUT", "/api/users/"+ids["nsWorker"]+"/role", map[string]any{"role": "owner"}, 400)
	call("owner", "PUT", "/api/users/"+ids["nsWorker"]+"/role", map[string]any{"role": "manager"}, 200)
	expect(seen("nsWorker", "/api/team", "id"), "nsMgr", "nsWorker")
	call("owner", "PUT", "/api/users/"+ids["nsWorker"]+"/role", map[string]any{"role": "worker"}, 200)
	expect(seen("nsWorker", "/api/team", "id"), "nsWorker")

	var orgs []map[string]any
	_ = json.Unmarshal(call("qpMgr", "GET", "/api/orgs", nil, 200), &orgs)
	if len(orgs) != 1 || orgs[0]["id"] != "quantipeak" {
		t.Fatalf("manager orgs %v", orgs)
	}

	// Manager invites land in their own org whatever they ask for.
	call("qpMgr", "POST", "/api/invites", map[string]any{"email": "x" + ids["qpMgr"] + "@example.test", "org_id": "neuskale"}, 201)
	var org string
	if e = db.QueryRow(ctx, "SELECT org_id FROM invites WHERE email=$1", "x"+ids["qpMgr"]+"@example.test").Scan(&org); e != nil || org != "quantipeak" {
		t.Fatalf("invite org %q %v", org, e)
	}
	_, _ = db.Exec(ctx, "DELETE FROM invites WHERE email=$1", "x"+ids["qpMgr"]+"@example.test")
}
