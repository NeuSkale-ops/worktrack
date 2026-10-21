package main

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// Reservations survive restarts and remain until deletion succeeds.
// Cleanup waits past every issued PUT URL before deleting objects.
func (a *app) cleanupUploads(ctx context.Context) {
	if a.s3 == nil {
		return
	}
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		a.cleanUploadsOnce(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

const cleanupCondition = `x.expires_at<now() AND ((b.id IS NULL AND x.expires_at<now()-interval '8 days') OR b.deleted_at IS NOT NULL OR b.screenshot_deleted_at IS NOT NULL)`

func (a *app) cleanUploadsOnce(ctx context.Context) {
	rows, e := a.db.Query(ctx, `SELECT x.block_id::text,x.user_id::text FROM uploads x LEFT JOIN blocks b ON b.id=x.block_id WHERE `+cleanupCondition+` LIMIT 100`)
	if e != nil {
		slog.Error("upload cleanup query failed", "error", e)
		return
	}
	type item struct{ id, uid string }
	items := []item{}
	for rows.Next() {
		var v item
		if e = rows.Scan(&v.id, &v.uid); e != nil {
			break
		}
		items = append(items, v)
	}
	if rows.Err() != nil {
		rows.Close()
		return
	}
	rows.Close()
	if e != nil {
		return
	}
	for _, v := range items {
		if e = a.cleanUpload(ctx, v.id, v.uid); e != nil {
			slog.Error("upload cleanup failed", "error", e)
		}
	}
}
func (a *app) cleanUpload(ctx context.Context, id, uid string) error {
	tx, e := a.db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	// Same ordering as uploads, block finalization and session writes.
	if _, e = tx.Exec(ctx, "SELECT id FROM users WHERE id=$1 FOR UPDATE", uid); e != nil {
		return e
	}
	var key string
	e = tx.QueryRow(ctx, `SELECT x.object_key FROM uploads x LEFT JOIN blocks b ON b.id=x.block_id WHERE x.block_id=$1 AND `+cleanupCondition+` FOR UPDATE OF x`, id).Scan(&key)
	if e != nil {
		return nil
	}
	if _, e = a.s3.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(a.bucket), Key: aws.String(key)}); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, "DELETE FROM uploads WHERE block_id=$1", id); e != nil {
		return e
	}
	return tx.Commit(ctx)
}
func (a *app) deleteScreenshot(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validID(id) {
		fail(w, 400, "invalid block ID")
		return
	}
	var key string
	e := a.db.QueryRow(r.Context(), "UPDATE blocks SET screenshot_deleted_at=COALESCE(screenshot_deleted_at,now()) WHERE id=$1 AND user_id=$2 RETURNING screenshot_key", id, current(r).ID).Scan(&key)
	if e != nil {
		fail(w, 404, "block not found")
		return
	}
	if key != "" && a.s3 != nil {
		if _, e = a.s3.DeleteObject(r.Context(), &s3.DeleteObjectInput{Bucket: aws.String(a.bucket), Key: aws.String(key)}); e != nil {
			fail(w, 503, "screenshot hidden, object deletion queued")
			return
		}
	}
	ok(w)
}
