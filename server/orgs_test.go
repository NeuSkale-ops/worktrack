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
		if _, e = db.Exec(ctx, "INSERT INTO devices(id,token_hash,user_id,upn,org_id) VALUES($1,$2,$3,$4,$5)", devices[name], token(), ids[name], ids[name]+"@example.test", org); e != nil {
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
	// Leftover users make the server skip owner bootstrap and break later
	// tests. Audit rows reference devices of other users, so remove all of
	// them before any device (map order is random).
	defer func() {
		for _, id := range ids {
			_, _ = db.Exec(ctx, "DELETE FROM admin_audit WHERE actor_id=$1", id)
		}
		// By device id: reassignment changes or clears devices.user_id.
		for _, id := range devices {
			_, _ = db.Exec(ctx, "DELETE FROM device_events WHERE device_id=$1", id)
			_, _ = db.Exec(ctx, "DELETE FROM devices WHERE id=$1", id)
		}
		for _, id := range ids {
			for _, q := range []string{
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

	// Laptop activity is reported under the assigned person as merged runs.
	at := time.Now().UTC().Truncate(time.Second)
	for i, payload := range []map[string]any{{"active_secs": 30}, {"active_secs": 30}, {"active_secs": 30}, {"active_secs": "junk"}} {
		if _, e = db.Exec(ctx, "INSERT INTO device_events(device_id,seq,event_id,kind,occurred_at,payload) VALUES($1,$2,$3,'activity',$4,$5)", devices["nsWorker"], i+1, uuid.NewString(), at.Add(time.Duration(i-4)*time.Minute), payload); e != nil {
			t.Fatal(e)
		}
	}
	laptopSpans := func(who string) []map[string]any {
		t.Helper()
		var rows, mine []map[string]any
		if e := json.Unmarshal(call(who, "GET", "/api/reports/device-day"+q, nil, 200), &rows); e != nil {
			t.Fatal(e)
		}
		for _, row := range rows {
			if row["device_id"] == devices["nsWorker"] {
				mine = append(mine, row)
			}
		}
		return mine
	}
	if spans := laptopSpans("nsMgr"); len(spans) != 1 || spans[0]["active_seconds"].(float64) != 90 {
		t.Fatalf("laptop spans %v, want one merged run of 90 active seconds", spans)
	}
	if spans := laptopSpans("qpMgr"); len(spans) != 0 {
		t.Fatalf("other org saw laptop spans %v", spans)
	}
	call("nsWorker", "GET", "/api/reports/device-day"+q, nil, 403)

	// Owners and managers assign laptops. Managers stay inside their org.
	assign := "/api/devices/" + devices["nsWorker"] + "/user"
	call("nsWorker", "PUT", assign, map[string]any{"user_id": ids["nsWorker"]}, 403)
	call("nsMgr", "PUT", assign, map[string]any{"user_id": ids["qpWorker"]}, 404)
	call("nsMgr", "PUT", assign, map[string]any{"user_id": ids["loose"]}, 404)
	call("nsMgr", "PUT", "/api/devices/"+devices["qpWorker"]+"/user", map[string]any{"user_id": ids["nsWorker"]}, 404)
	call("nsMgr", "PUT", assign, map[string]any{"user_id": nil}, 403)
	call("owner", "PUT", assign, map[string]any{"user_id": "nope"}, 400)
	call("owner", "PUT", assign, map[string]any{"user_id": uuid.NewString()}, 404)
	// Saving the current person changes nothing, so history stays visible.
	call("nsMgr", "PUT", assign, map[string]any{"user_id": ids["nsWorker"]}, 200)
	if spans := laptopSpans("nsMgr"); len(spans) != 1 {
		t.Fatalf("no-op assignment hid history: %v", spans)
	}
	call("nsMgr", "PUT", assign, map[string]any{"user_id": ids["nsMgr"]}, 200)
	var assignee string
	var audited int
	if e = db.QueryRow(ctx, "SELECT user_id::text,(SELECT count(*) FROM admin_audit WHERE device_id=$1 AND action='assign') FROM devices WHERE id=$1", devices["nsWorker"]).Scan(&assignee, &audited); e != nil || assignee != ids["nsMgr"] || audited != 1 {
		t.Fatalf("assignee %q audited %d %v", assignee, audited, e)
	}
	// Earlier activity does not follow the laptop to its new person.
	if spans := laptopSpans("owner"); len(spans) != 0 {
		t.Fatalf("history moved to the new assignee: %v", spans)
	}
	events := func(who string) int {
		t.Helper()
		var rows []map[string]any
		if e := json.Unmarshal(call(who, "GET", "/api/devices/"+devices["nsWorker"]+"/activity"+q, nil, 200), &rows); e != nil {
			t.Fatal(e)
		}
		return len(rows)
	}
	if events("owner") != 4 || events("nsMgr") != 0 {
		t.Fatalf("owner saw %d events, manager %d, want 4 and 0", events("owner"), events("nsMgr"))
	}
	// An unassigned laptop stays in its organisation, so its manager still sees it.
	call("owner", "PUT", assign, map[string]any{"user_id": nil}, 200)
	expect(seen("nsMgr", "/api/devices", "id"), "nsMgr", "nsWorker")
	// Only owners set a laptop's organisation. With none, only owners see it.
	laptopOrg := "/api/devices/" + devices["nsWorker"] + "/org"
	call("nsMgr", "PUT", laptopOrg, map[string]any{"org_id": "quantipeak"}, 403)
	call("owner", "PUT", laptopOrg, map[string]any{"org_id": "nope"}, 404)
	call("owner", "PUT", "/api/devices/"+uuid.NewString()+"/org", map[string]any{"org_id": "neuskale"}, 404)
	call("owner", "PUT", laptopOrg, map[string]any{"org_id": nil}, 200)
	expect(seen("nsMgr", "/api/devices", "id"), "nsMgr")
	call("nsMgr", "PUT", assign, map[string]any{"user_id": ids["nsWorker"]}, 404)
	// Assigning a person gives a laptop with no organisation that person's organisation.
	call("owner", "PUT", assign, map[string]any{"user_id": ids["nsWorker"]}, 200)
	expect(seen("nsMgr", "/api/devices", "id"), "nsMgr", "nsWorker")
	// A person from another organisation is refused until the laptop moves.
	call("owner", "PUT", assign, map[string]any{"user_id": ids["qpWorker"]}, 409)
	// A person with no organisation is refused too.
	call("owner", "PUT", assign, map[string]any{"user_id": ids["loose"]}, 409)
	// A person who moves to another organisation leaves the laptop behind, unassigned.
	call("owner", "PUT", "/api/users/"+ids["nsWorker"]+"/org", map[string]any{"org_id": "quantipeak"}, 200)
	var left bool
	if e = db.QueryRow(ctx, "SELECT user_id IS NULL AND org_id='neuskale' FROM devices WHERE id=$1", devices["nsWorker"]).Scan(&left); e != nil || !left {
		t.Fatalf("laptop followed a person out of its organisation: %v %v", left, e)
	}
	call("owner", "PUT", "/api/users/"+ids["nsWorker"]+"/org", map[string]any{"org_id": "neuskale"}, 200)
	call("owner", "PUT", assign, map[string]any{"user_id": ids["nsWorker"]}, 200)
	// Moving the laptop unassigns a person who is not in the new organisation.
	// The new manager sees the laptop but not its earlier activity.
	call("owner", "PUT", laptopOrg, map[string]any{"org_id": "quantipeak"}, 200)
	expect(seen("nsMgr", "/api/devices", "id"), "nsMgr")
	expect(seen("qpMgr", "/api/devices", "id"), "qpMgr", "qpWorker", "nsWorker")
	var unassigned bool
	if e = db.QueryRow(ctx, "SELECT user_id IS NULL FROM devices WHERE id=$1", devices["nsWorker"]).Scan(&unassigned); e != nil || !unassigned {
		t.Fatalf("moving organisation kept a person from the old one: %v %v", unassigned, e)
	}
	if events("owner") != 4 || events("qpMgr") != 0 {
		t.Fatalf("owner saw %d events, new manager %d, want 4 and 0", events("owner"), events("qpMgr"))
	}
	call("qpMgr", "PUT", assign, map[string]any{"user_id": ids["qpWorker"]}, 200)
	call("owner", "PUT", laptopOrg, map[string]any{"org_id": "neuskale"}, 200)
	call("owner", "PUT", assign, map[string]any{"user_id": ids["nsWorker"]}, 200)
	expect(seen("nsMgr", "/api/devices", "id"), "nsMgr", "nsWorker")
	expect(seen("qpMgr", "/api/devices", "id"), "qpMgr", "qpWorker")

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
