# V1 API contract

All JSON uses snake_case.
Errors are `{ "error": "message" }`.
Times are RFC3339 UTC, IDs UUID strings.
Browser requests use credentials/include and an Origin matching APP_ORIGIN (localhost ports allowed only with DEV_MODE=true).
Agent requests use Authorization: Bearer <device_token>.

| Method | Path | Request | Response |
|---|---|---|---|
| POST | /api/auth/login | {email,password,device_name?} | {user,device_token?}, otherwise HttpOnly cookie |
| GET | /api/auth/me | | user |
| POST | /api/auth/logout | {} | {ok:true} |
| POST | /api/auth/accept-invite | {token,name,password} | {ok:true}, then login |
| POST | /api/invites | {email,role:"worker"} | {token,url,expires_at} |
| GET | /api/team | | array of {id,email,name,role,working,last_seen_at} |
| POST | /api/sessions/start | {id?:UUID,started_at?:timestamp} | {id,started_at,stopped_at:null} |
| POST | /api/sessions/stop | {id,stopped_at?:timestamp} | {ok:true} |
| POST | /api/heartbeat | {} | {ok:true} |
| POST | /api/uploads/screenshot-url | {block_id:UUID,content_type:"image/jpeg",size_bytes:integer} | {upload_url,object_key,expires_in:300} |
| POST | /api/blocks | {blocks:[{id:UUID,session_id:UUID,start_at,end_at,active_seconds:integer,screenshot_key?:string}]} | {ok:true} |
| DELETE | /api/blocks/{id}/screenshot | | {ok:true}, preserves tracked time |
| DELETE | /api/blocks/{id} | | {ok:true} |
| GET | /api/timeline?user=UUID&date=YYYY-MM-DD | | array of {id,user_id,session_id,start_at,end_at,duration_seconds,active_seconds,screenshot_url} |
| GET | /api/reports/hours?from=YYYY-MM-DD&to=YYYY-MM-DD | | array of {user_id,name,date,seconds,hours} |
| GET | /api/reports/hours.csv?from=YYYY-MM-DD&to=YYYY-MM-DD | | CSV |
| GET | /api/health | | {ok:true} |

User: {id,email,name,role}.
Owner/manager can read team data, workers only their own timeline/hours.
Only owner can invite managers. Managers can invite workers.
All tracking writes target the authenticated user's data.
Blocks are immutable and idempotent by UUID. Conflicting retries return 409.
Duration is exact end_at minus start_at, integer seconds from 1 through 600. All tracking timestamps must be whole seconds. active_seconds must be between zero and duration.
Blocks must fit their session and must not overlap other blocks. Partial final blocks are allowed.
Screenshots must use the returned object_key. size_bytes must be 1..5242880 and PUT Content-Length must match it. An own session within the last seven days is required before requesting upload URLs. Unfinished upload reservations are capped at 200 per user. Abandoned uploads expire after 24 hours. Deleted uploads are retried durably after all five-minute PUT URLs expire.
The agent captures exactly every 600 elapsed running seconds, never while stopped, not randomized.
Session start and stop accept client timestamps for offline buffering, no more than 7 days old or 2 minutes in future.
Deleting one's block excludes its time and makes its screenshot inaccessible through this API.
Date report ranges include both dates and default to today UTC.

## Environment

DATABASE_URL, APP_ORIGIN (default http://localhost:5173), LISTEN_ADDR (default :8080), DEV_MODE (default false).
BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, BOOTSTRAP_NAME create the first owner only when users is empty.
S3_ENDPOINT, S3_REGION (default eu-central), S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY configure private Hetzner storage.
Without S3 configuration upload URL requests return 503.
Run `go run .` from server/. SQL migrations run automatically under a PostgreSQL advisory lock.
