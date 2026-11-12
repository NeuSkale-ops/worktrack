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
	u := current(r)
	rows, e := a.db.Query(r.Context(), `SELECT user_id::text,start_at,end_at,screenshot_key<>'' AND screenshot_deleted_at IS NULL
 FROM blocks WHERE deleted_at IS NULL AND start_at<$2 AND end_at>$1 AND ($3<>'worker' OR user_id=$4)
 ORDER BY user_id,start_at LIMIT 20000`, date, date.AddDate(0, 0, 1), u.Role, u.ID)
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
