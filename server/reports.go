package main

import (
	"encoding/csv"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

func dateValue(v string, loc *time.Location) (time.Time, error) {
	if v == "" {
		v = time.Now().In(loc).Format("2006-01-02")
	}
	return time.ParseInLocation("2006-01-02", v, loc)
}

// zone reads the optional IANA `tz` query parameter, defaulting to UTC.
// Report days start at local midnight in that zone.
func zone(r *http.Request) (*time.Location, bool) {
	name := r.URL.Query().Get("tz")
	if name == "" {
		return time.UTC, true
	}
	if len(name) > 64 || strings.ContainsAny(name, " \\") || strings.HasPrefix(name, "/") {
		return nil, false
	}
	loc, e := time.LoadLocation(name)
	return loc, e == nil && name != "Local"
}
func (a *app) timeline(w http.ResponseWriter, r *http.Request) {
	u := current(r)
	uid := r.URL.Query().Get("user")
	if uid == "" {
		uid = u.ID
	}
	if !validID(uid) {
		fail(w, 400, "invalid user ID")
		return
	}
	if u.Role == "worker" && uid != u.ID {
		fail(w, 403, "own timeline only")
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
	rows, e := a.db.Query(r.Context(), "SELECT id::text,user_id::text,session_id::text,start_at,end_at,duration_seconds,active_seconds,screenshot_key,screenshot_deleted_at IS NOT NULL,location,application_usage FROM blocks WHERE user_id=$1 AND start_at>=$2 AND start_at<$3 AND deleted_at IS NULL ORDER BY start_at", uid, date, date.AddDate(0, 0, 1))
	if e != nil {
		fail(w, 500, "timeline unavailable")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, userID, sid, key string
		var start, end time.Time
		var duration, active int
		var screenshotDeleted bool
		var location *screenshotLocation
		var applications []applicationUsage
		if e = rows.Scan(&id, &userID, &sid, &start, &end, &duration, &active, &key, &screenshotDeleted, &location, &applications); e != nil {
			fail(w, 500, "timeline unavailable")
			return
		}
		signedURL := ""
		if key != "" && !screenshotDeleted && a.signer != nil {
			signed, e := a.signer.PresignGetObject(r.Context(), &s3.GetObjectInput{Bucket: aws.String(a.bucket), Key: aws.String(key)}, func(o *s3.PresignOptions) { o.Expires = 5 * time.Minute })
			if e != nil {
				fail(w, 503, "could not sign screenshot")
				return
			}
			signedURL = signed.URL
		}
		screenshotStatus := "not_captured"
		if key != "" {
			screenshotStatus = "unavailable"
			if screenshotDeleted {
				screenshotStatus = "deleted"
			} else if signedURL != "" {
				screenshotStatus = "available"
			}
		}
		out = append(out, map[string]any{"id": id, "user_id": userID, "session_id": sid, "start_at": start, "end_at": end, "duration_seconds": duration, "active_seconds": active, "screenshot_url": signedURL, "screenshot_status": screenshotStatus, "location": location, "application_usage": applications})
	}
	if rows.Err() != nil {
		fail(w, 500, "timeline unavailable")
		return
	}
	writeJSON(w, 200, out)
}

type hourRow struct {
	UserID  string  `json:"user_id"`
	Name    string  `json:"name"`
	Date    string  `json:"date"`
	Seconds int64   `json:"seconds"`
	Hours   float64 `json:"hours"`
}

func (a *app) hours(w http.ResponseWriter, r *http.Request) {
	loc, okay := zone(r)
	if !okay {
		fail(w, 400, "invalid time zone")
		return
	}
	from, e := dateValue(r.URL.Query().Get("from"), loc)
	if e != nil {
		fail(w, 400, "invalid from date")
		return
	}
	to, e := dateValue(r.URL.Query().Get("to"), loc)
	if e != nil || to.Before(from) || to.Sub(from) > 366*24*time.Hour {
		fail(w, 400, "invalid date range (maximum 367 days)")
		return
	}
	u := current(r)
	// Split cross-midnight blocks so payroll counts exact seconds on each local
	// date. d.day is a local wall-clock midnight, so DST days are 23 or 25 hours.
	rows, e := a.db.Query(r.Context(), `SELECT u.id::text,u.name,to_char(d.day,'YYYY-MM-DD'),sum(extract(epoch FROM least(b.end_at,(d.day+interval '1 day') AT TIME ZONE $5)-greatest(b.start_at,d.day AT TIME ZONE $5)))::bigint
 FROM blocks b JOIN users u ON u.id=b.user_id
 CROSS JOIN LATERAL generate_series(date_trunc('day',b.start_at AT TIME ZONE $5),date_trunc('day',(b.end_at-interval '1 microsecond') AT TIME ZONE $5),interval '1 day') d(day)
 WHERE b.deleted_at IS NULL AND b.start_at>=$1::timestamptz-interval '600 seconds' AND b.start_at<$2 AND b.end_at>$1
 AND d.day>=$6::date AND d.day<=$7::date AND ($3<>'worker' OR u.id=$4)
 GROUP BY u.id,u.name,d.day ORDER BY d.day,u.name,u.id`, from, to.AddDate(0, 0, 1), u.Role, u.ID, loc.String(), from.Format("2006-01-02"), to.Format("2006-01-02"))
	if e != nil {
		fail(w, 500, "report unavailable")
		return
	}
	defer rows.Close()
	out := []hourRow{}
	for rows.Next() {
		var v hourRow
		if e = rows.Scan(&v.UserID, &v.Name, &v.Date, &v.Seconds); e != nil {
			fail(w, 500, "report unavailable")
			return
		}
		v.Hours = float64(v.Seconds) / 3600
		out = append(out, v)
	}
	if rows.Err() != nil {
		fail(w, 500, "report unavailable")
		return
	}
	if strings.HasSuffix(r.URL.Path, ".csv") {
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="hours.csv"`)
		c := csv.NewWriter(w)
		_ = c.Write([]string{"user_id", "name", "date", "seconds", "hours"})
		for _, v := range out {
			name := v.Name
			if strings.HasPrefix(name, "=") || strings.HasPrefix(name, "+") || strings.HasPrefix(name, "-") || strings.HasPrefix(name, "@") || strings.HasPrefix(name, "\t") || strings.HasPrefix(name, "\r") {
				name = "'" + name
			}
			_ = c.Write([]string{v.UserID, name, v.Date, fmt.Sprint(v.Seconds), fmt.Sprintf("%.6f", v.Hours)})
		}
		c.Flush()
		return
	}
	writeJSON(w, 200, out)
}
