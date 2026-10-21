package main

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func monitoringBlock() block {
	end := time.Now().UTC().Truncate(time.Second).Add(-time.Minute)
	lat, lon, accuracy := 0.0, 0.0, 25.0
	observed := end.Add(time.Second)
	return block{ID: uuid.NewString(), SessionID: uuid.NewString(), Start: end.Add(-30 * time.Second), End: end, Active: 10, Location: &screenshotLocation{Status: "available", CapturedAt: end, Latitude: &lat, Longitude: &lon, Accuracy: &accuracy, ObservedAt: &observed}, Applications: []applicationUsage{{App: "chrome.exe", Milliseconds: 20000}, {App: "code.exe", Milliseconds: 10000}}}
}
func TestMonitoringValidation(t *testing.T) {
	uid := uuid.NewString()
	valid := monitoringBlock()
	valid.Screenshot = uid + "/" + valid.ID + ".jpg"
	if err := valid.validate(uid); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*block){
		func(b *block) { b.Screenshot = "" },
		func(b *block) { v := math.NaN(); b.Location.Latitude = &v },
		func(b *block) { v := 181.0; b.Location.Longitude = &v },
		func(b *block) { v := 0.0; b.Location.Accuracy = &v },
		func(b *block) { v := b.End.Add(-time.Hour); b.Location.ObservedAt = &v },
		func(b *block) { b.Location.CapturedAt = b.End.Add(time.Minute) },
		func(b *block) { b.Location.Status = "pending" },
		func(b *block) { b.Location.Status = "disabled" },
		func(b *block) { b.Applications[0].App = "C:\\private\\chrome.exe" },
		func(b *block) { b.Applications[0].App = "bad\nname" },
		func(b *block) { b.Applications[0].App = strings.Repeat("x", 257) },
		func(b *block) { b.Applications[1].App = "chrome.exe" },
		func(b *block) { b.Applications[0].Milliseconds = 30001 },
		func(b *block) { b.Applications[0].Milliseconds = -1 },
	} {
		b := monitoringBlock()
		b.Screenshot = uid + "/" + b.ID + ".jpg"
		change(&b)
		if b.validate(uid) == nil {
			t.Fatal("invalid monitoring payload accepted")
		}
	}
	for _, status := range []string{"disabled", "unavailable"} {
		b := monitoringBlock()
		b.Screenshot = uid + "/" + b.ID + ".jpg"
		b.Location = &screenshotLocation{Status: status, CapturedAt: b.End}
		if err := b.validate(uid); err != nil {
			t.Fatal(err)
		}
	}
}
func TestMonitoringHTTP(t *testing.T) {
	dsn := os.Getenv("WT_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set WT_TEST_DATABASE_URL to disposable Postgres")
	}
	ctx := context.Background()
	db, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	a := &app{db: db, origin: "http://localhost:5173", dev: true, authSlots: make(chan struct{}, 4)}
	if err = a.migrate(ctx); err != nil {
		t.Fatal(err)
	}
	ids, tokens := map[string]string{}, map[string]string{}
	for _, role := range []string{"worker", "other", "owner", "manager"} {
		ids[role] = uuid.NewString()
		tokens[role] = token()
		r := role
		if r == "other" {
			r = "worker"
		}
		if _, err = db.Exec(ctx, "INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,'Monitoring test',$3,'unused')", ids[role], ids[role]+"@example.test", r); err != nil {
			t.Fatal(err)
		}
		if _, err = db.Exec(ctx, "INSERT INTO credentials(token_hash,user_id,kind,expires_at) VALUES($1,$2,'device',now()+interval '1 hour')", digest(tokens[role]), ids[role]); err != nil {
			t.Fatal(err)
		}
	}
	defer func() {
		for _, id := range ids {
			for _, table := range []string{"uploads", "blocks", "work_sessions", "credentials"} {
				_, _ = db.Exec(ctx, "DELETE FROM "+table+" WHERE user_id=$1", id)
			}
			_, _ = db.Exec(ctx, "DELETE FROM users WHERE id=$1", id)
		}
	}()
	request := func(method, path, role string, body any, status int) *httptest.ResponseRecorder {
		data, _ := json.Marshal(body)
		r := httptest.NewRequest(method, path, bytes.NewReader(data))
		r.Header.Set("Authorization", "Bearer "+tokens[role])
		w := httptest.NewRecorder()
		a.routes().ServeHTTP(w, r)
		if w.Code != status {
			t.Fatalf("%s %s: got %d want %d: %s", method, path, w.Code, status, w.Body.String())
		}
		return w
	}
	b := monitoringBlock()
	b.Screenshot = ids["worker"] + "/" + b.ID + ".jpg"
	request("POST", "/api/sessions/start", "worker", map[string]any{"id": b.SessionID, "started_at": b.Start}, 200)
	if _, err = db.Exec(ctx, "INSERT INTO uploads(block_id,user_id,object_key,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes')", b.ID, ids["worker"], b.Screenshot); err != nil {
		t.Fatal(err)
	}
	payload := map[string]any{"blocks": []block{b}}
	request("POST", "/api/blocks", "worker", payload, 200)
	request("POST", "/api/blocks", "worker", payload, 200)
	bad := b
	bad.Applications = []applicationUsage{{App: "changed.exe", Milliseconds: 1000}}
	request("POST", "/api/blocks", "worker", map[string]any{"blocks": []block{bad}}, 409)
	path := "/api/timeline?user=" + ids["worker"] + "&date=" + b.Start.Format("2006-01-02")
	for _, role := range []string{"worker", "owner", "manager"} {
		var rows []struct {
			Location     *screenshotLocation `json:"location"`
			Applications []applicationUsage  `json:"application_usage"`
		}
		if err = json.Unmarshal(request("GET", path, role, nil, 200).Body.Bytes(), &rows); err != nil || len(rows) != 1 || rows[0].Location == nil || *rows[0].Location.Latitude != 0 || len(rows[0].Applications) != 2 {
			t.Fatalf("monitoring timeline lost: %v %v", rows, err)
		}
	}
	request("GET", path, "other", nil, 403)
	request("DELETE", "/api/blocks/"+b.ID+"/screenshot", "other", nil, 404)
	request("DELETE", "/api/blocks/"+b.ID+"/screenshot", "worker", nil, 200)
	request("POST", "/api/blocks", "worker", payload, 200)
	var erased bool
	if err = db.QueryRow(ctx, "SELECT location IS NULL AND jsonb_array_length(application_usage)=2 FROM blocks WHERE id=$1", b.ID).Scan(&erased); err != nil || !erased {
		t.Fatalf("screenshot deletion did not clear only location: %v", err)
	}
	request("DELETE", "/api/blocks/"+b.ID, "worker", nil, 200)
	request("POST", "/api/blocks", "worker", payload, 200)
	if err = db.QueryRow(ctx, "SELECT location IS NULL AND application_usage='[]'::jsonb FROM blocks WHERE id=$1", b.ID).Scan(&erased); err != nil || !erased {
		t.Fatalf("block deletion retained monitoring metadata: %v", err)
	}
}
