package main

import (
	"math"
	"net/http"
	"strconv"
	"time"
)

type daySpan struct {
	UserID     string    `json:"user_id"`
	Start      time.Time `json:"start_at"`
	End        time.Time `json:"end_at"`
	Screenshot bool      `json:"screenshot"`
	Active     int       `json:"active_seconds"`
}

// day returns block spans for every person the caller may see on one local
// date. It powers the team ribbon, so it never signs screenshot URLs.
func (a *app) day(w http.ResponseWriter, r *http.Request) {
	// Workers see hours only. Per-block spans and activity are for managers and owners.
	if !a.requireAdmin(w, r) {
		return
	}
	loc, okay := zone(r)
	if !okay {
		fail(w, 400, "invalid time zone")
		return
	}
	date, e := dateValue(r.URL.Query().Get("date"), loc)
	if e != nil {
		fail(w, 400, "invalid date")
		return
	}
	cond, args := sees(r, "u.id", "u.org_id", 3)
	rows, e := a.db.Query(r.Context(), `SELECT b.user_id::text,b.start_at,b.end_at,b.screenshot_key<>'' AND b.screenshot_deleted_at IS NULL,b.active_seconds
 FROM blocks b JOIN users u ON u.id=b.user_id WHERE b.deleted_at IS NULL AND b.start_at<$2 AND b.end_at>$1 AND `+cond+`
 ORDER BY b.user_id,b.start_at LIMIT 20000`, append([]any{date, date.AddDate(0, 0, 1)}, args...)...)
	if e != nil {
		fail(w, 500, "day report unavailable")
		return
	}
	defer rows.Close()
	out := []daySpan{}
	for rows.Next() {
		var v daySpan
		if e = rows.Scan(&v.UserID, &v.Start, &v.End, &v.Screenshot, &v.Active); e != nil {
			fail(w, 500, "day report unavailable")
			return
		}
		out = append(out, v)
	}
	if rows.Err() != nil {
		fail(w, 500, "day report unavailable")
		return
	}
	writeJSON(w, 200, out)
}

type deviceSpan struct {
	DeviceID string    `json:"device_id"`
	Start    time.Time `json:"start_at"`
	End      time.Time `json:"end_at"`
	Active   float64   `json:"active_seconds"`
}

// deviceDay returns runs of active time for every assigned laptop the caller
// may see on one local date. It powers the laptop line under each person, so
// it is for owners and managers only. The agent sends one activity event per
// minute, stamped at the end of that minute. Minutes less than two minutes
// apart join into one run. Activity from before a laptop was reassigned is
// left out, so it never appears under the new person.
func (a *app) deviceDay(w http.ResponseWriter, r *http.Request) {
	if !a.requireAdmin(w, r) {
		return
	}
	loc, okay := zone(r)
	if !okay {
		fail(w, 400, "invalid time zone")
		return
	}
	date, e := dateValue(r.URL.Query().Get("date"), loc)
	if e != nil {
		fail(w, 400, "invalid date")
		return
	}
	cond, args := sees(r, "d.user_id", "d.org_id", 3)
	rows, e := a.db.Query(r.Context(), `SELECT d.id::text,e.occurred_at,COALESCE(e.payload->>'active_secs','')
 FROM device_events e JOIN devices d ON d.id=e.device_id
 WHERE d.user_id IS NOT NULL AND e.kind='activity' AND e.occurred_at>=$1 AND e.occurred_at<$2 AND (d.assigned_at IS NULL OR e.occurred_at>=d.assigned_at) AND `+cond+`
 ORDER BY d.id,e.occurred_at LIMIT 50000`, append([]any{date, date.AddDate(0, 0, 1)}, args...)...)
	if e != nil {
		fail(w, 500, "laptop report unavailable")
		return
	}
	defer rows.Close()
	out := []deviceSpan{}
	for rows.Next() {
		var id, raw string
		var at time.Time
		if e = rows.Scan(&id, &at, &raw); e != nil {
			fail(w, 500, "laptop report unavailable")
			return
		}
		// The payload comes from the laptop, so it is parsed here rather than
		// cast in SQL, where one malformed value would fail the whole report.
		secs, err := strconv.ParseFloat(raw, 64)
		if err != nil || !(secs > 0) {
			continue
		}
		secs = math.Min(secs, 60)
		start := at.Add(-time.Minute)
		if n := len(out); n > 0 && out[n-1].DeviceID == id && start.Sub(out[n-1].End) <= 2*time.Minute {
			out[n-1].End, out[n-1].Active = at, out[n-1].Active+secs
		} else {
			out = append(out, deviceSpan{id, start, at, secs})
		}
	}
	if rows.Err() != nil {
		fail(w, 500, "laptop report unavailable")
		return
	}
	writeJSON(w, 200, out)
}
