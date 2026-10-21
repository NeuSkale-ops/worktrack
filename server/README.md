# WorkTrack API server

Run `go run .` from this directory with `DATABASE_URL` set to PostgreSQL 17.
The server applies embedded, idempotent SQL under a transaction-scoped advisory lock before accepting requests.
See [API.md](API.md) for request shapes and environment variables.

## Local development

Set `APP_ORIGIN=http://localhost:5173` and `DEV_MODE=true` for the Vite dashboard.
Set `BOOTSTRAP_EMAIL`, `BOOTSTRAP_PASSWORD` (12 or more characters), and optionally `BOOTSTRAP_NAME` in the process environment to create the first owner.
Bootstrap does nothing once any user exists and never changes an existing password.
Use your secret manager to supply production settings, never commit environment files.

Production must use HTTPS, a private database, `DEV_MODE=false`, and the exact public `APP_ORIGIN`.
The production browser cookie is Secure, HttpOnly, and SameSite=Strict.
The desktop client requests a device token by supplying `device_name` at login and stores it in its operating-system credential store.
Browser credentials expire after 24 hours, device credentials after 90 days, and invites after seven days.
Only SHA-256 hashes of random credentials and invites are persisted.
Passwords use Argon2id with a unique random 16-byte salt, 64 MiB memory, three passes, and two lanes.

Login is limited to 10 attempts per account per minute and 120 per direct peer IP per minute, plus four concurrent expensive password hashes.
Forwarded IP headers are deliberately ignored, so clients behind Caddy share the peer-IP budget.
These limits are process-local and reset on restart, so keep one API replica or enforce additional limits at the reverse proxy.

## Private object storage

Configure `R2_ENDPOINT`, `R2_REGION` (default `auto`), `R2_BUCKET`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` for Cloudflare R2.
Store these settings with `envkit set KEY`, never in source control or chat.
The AWS SDK is only the S3-compatible transport and reads these R2 keys explicitly.
Use a private bucket, a bucket-scoped service key, and a 90-day object-expiry lifecycle rule.
The server signs five-minute JPEG PUT URLs with an exact Content-Length between one byte and 5 MiB.
The agent uploads directly to S3, then submits the activity block with its reserved key.
Only owners of the corresponding time data can request upload or deletion, and managers can read team screenshots through short-lived signed GET URLs.
Already-issued GET URLs may work until their five-minute expiry, although successful object deletion removes the object immediately.

Screenshot-only deletion preserves hours, whereas explicit block deletion removes that block's hours.
Deletion immediately hides screenshot metadata and attempts object deletion.
Durable upload reservations remain until a background cleanup successfully deletes the object after every outstanding PUT URL has expired.
Cleanup retries every minute, including after process restarts.
Abandoned, unfinalized uploads are cleaned after eight days, longer than the seven-day accepted offline window.
The agent retains JPEG bytes until its block is acknowledged.
If block submission returns HTTP 400 with `code: "upload_expired"`, the agent clears the staged key, requests another URL, reuploads the retained JPEG with the same block UUID, and retries the block.
At most 200 unfinalized reservations per user are allowed.
The client must not capture when stopped and must capture exactly every 600 elapsed running seconds.
The server validates session ownership, bounded exact-second durations, non-overlap, and immutable UUID retries, but cannot prove that an untrusted desktop really captured an image at a particular moment.

## Desktop diagnostics

Separately opted-in agents send fixed event codes, timestamps, numeric HTTP status, and app version through device-authenticated `POST /api/agent/logs`.
No arbitrary error text is accepted. The caller's account is taken from its credential, never from the body.
Only owners can read `GET /api/agent/logs`; the dashboard loads the newest 100 entries on demand.
Requests are capped at 16 KiB/20 events, six requests per minute per user, and a persistent 120 new events per rolling hour per user.
Duplicate retries do not overwrite events or consume more storage budget.
Logs expire after seven days by occurrence time. Startup/hourly cleanup runs even without screenshot storage, and owner reads always filter expired entries.
Backups have their own retention policy. See `API.md` for the exact contract and `agent/README.md` for consent and delivery limits.

## Tests

`go test -race ./...` runs HTTP security and validation, password hashing, and throttling tests.
Set `WT_TEST_DATABASE_URL` to a disposable database to also run real PostgreSQL-backed HTTP authentication, tracking, idempotency, per-user permissions, presigning, durable deletion retry, and diagnostic authorization/validation/quota/retention tests.
The integration test creates unique test users and deletes only their generated rows on completion.
It uses a local fake S3 HTTP endpoint and never needs real object-store credentials.
Run `go vet ./...` before shipping.
