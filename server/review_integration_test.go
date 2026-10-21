package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// A PUT may succeed just before the agent goes offline, before its block POST.
// The server must preserve that upload throughout the supported offline window.
func TestReviewOfflineUploadedBlockSurvivesCleanup(t *testing.T) {
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
	a := &app{db: db, origin: "http://localhost:5173", dev: true, authSlots: make(chan struct{}, 4)}
	if err = a.migrate(ctx); err != nil {
		t.Fatal(err)
	}
	uid, sid, bid := uuid.NewString(), uuid.NewString(), uuid.NewString()
	raw := token()
	started := time.Now().UTC().Truncate(time.Second).Add(-48 * time.Hour)
	key := uid + "/" + bid + ".jpg"
	_, err = db.Exec(ctx, "INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,'Offline review','worker','unused')", uid, uid+"@example.test")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		for _, table := range []string{"uploads", "blocks", "work_sessions", "credentials"} {
			_, _ = db.Exec(ctx, "DELETE FROM "+table+" WHERE user_id=$1", uid)
		}
		_, _ = db.Exec(ctx, "DELETE FROM users WHERE id=$1", uid)
	}()
	_, err = db.Exec(ctx, "INSERT INTO credentials(token_hash,user_id,kind,expires_at) VALUES($1,$2,'device',now()+interval '1 day')", digest(raw), uid)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(ctx, "INSERT INTO work_sessions(id,user_id,started_at) VALUES($1,$2,$3)", sid, uid, started)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(ctx, "INSERT INTO uploads(block_id,user_id,object_key,expires_at) VALUES($1,$2,$3,$4)", bid, uid, key, started.Add(6*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	var deleted atomic.Bool
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			t.Errorf("unexpected storage request: %s", r.Method)
		}
		deleted.Store(true)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer storage.Close()
	a.s3 = s3.New(s3.Options{Region: "eu-central", BaseEndpoint: aws.String(storage.URL), UsePathStyle: true, Credentials: credentials.NewStaticCredentialsProvider("test", "test", "")})
	a.bucket = "test"
	a.cleanUploadsOnce(ctx)
	if deleted.Load() {
		t.Error("cleanup deleted an uploaded screenshot still inside the seven-day offline acceptance window")
	}
	payload, err := json.Marshal(map[string]any{"blocks": []block{{ID: bid, SessionID: sid, Start: started, End: started.Add(30 * time.Second), Active: 10, Screenshot: key}}})
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/blocks", bytes.NewReader(payload))
	r.Header.Set("Authorization", "Bearer "+raw)
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("offline block must remain recoverable: got %d %s", w.Code, w.Body.String())
	}
	// Retaining recoverable uploads must not disable abandoned-object cleanup.
	expiredID := uuid.NewString()
	_, err = db.Exec(ctx, "INSERT INTO uploads(block_id,user_id,object_key,expires_at) VALUES($1,$2,$3,now()-interval '9 days')", expiredID, uid, uid+"/"+expiredID+".jpg")
	if err != nil {
		t.Fatal(err)
	}
	a.cleanUploadsOnce(ctx)
	if !deleted.Load() {
		t.Fatal("cleanup did not delete an abandoned screenshot beyond the offline grace period")
	}
	var remaining int
	if err = db.QueryRow(ctx, "SELECT count(*) FROM uploads WHERE block_id=$1", expiredID).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("expired reservation retained after successful deletion: count=%d error=%v", remaining, err)
	}
	if err = db.QueryRow(ctx, "SELECT count(*) FROM uploads WHERE block_id=$1", bid).Scan(&remaining); err != nil || remaining != 1 {
		t.Fatalf("finalized live screenshot reservation lost: count=%d error=%v", remaining, err)
	}
	payload, err = json.Marshal(map[string]any{"blocks": []block{{ID: expiredID, SessionID: sid, Start: started.Add(time.Minute), End: started.Add(90 * time.Second), Active: 10, Screenshot: uid + "/" + expiredID + ".jpg"}}})
	if err != nil {
		t.Fatal(err)
	}
	r = httptest.NewRequest(http.MethodPost, "/api/blocks", bytes.NewReader(payload))
	r.Header.Set("Authorization", "Bearer "+raw)
	w = httptest.NewRecorder()
	a.routes().ServeHTTP(w, r)
	var failure map[string]string
	if err = json.Unmarshal(w.Body.Bytes(), &failure); err != nil || w.Code != http.StatusBadRequest || failure["code"] != "upload_expired" {
		t.Fatalf("missing reservation must signal recoverable upload expiry: status=%d body=%s error=%v", w.Code, w.Body.String(), err)
	}
}
