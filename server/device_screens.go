package main

import (
	"bytes"
	"io"
	"net/http"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// Managed-device screenshots and the owner activity view.
//
// The agent uploads each screenshot JPEG here before it sends the matching
// "screenshot" event, then sends the event with the returned screenshot_key.
// The key is derived from the device and the event_id, so a retry after a
// crash overwrites the same object instead of leaking a new one.

const maxDeviceScreenshot = 5 << 20

func deviceScreenshotKey(deviceID, eventID string) string {
	return "devices/" + deviceID + "/" + eventID + ".jpg"
}

func (a *app) deviceScreenshot(w http.ResponseWriter, r *http.Request) {
	d, okAuth := a.deviceToken(r)
	if !okAuth {
		fail(w, 401, "device token required")
		return
	}
	if d.uninstall {
		fail(w, 403, "device is uninstalling")
		return
	}
	eventID := r.PathValue("event")
	if !validID(eventID) {
		fail(w, 400, "event id must be a UUID")
		return
	}
	if a.s3 == nil {
		fail(w, 503, "object storage is not configured")
		return
	}
	if r.Header.Get("Content-Type") != "image/jpeg" {
		fail(w, 400, "image/jpeg required")
		return
	}
	if !a.limiter.allow("devshot:"+d.id, 30) {
		w.Header().Set("Retry-After", "60")
		fail(w, 429, "screenshot rate limit reached")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxDeviceScreenshot))
	if err != nil || len(body) < 3 || !bytes.Equal(body[:3], []byte{0xFF, 0xD8, 0xFF}) {
		fail(w, 400, "JPEG up to 5 MB required")
		return
	}
	key := deviceScreenshotKey(d.id, eventID)
	if _, err = a.s3.PutObject(r.Context(), &s3.PutObjectInput{
		Bucket: aws.String(a.bucket), Key: aws.String(key),
		ContentType: aws.String("image/jpeg"), Body: bytes.NewReader(body),
		ContentLength: aws.Int64(int64(len(body))),
	}); err != nil {
		fail(w, 503, "could not store screenshot")
		return
	}
	writeJSON(w, 200, map[string]string{"screenshot_key": key})
}

// deviceActivity returns one device's events for a local day, newest first,
// with short-lived signed screenshot URLs. Managers see only events recorded
// since the laptop was last reassigned, so moving a laptop into their org does
// not hand them its earlier history. Owners see everything.
func (a *app) deviceActivity(w http.ResponseWriter, r *http.Request) {
	id, okay := a.deviceVisible(w, r)
	if !okay {
		return
	}
	loc, okZone := zone(r)
	if !okZone {
		fail(w, 400, "invalid tz")
		return
	}
	day, err := dateValue(r.URL.Query().Get("date"), loc)
	if err != nil {
		fail(w, 400, "date must be YYYY-MM-DD")
		return
	}
	rows, err := a.db.Query(r.Context(), `SELECT event_id::text,kind,occurred_at,payload
	 FROM device_events WHERE device_id=$1 AND occurred_at>=$2 AND occurred_at<$3
	  AND ($4 OR occurred_at>=COALESCE((SELECT assigned_at FROM devices WHERE id=$1),'-infinity'))
	 ORDER BY occurred_at DESC LIMIT 2000`, id, day, day.AddDate(0, 0, 1), current(r).Role == "owner")
	if err != nil {
		fail(w, 503, "activity unavailable")
		return
	}
	defer rows.Close()
	type event struct {
		EventID       string         `json:"event_id"`
		Kind          string         `json:"kind"`
		OccurredAt    time.Time      `json:"occurred_at"`
		Payload       map[string]any `json:"payload"`
		ScreenshotURL string         `json:"screenshot_url,omitempty"`
	}
	out := []event{}
	for rows.Next() {
		var e event
		if err = rows.Scan(&e.EventID, &e.Kind, &e.OccurredAt, &e.Payload); err != nil {
			fail(w, 503, "activity unavailable")
			return
		}
		// Only keys this server minted for this device are signed, so a crafted
		// payload cannot read another device's or user's objects.
		if key, _ := e.Payload["screenshot_key"].(string); key != "" && key == deviceScreenshotKey(id, e.EventID) && a.signer != nil {
			signed, err := a.signer.PresignGetObject(r.Context(), &s3.GetObjectInput{Bucket: aws.String(a.bucket), Key: aws.String(key)}, func(o *s3.PresignOptions) { o.Expires = 5 * time.Minute })
			if err == nil {
				e.ScreenshotURL = signed.URL
			}
		}
		delete(e.Payload, "screenshot_key")
		out = append(out, e)
	}
	if rows.Err() != nil {
		fail(w, 503, "activity unavailable")
		return
	}
	writeJSON(w, 200, out)
}
