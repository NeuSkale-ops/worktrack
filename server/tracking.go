package main

import (
	"fmt"
	"net/http"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/google/uuid"
)

func validID(s string) bool { _, e := uuid.Parse(s); return e == nil }
func validTime(t time.Time) bool {
	return !t.IsZero() && t.Nanosecond() == 0 && t.After(time.Now().Add(-7*24*time.Hour)) && !t.After(time.Now().Add(2*time.Minute))
}
func (a *app) start(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ID        string    `json:"id"`
		StartedAt time.Time `json:"started_at"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.ID == "" {
		in.ID = uuid.NewString()
	}
	if in.StartedAt.IsZero() {
		in.StartedAt = time.Now().UTC().Truncate(time.Second)
	}
	if !validID(in.ID) || !validTime(in.StartedAt) {
		fail(w, 400, "invalid session ID or start time")
		return
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		fail(w, 500, "session failed")
		return
	}
	defer tx.Rollback(r.Context())
	u := current(r)
	if _, e = tx.Exec(r.Context(), "SELECT id FROM users WHERE id=$1 FOR UPDATE", u.ID); e != nil {
		fail(w, 500, "session failed")
		return
	}
	var id string
	var started time.Time
	var stopped *time.Time
	e = tx.QueryRow(r.Context(), "SELECT id::text,started_at,stopped_at FROM work_sessions WHERE id=$1 AND user_id=$2", in.ID, u.ID).Scan(&id, &started, &stopped)
	if e == nil {
		if !started.Equal(in.StartedAt) {
			fail(w, 409, "session ID reused with different start")
			return
		}
		writeJSON(w, 200, map[string]any{"id": id, "started_at": started, "stopped_at": stopped})
		return
	}
	var overlap bool
	e = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM work_sessions WHERE user_id=$1 AND (stopped_at IS NULL OR stopped_at>$2))", u.ID, in.StartedAt).Scan(&overlap)
	if e != nil {
		fail(w, 500, "session failed")
		return
	}
	if overlap {
		fail(w, 409, "session overlaps existing session")
		return
	}
	_, e = tx.Exec(r.Context(), "INSERT INTO work_sessions(id,user_id,started_at) VALUES($1,$2,$3)", in.ID, u.ID, in.StartedAt)
	if e != nil {
		fail(w, 409, "session already exists")
		return
	}
	_, e = tx.Exec(r.Context(), "UPDATE users SET last_seen_at=now() WHERE id=$1", u.ID)
	if e != nil || tx.Commit(r.Context()) != nil {
		fail(w, 500, "session failed")
		return
	}
	writeJSON(w, 200, map[string]any{"id": in.ID, "started_at": in.StartedAt, "stopped_at": nil})
}
func (a *app) stop(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ID        string    `json:"id"`
		StoppedAt time.Time `json:"stopped_at"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.StoppedAt.IsZero() {
		in.StoppedAt = time.Now().UTC().Truncate(time.Second)
	}
	if !validID(in.ID) || !validTime(in.StoppedAt) {
		fail(w, 400, "invalid session ID or stop time")
		return
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		fail(w, 500, "stop failed")
		return
	}
	defer tx.Rollback(r.Context())
	if _, e = tx.Exec(r.Context(), "SELECT id FROM users WHERE id=$1 FOR UPDATE", current(r).ID); e != nil {
		fail(w, 500, "stop failed")
		return
	}
	tag, e := tx.Exec(r.Context(), `UPDATE work_sessions SET stopped_at=$3 WHERE id=$1 AND user_id=$2 AND started_at<=$3 AND (stopped_at IS NULL OR stopped_at=$3) AND NOT EXISTS(SELECT 1 FROM blocks WHERE session_id=$1 AND end_at>$3)`, in.ID, current(r).ID, in.StoppedAt)
	if e != nil {
		fail(w, 500, "stop failed")
		return
	}
	if tag.RowsAffected() == 0 {
		fail(w, 409, "session not found, already stopped, or blocks exceed stop time")
		return
	}
	if tx.Commit(r.Context()) != nil {
		fail(w, 500, "stop failed")
		return
	}
	ok(w)
}

