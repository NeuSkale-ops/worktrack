package main

import (
	"net/http"
	"time"
)

type daySpan struct {
	UserID     string    `json:"user_id"`
	Start      time.Time `json:"start_at"`
	End        time.Time `json:"end_at"`
	Screenshot bool      `json:"screenshot"`
}

// day returns block spans for every person the caller may see on one local
// date. It powers the team ribbon, so it never signs screenshot URLs.
func (a *app) day(w http.ResponseWriter, r *http.Request) {
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
	rows, e := a.db.Query(r.Context(), `SELECT b.user_id::text,b.start_at,b.end_at,b.screenshot_key<>'' AND b.screenshot_deleted_at IS NULL
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
		if e = rows.Scan(&v.UserID, &v.Start, &v.End, &v.Screenshot); e != nil {
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
