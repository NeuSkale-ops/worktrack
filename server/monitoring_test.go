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

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
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
func TestMonitoringProvenance(t *testing.T) {
	for _, source := range []string{"cellular", "satellite", "wifi", "ip_address", "default", "obfuscated", "unknown", "", "gps", "WiFi"} {
		b := monitoringBlock()
		b.Screenshot = "capture.jpg"
		b.Location.PositionSource = &source
		err := b.validateMonitoring()
		if (err == nil) != (source != "" && source != "gps" && source != "WiFi") {
			t.Fatalf("source %q: %v", source, err)
		}
	}
	for _, raw := range []string{`{}`, `{"position_source":null,"is_remote_source":null}`, `{"is_remote_source":false}`, `{"position_source":"unknown","is_remote_source":true}`} {
		b := monitoringBlock()
		b.Screenshot = "capture.jpg"
		if err := json.Unmarshal([]byte(raw), b.Location); err != nil {
			t.Fatal(err)
		}
		if err := b.validateMonitoring(); err != nil {
			t.Fatalf("legacy/nullable payload %s: %v", raw, err)
		}
		encoded, err := json.Marshal(b.Location)
		if err != nil {
			t.Fatal(err)
		}
		var roundtrip screenshotLocation
		if err := json.Unmarshal(encoded, &roundtrip); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(raw, `false`) && (roundtrip.IsRemoteSource == nil || *roundtrip.IsRemoteSource) {
			t.Fatal("explicit false lost")
		}
		if raw == `{}` && (roundtrip.PositionSource != nil || roundtrip.IsRemoteSource != nil) {
			t.Fatal("invented legacy provenance")
		}
	}
	for _, status := range []string{"disabled", "unavailable"} {
		for _, raw := range []string{`{"position_source":"unknown"}`, `{"is_remote_source":false}`, `{"is_remote_source":true}`} {
			b := monitoringBlock()
			b.Screenshot = "capture.jpg"
			b.Location = &screenshotLocation{Status: status, CapturedAt: b.End}
			if err := json.Unmarshal([]byte(raw), b.Location); err != nil {
				t.Fatal(err)
			}
			if b.validateMonitoring() == nil {
				t.Fatalf("accepted %s provenance %s", status, raw)
			}
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
		if _, err = db.Exec(ctx, "INSERT INTO users(id,email,name,role,password_hash,org_id) VALUES($1,$2,'Monitoring test',$3,'unused',CASE WHEN $3='owner' THEN NULL ELSE 'neuskale' END)", ids[role], ids[role]+"@example.test", r); err != nil {
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
	source, remote := "wifi", false
	b.Location.PositionSource = &source
	b.Location.IsRemoteSource = &remote
	b.Screenshot = ids["worker"] + "/" + b.ID + ".jpg"
	request("POST", "/api/sessions/start", "worker", map[string]any{"id": b.SessionID, "started_at": b.Start}, 200)
	if _, err = db.Exec(ctx, "INSERT INTO uploads(block_id,user_id,object_key,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes')", b.ID, ids["worker"], b.Screenshot); err != nil {
		t.Fatal(err)
	}
	payload := map[string]any{"blocks": []block{b}}
	request("POST", "/api/blocks", "worker", payload, 200)
	request("POST", "/api/blocks", "worker", payload, 200)
	var storedProvenance bool
	if err = db.QueryRow(ctx, `SELECT count(*) = 1 AND bool_and(location->'position_source' = '"wifi"'::jsonb AND location->'is_remote_source' = 'false'::jsonb) FROM blocks WHERE id=$1`, b.ID).Scan(&storedProvenance); err != nil || !storedProvenance {
		t.Fatalf("duplicate upload did not preserve one block with exact provenance: %v", err)
	}
	bad := b
	bad.Applications = []applicationUsage{{App: "changed.exe", Milliseconds: 1000}}
	request("POST", "/api/blocks", "worker", map[string]any{"blocks": []block{bad}}, 409)
	path := "/api/timeline?user=" + ids["worker"] + "&date=" + b.Start.Format("2006-01-02")
	for _, role := range []string{"worker", "owner", "manager"} {
		var rows []struct {
			Location         *screenshotLocation `json:"location"`
			Applications     []applicationUsage  `json:"application_usage"`
			ScreenshotStatus string              `json:"screenshot_status"`
		}
		if err = json.Unmarshal(request("GET", path, role, nil, 200).Body.Bytes(), &rows); err != nil || len(rows) != 1 || rows[0].Location == nil || *rows[0].Location.Latitude != 0 || len(rows[0].Applications) != 2 || rows[0].ScreenshotStatus != "unavailable" {
			t.Fatalf("monitoring timeline lost: %v %v", rows, err)
		}
		location := rows[0].Location
		if location.PositionSource == nil || *location.PositionSource != source || location.IsRemoteSource == nil || *location.IsRemoteSource != remote {
			t.Fatalf("%s timeline lost exact provenance including explicit false: %+v", role, location)
		}
	}
	request("GET", path, "other", nil, 404)
	a.signer = s3.NewPresignClient(s3.New(s3.Options{Region: "auto", BaseEndpoint: aws.String("https://storage.invalid"), UsePathStyle: true, Credentials: credentials.NewStaticCredentialsProvider("fixture", "fixture", "")}))
	a.bucket = "fixture"
	var screenshots []struct {
		Status string `json:"screenshot_status"`
		URL    string `json:"screenshot_url"`
	}
	if err = json.Unmarshal(request("GET", path, "worker", nil, 200).Body.Bytes(), &screenshots); err != nil || len(screenshots) != 1 || screenshots[0].Status != "available" || screenshots[0].URL == "" {
		t.Fatalf("available screenshot state lost: %v %v", screenshots, err)
	}
	request("DELETE", "/api/blocks/"+b.ID+"/screenshot", "other", nil, 404)
	request("DELETE", "/api/blocks/"+b.ID+"/screenshot", "worker", nil, 200)
	request("POST", "/api/blocks", "worker", payload, 200)
	if err = json.Unmarshal(request("GET", path, "worker", nil, 200).Body.Bytes(), &screenshots); err != nil || len(screenshots) != 1 || screenshots[0].Status != "deleted" || screenshots[0].URL != "" {
		t.Fatalf("deleted screenshot state lost: %v %v", screenshots, err)
	}
	var erased bool
	if err = db.QueryRow(ctx, "SELECT location IS NULL AND jsonb_array_length(application_usage)=2 FROM blocks WHERE id=$1", b.ID).Scan(&erased); err != nil || !erased {
		t.Fatalf("screenshot deletion did not clear only location: %v", err)
	}
	request("DELETE", "/api/blocks/"+b.ID, "worker", nil, 200)
	request("POST", "/api/blocks", "worker", payload, 200)
	if err = db.QueryRow(ctx, "SELECT location IS NULL AND application_usage='[]'::jsonb FROM blocks WHERE id=$1", b.ID).Scan(&erased); err != nil || !erased {
		t.Fatalf("block deletion retained monitoring metadata: %v", err)
	}
	b.ID = uuid.NewString()
	b.Start = b.End
	b.End = b.End.Add(30 * time.Second)
	path = "/api/timeline?user=" + ids["worker"] + "&date=" + b.Start.Format("2006-01-02")
	b.Screenshot = ""
	b.Location = nil
	request("POST", "/api/blocks", "worker", map[string]any{"blocks": []block{b}}, 200)
	if err = json.Unmarshal(request("GET", path, "worker", nil, 200).Body.Bytes(), &screenshots); err != nil || len(screenshots) != 1 || screenshots[0].Status != "not_captured" || screenshots[0].URL != "" {
		t.Fatalf("time-only block mislabeled as unavailable screenshot: %v %v", screenshots, err)
	}
}
