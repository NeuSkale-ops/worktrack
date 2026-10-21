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
| POST | /api/agent/logs | {version,events:[{id,occurred_at,code,status?}]} | {ok:true}, device credential only |
| GET | /api/agent/logs | | newest 100 diagnostic entries, owner only |
| GET | /api/sessions/current | | own open session {id,started_at,recoverable}, or null |
| POST | /api/sessions/recover | {id:UUID} | {ok:true}, explicitly closes own stale session |
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
Screenshots must use the returned object_key. size_bytes must be 1..5242880 and PUT Content-Length must match it. An own session within the last seven days is required before requesting upload URLs. Unfinished upload reservations are capped at 200 per user. Abandoned uploads expire after eight days, beyond the seven-day accepted offline window. A block referencing a missing reservation returns HTTP 400 with `{code:"upload_expired",error:"screenshot upload reservation expired; request a new upload URL and upload again"}`. Retain JPEG bytes until block acknowledgment, clear the staged key on this code, then presign and PUT again using the same block UUID. Deleted uploads are retried durably after all five-minute PUT URLs expire.
The agent captures exactly every 600 elapsed running seconds, never while stopped, not randomized.
Session start and stop accept client timestamps for offline buffering, no more than 7 days old or 2 minutes in future.
Recovery is for a lost computer or lost app data, not ordinary offline delivery. Stop and sync the original computer whenever possible.
The dashboard requires confirmation. The API only recovers the explicitly supplied session ID belonging to the caller, with no heartbeat in the last two minutes. It closes at the latest uploaded block end (including deleted blocks), or the session start if empty, without adding tracked time. Recovery also works for sessions older than seven days. Active, foreign, closed, or stale-ID requests return 409. Unsynced records beyond the recovered endpoint may be rejected if the original computer later reconnects.
Deleting one's block excludes its time and makes its screenshot inaccessible through this API.
Date report ranges include both dates and default to today UTC.
Timeline dates select whole blocks by their UTC start date, preserving the original block duration and activity without clipping.
Hours reports and CSV split blocks crossing midnight into exact seconds on each UTC calendar date.
Consequently, summing a timeline day's full blocks can differ from that day's payroll total for cross-midnight work.
Use the hours report, not a timeline sum, for daily payroll totals.

## Screenshot location and foreground application usage

Each `/api/blocks` entry may include `location` and `application_usage`. Legacy agents may omit both.
`application_usage` is an array of up to 32 unique `{app,milliseconds}` entries. Names are executable basenames (1–256 UTF-8 bytes), never paths/control characters, and durations must be positive integers whose sum does not exceed the block duration in milliseconds.
Timeline responses include the same array. The dashboard aggregates selected-worker blocks starting on the selected UTC date into estimated foreground minutes, including idle time. It does not identify browser sites, windows, documents, or all background-running apps.

`location` is null on ordinary time blocks. Screenshot entries may contain `{status,captured_at,latitude?,longitude?,accuracy_m?,observed_at?}`.
Statuses are `available`, `disabled`, or `unavailable`; local pending states are never accepted by the API.
Capture timestamps must be within five seconds of the screenshot block end. Available locations require finite latitude [-90,90], longitude [-180,180], positive accuracy up to 20,000,000 metres, and a fix timestamp between two seconds before and ten seconds after capture. Disabled/unavailable records cannot carry coordinates or fix metadata.
Worker consent and Windows permission govern collection; absence of a location never prevents screenshot/time ingestion. These fields are client-reported and can be approximate or spoofed, not verified attendance evidence.

Existing own-timeline and manager/owner team permissions apply. Duplicate blocks must retain matching metadata. Screenshot deletion physically clears location; time-block deletion clears location and application usage. Retrying an old deleted block cannot restore erased metadata. Work records remain until deletion; database backups have separate retention.
Deploy this API before a client that sends these fields. Older API versions reject unknown block fields and cannot ingest new-client queues until the compatible API is restored.

## Desktop diagnostic logs

Diagnostic upload is separately opt-in in the desktop app and independent of tracking delivery.
The ingestion endpoint requires a device credential, not a browser cookie. Account identity comes only from that credential; user IDs, arbitrary messages, and unknown fields in the payload are rejected.
The app version must contain three numeric dot-separated components, each with one to five digits.
Each request is limited to 16 KiB and 1 to 20 events. Event IDs are UUIDs, timestamps are RFC3339 within the past seven days or at most two minutes ahead, and optional HTTP status must be 100 through 599.

Allowed codes: `login_failed`, `sync_failed`, `capture_failed`, `activity_failed`, `queue_failed`, `heartbeat_failed`, `update_check_failed`, `update_install_failed`.
The server derives fixed severity/messages from these codes. Never send raw error strings, request URLs, credentials, screenshots, keyboard content, or machine names.
Duplicate `(authenticated user, event ID)` pairs are acknowledged without overwriting stored data.
Requests are atomic. Invalid input returns 400; browser uploads or non-owner reads return 403; throttled requests return 429 with `Retry-After`.

There are six requests per user per minute per API process, using the existing bounded limiter.
A persistent transaction-protected limit allows at most 120 new events per user per rolling hour across API processes. Duplicate retries do not consume additional storage budget.
Owner reads return `{id,user_id,name,occurred_at,version,code,status?,level,message}` entries, newest first, capped at 100. Managers and workers cannot read diagnostics.
The timestamps/version/status are client-reported diagnostics, not proof of worker activity or software integrity.

Entries older than seven days by occurrence time are excluded from reads and deleted at startup and hourly, with a ten-second cleanup timeout.
This retention applies to the live database. Existing encrypted backups retain their snapshots according to the backup policy.
No logging failure changes tracking records, screenshot retention, or wages.

## Environment

DATABASE_URL, APP_ORIGIN (default http://localhost:5173), LISTEN_ADDR (default :8080), DEV_MODE (default false).
BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, BOOTSTRAP_NAME create the first owner only when users is empty.
ALLOW_WEAK_BOOTSTRAP_PASSWORD=true explicitly permits a nonempty initial owner password shorter than 12 characters.
This insecure exception is disabled by default, does not change invite password validation, and must be removed with bootstrap credentials after first login.
R2_ENDPOINT, R2_REGION (default auto), R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY configure private Cloudflare R2 storage.
The R2-prefixed access keys are passed explicitly to the S3-compatible SDK.
Legacy S3_/AWS_ environment names are not read for this storage configuration.
Without S3 configuration upload URL requests return 503.
Run `go run .` from server/. SQL migrations run automatically under a PostgreSQL advisory lock.