type block struct {
	ID         string    `json:"id"`
	SessionID  string    `json:"session_id"`
	Start      time.Time `json:"start_at"`
	End        time.Time `json:"end_at"`
	Active     int       `json:"active_seconds"`
	Screenshot string    `json:"screenshot_key"`
}

func (b block) validate(uid string) error {
	d := b.End.Sub(b.Start)
	if !validID(b.ID) || !validID(b.SessionID) || !validTime(b.Start) || !validTime(b.End) || d < time.Second || d > 600*time.Second || d%time.Second != 0 || b.Active < 0 || b.Active > int(d.Seconds()) {
		return fmt.Errorf("invalid block times, IDs or active seconds")
	}
	if b.Screenshot != "" && b.Screenshot != uid+"/"+b.ID+".jpg" {
		return fmt.Errorf("invalid screenshot key")
	}
	return nil
}
func (a *app) blocks(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Blocks []block `json:"blocks"`
	}
	if !decode(w, r, &in) {
		return
	}
	if len(in.Blocks) == 0 || len(in.Blocks) > 200 {
		fail(w, 400, "provide 1 to 200 blocks")
		return
	}
	u := current(r)
	for _, b := range in.Blocks {
		if e := b.validate(u.ID); e != nil {
			fail(w, 400, e.Error())
			return
		}
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		fail(w, 500, "blocks failed")
		return
	}
	defer tx.Rollback(r.Context())
	if _, e = tx.Exec(r.Context(), "SELECT id FROM users WHERE id=$1 FOR UPDATE", u.ID); e != nil {
		fail(w, 500, "blocks failed")
		return
	}
	for _, b := range in.Blocks {
		var old block
		var uid string
		e = tx.QueryRow(r.Context(), "SELECT user_id::text,id::text,session_id::text,start_at,end_at,active_seconds,screenshot_key FROM blocks WHERE id=$1", b.ID).Scan(&uid, &old.ID, &old.SessionID, &old.Start, &old.End, &old.Active, &old.Screenshot)
		if e == nil {
			if uid != u.ID || old.SessionID != b.SessionID || !old.Start.Equal(b.Start) || !old.End.Equal(b.End) || old.Active != b.Active || old.Screenshot != b.Screenshot {
				fail(w, 409, "block ID reused with different data")
				return
			}
			continue
		}
		var reserved bool
		if b.Screenshot != "" {
			e = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM uploads WHERE block_id=$1 AND user_id=$2 AND object_key=$3)", b.ID, u.ID, b.Screenshot).Scan(&reserved)
			if e != nil || !reserved {
				fail(w, 400, "screenshot upload reservation required")
				return
			}
		}
		var fits bool
		e = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM work_sessions WHERE id=$1 AND user_id=$2 AND started_at<=$3 AND (stopped_at IS NULL OR stopped_at>=$4))", b.SessionID, u.ID, b.Start, b.End).Scan(&fits)
		if e != nil {
			fail(w, 500, "blocks failed")
			return
		}
		if !fits {
			fail(w, 400, "block must fit own session")
			return
		}
		var overlap bool
		e = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM blocks WHERE user_id=$1 AND start_at<$3 AND end_at>$2)", u.ID, b.Start, b.End).Scan(&overlap)
		if e != nil {
			fail(w, 500, "blocks failed")
			return
		}
		if overlap {
			fail(w, 409, "block overlaps existing time")
			return
		}
		_, e = tx.Exec(r.Context(), "INSERT INTO blocks(id,user_id,session_id,start_at,end_at,duration_seconds,active_seconds,screenshot_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", b.ID, u.ID, b.SessionID, b.Start, b.End, int(b.End.Sub(b.Start).Seconds()), b.Active, b.Screenshot)
		if e != nil {
			fail(w, 409, "block conflict")
			return
		}
	}
	if tx.Commit(r.Context()) != nil {
		fail(w, 500, "blocks failed")
		return
	}
	ok(w)
}
func (a *app) upload(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ID          string `json:"block_id"`
		ContentType string `json:"content_type"`
		Size        int64  `json:"size_bytes"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !validID(in.ID) || in.ContentType != "image/jpeg" || in.Size < 1 || in.Size > 5*1024*1024 {
		fail(w, 400, "UUID block_id, image/jpeg and size_bytes (1..5242880) required")
		return
	}
	if a.signer == nil {
		fail(w, 503, "object storage is not configured")
		return
	}
	var exists bool
	if e := a.db.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM blocks WHERE id=$1)", in.ID).Scan(&exists); e != nil {
		fail(w, 500, "upload failed")
		return
	}
	if exists {
		fail(w, 409, "block already finalized")
		return
	}
	key := current(r).ID + "/" + in.ID + ".jpg"
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		fail(w, 500, "upload failed")
		return
	}
	defer tx.Rollback(r.Context())
	if _, e = tx.Exec(r.Context(), "SELECT id FROM users WHERE id=$1 FOR UPDATE", current(r).ID); e != nil {
		fail(w, 500, "upload failed")
		return
	}
	var finalized bool
	if e = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM blocks WHERE id=$1)", in.ID).Scan(&finalized); e != nil || finalized {
		fail(w, 409, "block already finalized")
		return
	}
	var hasSession bool
	var pending int
	if e = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM work_sessions WHERE user_id=$1 AND started_at>now()-interval '7 days')", current(r).ID).Scan(&hasSession); e != nil || !hasSession {
		fail(w, 400, "start own session before uploading")
		return
	}
	if e = tx.QueryRow(r.Context(), "SELECT count(*) FROM uploads x LEFT JOIN blocks b ON b.id=x.block_id WHERE x.user_id=$1 AND x.block_id<>$2 AND b.id IS NULL", current(r).ID, in.ID).Scan(&pending); e != nil {
		fail(w, 500, "upload failed")
		return
	}
	if pending >= 200 {
		fail(w, 429, "too many pending uploads")
		return
	}
	tag, e := tx.Exec(r.Context(), "INSERT INTO uploads(block_id,user_id,object_key,expires_at) VALUES($1,$2,$3,now()+interval '6 minutes') ON CONFLICT(block_id) DO UPDATE SET expires_at=excluded.expires_at WHERE uploads.user_id=excluded.user_id", in.ID, current(r).ID, key)
	if e != nil || tag.RowsAffected() == 0 {
		fail(w, 409, "upload conflict")
		return
	}
	if tx.Commit(r.Context()) != nil {
		fail(w, 500, "upload failed")
		return
	}
	signed, e := a.signer.PresignPutObject(r.Context(), &s3.PutObjectInput{Bucket: aws.String(a.bucket), Key: aws.String(key), ContentType: aws.String("image/jpeg"), ContentLength: aws.Int64(in.Size)}, func(o *s3.PresignOptions) { o.Expires = 5 * time.Minute })
	if e != nil {
		fail(w, 503, "could not sign upload")
		return
	}
	writeJSON(w, 200, map[string]any{"upload_url": signed.URL, "object_key": key, "expires_in": 300})
}
func (a *app) deleteBlock(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validID(id) {
		fail(w, 400, "invalid block ID")
		return
	}
	var key string
	e := a.db.QueryRow(r.Context(), "UPDATE blocks SET deleted_at=COALESCE(deleted_at,now()) WHERE id=$1 AND user_id=$2 RETURNING screenshot_key", id, current(r).ID).Scan(&key)
	if e != nil {
		fail(w, 404, "block not found")
		return
	}
	if key != "" && a.s3 != nil {
		if _, e = a.s3.DeleteObject(r.Context(), &s3.DeleteObjectInput{Bucket: aws.String(a.bucket), Key: aws.String(key)}); e != nil {
			fail(w, 503, "time removed, object deletion pending: retry request")
			return
		}
	}
	ok(w)
}
