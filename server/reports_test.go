package main

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestHoursUTCBoundaries(t *testing.T) {
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
	a := &app{db: db}
	if err = a.migrate(ctx); err != nil {
		t.Fatal(err)
	}
	uid, sid, raw := uuid.NewString(), uuid.NewString(), token()
	if _, err = db.Exec(ctx, "INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,'Midnight','worker','unused')", uid, uid+"@example.test"); err != nil {
		t.Fatal(err)
	}
	defer func() {
		for _, table := range []string{"blocks", "work_sessions", "credentials", "users"} {
			column := "user_id"
			if table == "users" {
				column = "id"
			}
			_, _ = db.Exec(ctx, "DELETE FROM "+table+" WHERE "+column+"=$1", uid)
		}
	}()
	if _, err = db.Exec(ctx, "INSERT INTO credentials(token_hash,user_id,kind,expires_at) VALUES($1,$2,'device',now()+interval '1 day')", digest(raw), uid); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, "INSERT INTO work_sessions(id,user_id,started_at,stopped_at) VALUES($1,$2,'2026-01-01','2026-01-07')", sid, uid); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range []struct {
		start, end string
		seconds    int
		deleted    bool
	}{
		{"2026-01-01T12:00:00Z", "2026-01-01T12:00:30Z", 30, false},
		{"2026-01-02T18:25:00Z", "2026-01-02T18:35:00Z", 600, false},
		{"2026-01-03T23:50:00Z", "2026-01-04T00:00:00Z", 600, false},
		{"2026-01-04T23:50:01Z", "2026-01-05T00:00:01Z", 600, false},
		{"2026-01-05T00:00:01Z", "2026-01-05T00:01:01Z", 60, false},
		{"2026-01-05T02:00:00Z", "2026-01-05T02:00:30Z", 30, true},
		{"2026-01-06T00:00:00Z", "2026-01-06T00:00:30Z", 30, false},
	} {
		if _, err = db.Exec(ctx, `INSERT INTO blocks(id,user_id,session_id,start_at,end_at,duration_seconds,active_seconds,deleted_at) VALUES($1,$2,$3,$4,$5,$6,0,CASE WHEN $7 THEN now() END)`, uuid.NewString(), uid, sid, fixture.start, fixture.end, fixture.seconds, fixture.deleted); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		from, to string
		want     map[string]int64
		tz       string
	}{
		{"2026-01-03", "2026-01-03", map[string]int64{"2026-01-03": 600}, ""},
		{"2026-01-04", "2026-01-04", map[string]int64{"2026-01-04": 599}, ""},
		{"2026-01-05", "2026-01-05", map[string]int64{"2026-01-05": 61}, ""},
		{"2026-01-04", "2026-01-05", map[string]int64{"2026-01-04": 599, "2026-01-05": 61}, ""},
		// IST midnight is 18:30 UTC: the 18:25-18:35 block splits in half.
		{"2026-01-02", "2026-01-03", map[string]int64{"2026-01-02": 300, "2026-01-03": 300}, "Asia/Kolkata"},
		{"2026-01-04", "2026-01-06", map[string]int64{"2026-01-04": 600, "2026-01-05": 660, "2026-01-06": 30}, "Asia/Kolkata"},
	} {
		for _, suffix := range []string{"", ".csv"} {
			t.Run(tc.from+"_"+tc.to+tc.tz+suffix, func(t *testing.T) {
				r := httptest.NewRequest("GET", "/api/reports/hours"+suffix+"?from="+tc.from+"&to="+tc.to+"&tz="+tc.tz, nil)
				r.Header.Set("Authorization", "Bearer "+raw)
				w := httptest.NewRecorder()
				a.routes().ServeHTTP(w, r)
				if w.Code != 200 {
					t.Fatalf("report: %d %s", w.Code, w.Body.String())
				}
				got := map[string]int64{}
				if suffix == "" {
					var rows []hourRow
					if err := json.Unmarshal(w.Body.Bytes(), &rows); err != nil {
						t.Fatal(err)
					}
					for _, row := range rows {
						got[row.Date] = row.Seconds
					}
				} else {
					rows, err := csv.NewReader(strings.NewReader(w.Body.String())).ReadAll()
					if err != nil || len(rows) == 0 {
						t.Fatalf("CSV: %v %v", rows, err)
					}
					for _, row := range rows[1:] {
						seconds, err := strconv.ParseInt(row[3], 10, 64)
						if err != nil {
							t.Fatal(err)
						}
						got[row[2]] = seconds
					}
				}
				if len(got) != len(tc.want) {
					t.Fatalf("dates: got %v want %v", got, tc.want)
				}
				for date, seconds := range tc.want {
					if got[date] != seconds {
						t.Fatalf("%s: got %d want %d", date, got[date], seconds)
					}
				}
			})
		}
	}
}
