# Validation record

Date: 2026-10-21.
This records observed checks, not a production-readiness claim.

## Auto-update audit (source fixes, no publication)

Observed October 21, 2026 at 18:06–18:17 UTC:

- Anonymous HTTPS checks of both production and staging `latest.json` returned HTTP 404 with revalidation headers and no dashboard HTML. The latest production-channel signed workflow `39619325968` passed build and verification, but publication was skipped. The preceding signed runs `39609351264` and `39600736918` also skipped publication. Manual installer distribution is not automatic-update discovery. Versions 0.1.0 and 0.1.1 have no updater at all.
- Downloaded the exact v0.1.5 workflow candidate, compared its public key with the committed trust anchor, and ran `scripts/updater_release.py verify --channel production`. Real minisign verification, exact trusted version, checksum and production URL all passed. Downloaded the public manual installer independently: SHA-256 `0ed92d211340e34d9228b5d3d434e6463ac8507102f3a2ac85ad633479935638`, identical to the verified candidate. This confirms existing distribution integrity, not a new release or successful in-app installation.
- Fixed a pinned-plugin boundary: updater 2.14.0 initializes `Update.timeout` to `None`, even when the check builder has a timeout. The application now explicitly sets a ten-minute download timeout before reserving installation. Missing-feed errors explain administrator publication action rather than blaming the worker connection.
- Fixed development/CI isolation: debug builds reject native checks, and the unsigned CI overlay clears the production updater key and endpoints. `createUpdaterArtifacts=false` alone only controls generated artifacts, not receiving updates. Production publication requests without Windows upgrade evidence now fail preflight rather than silently succeeding with a skipped publish job.
- Fixed a data-loss path before installation: failed final-block writes previously discarded the partial interval while a stop could still save. Collection now stops immediately while final time, app usage and the original stop timestamp remain retryable. The durable session marker and explicit pending-stop gate prevent installation until writes succeed. Start/sign-out remain blocked, same-account sign-in renewal stays available, and the UI no longer reports all records synced while a stop is unsaved. Failed block and failed stop writes were injected separately, recovered without invented time or duplicate records, and covered by native tests.
- Passed 32 portable Rust tests, formatting, strict all-target Clippy, 17 release/signature tests using real minisign for the authenticity boundary, the desktop production frontend build, and actionlint for both Windows workflows. The real React updater page passed 29 browser checks in Chromium headless shell, including missing-feed guidance and pending-stop gates. Its IPC is mocked, so this is frontend evidence only. Full Chrome's headless dump stalled on this host and was stopped before rerunning successfully with headless shell.
- The actual shared Caddy configuration passed local-container HTTP acceptance: exact manifest/installer bytes, production/staging separation, cache headers, missing/hidden paths as 404, SPA isolation, and rejected writes. These local files are fixtures, not production publication evidence.

Remaining acceptance constraint: this macOS environment cannot execute the real Windows installed-old-version to signed-new-version upgrade, installer cancellation, restart, login/SQLite preservation, or native stalled-download recovery. The changed publication preflight was linted but not dispatched. No signing keys were changed, no release version was reused or published, and neither live feed was enabled. Complete the connected-Windows gates in `AUTO-UPDATE-PLAN.md` before publishing the first production manifest. Final intervals that cannot be written due to disk failure are retained in memory for retry, not protected against forced process termination or power loss. The optional Velvet worklog is not linked in this repository (`velvet whoami` reports no `velvet.yaml`).

## Redesign and mandatory location/diagnostics (source only, not deployed)

Commits `063bd96` (desktop) and `911c904` (dashboard and `GET /api/reports/day`) implement the approved mock in `docs/mockups/index.html`.
Location and diagnostics are now mandatory in the desktop app. The opt-in commands are removed, diagnostics turn on at sign-in, and Start is refused until Windows location permission is granted.
All 28 portable Rust tests and strict all-target Clippy passed on macOS. All Go tests passed with race detection against disposable PostgreSQL 17, including a new day-spans test for worker scoping, deleted blocks and absence of screenshot keys. Twelve dashboard unit/API tests passed, including the zone-aware ribbon helper. Both production frontend builds passed.
Chromium via Playwright passed 27 desktop mock-IPC checks three times, and 20 owner, 14 manager (five consecutive runs) and 11 worker dashboard checks at 375px. A real 375px probe found no element wider than the viewport.
Not yet exercised: native Windows location permission prompts, the `ms-settings:privacy-location` shortcut, a signed installer, or production deployment. The new Windows build must ship with an updated monitoring notice and policy review because location and diagnostics can no longer be refused inside the app.
GitHub CI: Windows agent run `39638996208` passed native `cargo check --all-targets`, `cargo test` and an unsigned NSIS build for `53b5cdb`, and installer smoke `39642733235` passed. CI run `39639402254` at `ff5bc56` (includes the redesign) passed web, Go and deployment-config jobs.
Real-path acceptance: `WT_BROWSER=1 WT_PLAYWRIGHT_DIR=<dir with playwright-core> bash scripts/container-acceptance.sh` built the production web and API images, served them over HTTPS with PostgreSQL, and passed every existing journey plus two new ones. `integration.mjs` now checks `/api/reports/day` through the public API: the owner sees the worker's 60-second span on its Asia/Kolkata date, no signed URLs appear, the worker sees only their own spans, and an invalid zone returns 400. `dashboard-acceptance.mjs` seeds two invited workers through the device API, one tracking now with two runs and one stopped. It then signs in through the real login form in Chrome at 1440px and 375px. Each ribbon showed the right segment count, a green live segment only for the tracking worker, the status line and the total. Selecting the live worker loaded its two blocks with "0h 20m tracked, 50% input activity", and the timesheet total read 0h 20m. There was no horizontal overflow at either width, and a worker sign-in showed only their own day with no team ribbon.
Still not exercised: real Windows location permission, real R2 screenshot images in tiles, and production deployment.

## Review fixes (source only, not deployed)

Fixes found in a code review: a refused record could block the desktop queue forever, schema changes could not reach existing databases, accounts could not be offboarded, reports used UTC days only, the login limiter put every client behind Caddy into one bucket, and blocks were accepted without checking that the screenshot object existed.
- Migrations: `schema_migrations` runs each numbered file once. `001_init.sql` stays idempotent, so an existing database adopts it. `003` replaces the `agent_logs` code constraint. Applying the migrations twice and against a pre-existing test database both passed.
- Accounts: disable/enable, device revocation, one-time 24-hour reset links and self-service password change. Covered by Go integration tests for role boundaries, credential revocation, session closure without added time, single-use/newest-only links and disabled-user lockout.
- Reports: optional IANA `tz`. Tests cover an IST block split at 18:30 UTC, plus the existing UTC boundaries for JSON and CSV. Go embeds tzdata because the Alpine image has no zoneinfo.
- Rate limiting: `TRUSTED_PROXIES` with right-to-left `X-Forwarded-For` parsing. Unit tests cover spoofed prefixes, chained proxies and malformed headers. Compose trusts private ranges. The shared Caddyfile trusts private ranges and passed `caddy validate`.
- Uploads: block finalization HEADs the object. A missing object returns `upload_expired`, so existing agents re-upload with no client change.
- Agent: a 24-hour refusal streak sets the head record aside into a capped local table. Rust tests cover hold, release, streak reset and the status codes that count as permanent. All 28 Rust tests and strict Clippy passed.
- Dashboard: the browser time zone is sent as `tz`. There are member admin controls, a `/reset` page and a password change form. A real-browser run (Chromium, 375px, Asia/Kolkata) against the local API and PostgreSQL 17 checked the tz request, reset link creation, disable/enable, reset-page password set, worker sign-in, a self-service change, the absence of worker admin controls and no horizontal overflow. 11 web unit tests passed.

Deploy order: API first, because older agents and dashboards stay compatible and the new `sync_rejected` code needs migration 003 before a new agent sends it. Then deploy the dashboard, then ship a new signed agent. Take and restore-test a backup first as usual. These changes have not been deployed or built into a signed installer.
`scripts/container-acceptance.sh` passed with the production images: read-only, nonroot, HTTPS through Caddy with `TRUSTED_PROXIES` set. It now also covers the `tz=Asia/Kolkata` report (embedded tzdata in Alpine), rejection of an invalid zone, device revocation, a single-use reset link, the disable/enable lockout, the owner's protection against disabling themselves, and ingestion of the `sync_rejected` log. The existing 25-worker journey still passed.
Upgrade check: the deployed API binary (`b95de0e`) wrote users, a device credential, a session and a block to a fresh PostgreSQL 17. The new binary then started on that database. It adopted `001` and applied `002` and `003`. Counts stayed the same (2 users, 1 block, 2 credentials), and the pre-upgrade device token still authenticated. Retrying the pre-upgrade block was idempotent, and a restart applied nothing again.
Not exercised: the desktop agent on Windows (sync set-aside, the rejected count UI) and a live S3/R2 HEAD. The HEAD path was covered only by the fake S3 in the Go tests.

## Diagnostic logging source follow-up

The source now includes separately opted-in desktop diagnostics, device-authenticated ingestion, seven-day live-database retention, and an owner-only dashboard viewer.
Payloads allow only fixed failure codes, UUIDs, timestamps, numeric HTTP status, and a numeric app version. Raw error strings and unknown fields are rejected rather than redacted heuristically.
The memory-only 100-event buffer and independent sender do not use the durable tracking queue. Tests cover consent, deduplication, overflow/acknowledgement, expiry, retrying stable IDs, and consent changes during an in-flight upload, with the tracking mutex available during HTTP.

All nine Go tests passed with race detection against disposable PostgreSQL 17, including diagnostic device/browser authorization, owner/manager/worker read restrictions, body validation, idempotency, request and persistent storage budgets, bounded reads, and retention.
All 22 portable Rust tests and strict all-target Clippy passed. Both frontend production builds and seven dashboard API/utility tests passed.
Chromium ran 22 desktop UI harness checks, including diagnostic opt-in/status/opt-out during an update reservation.
The real dashboard passed eight owner and two checks each for manager/worker with mocked APIs at 375px width, including escaped names, explicit loading, empty results, and error recovery.
The production-image HTTPS container journey passed real diagnostic ingestion/deduplication, owner-only reads, and free-form text rejection, plus the existing 25-worker tracking/report journey.

At this source checkpoint, the feature had not yet been deployed or included in a new signed Windows installer. The subsequent deployment below ships it without changing the immutable v0.1.2 download.
Pending diagnostics are intentionally lost on exit, overflow, or sign-in changes, and pre-sign-in/startup/crash errors are not remotely captured.

## Desktop deadlock and screenshot-state hotfix v0.1.5

Source `12dbe5bf44832259401f099c807092f81ad191fe` fixes the collector/UI lock inversion, moves status snapshots off the UI thread, coalesces pending status polls, and distinguishes time-only/deleted/unavailable screenshot states.
All 26 Rust tests and strict Clippy passed, including a regression asserting that tray notification can reacquire Runtime and unchanged states are not reposted while failed updates remain retryable. All Go tests passed with race detection against disposable PostgreSQL, including each screenshot response state and permissions/deletion. Both frontend builds, ten web tests and all twelve updater Python tests passed.
Chromium passed 27 desktop mock-IPC checks and 15 owner/nine manager/nine worker dashboard checks at 375px, including real synthetic JPEG decoding and time-only dialog labels. Production-image HTTPS acceptance and the existing 25-worker journey passed.
Protected workflow `39619325968` passed native Windows tests, signed installer build, exact fresh install/startup plus responsive-main-window checks and independent Ubuntu signature verification. Local verification used the committed public key and exact trusted version/production URL. Installer: 3,928,439 bytes, SHA-256 `0ed92d211340e34d9228b5d3d434e6463ac8507102f3a2ac85ad633479935638`.

Live DB diagnosis found two 30-second worker time blocks from a one-minute session, with no screenshot keys. No image was missing. A live-storage-settings probe uploaded/downloaded/checksummed/decoded a separate 16x16 JPEG and removed it without touching worker images or records.
An encrypted backup was restored successfully with 2 users/6 sessions/6 blocks. API deployed 14:48 UTC and web 15:09 UTC on October 21, 2026, with no schema/capture-cadence change. Live API returned `not_captured` for both existing worker records, and a real 375px owner browser verified labels, scheduling explanation, matching modal and v0.1.5 download link. Anonymous download integrity/headers and old installer checksums passed; temporary credentials were revoked.
Both containers remain healthy with unchanged limits and no restarts/OOM events. Database/shared proxy were not recreated. GitHub preview `v0.1.5` targets exact build source; no automatic-update manifest was published.
Real-PC ten-minute capture/location and old-to-new identity/data-preserving upgrade acceptance remain unverified. An open session is not proof of uploaded time. See deployment/download docs for rollback and frozen-process data-loss caveats.

## Screenshot location/application implementation and deployment

Source `9fb9e13be99e72cf586dc8eae5c177da546a09e9` adds optional screenshot-linked Windows geolocation and foreground executable usage during tracking.
All 11 Go tests passed with race detection against disposable PostgreSQL 17, including metadata validation/range/freshness, authorized timeline access, immutable retries, and erasure on screenshot/block deletion without retry resurrection. Legacy payloads still pass.
All 25 portable Rust tests and strict Clippy passed, including application aggregation/bounds, capture-only location records, no collection while stopped/locked/suspended, fresh-coordinate validation, consent-generation changes during an in-flight fix, tracking-mutex isolation, timeout fallback, and late-result protection. Both frontend builds and nine dashboard unit/API tests passed.
Chromium passed 26 desktop mock-IPC checks and 11 owner/five manager/five worker dashboard checks at 375px width. These covered app-minute totals, zero coordinates/accuracy, disabled/unavailable locations, screenshot-dialog association, default-off consent, opt-in, and opt-out during update reservation.
The production-image isolated HTTPS journey passed application-data persistence/path/duration validation plus the existing 25-worker tracking/report acceptance.

Protected workflow `39609351264` passed native Windows tests, signed NSIS build, exact installer fresh install/startup, and independent Ubuntu verification. The downloaded candidate was reverified locally against the committed key, exact version, production URL, and SHA-256.
The v0.1.4 manual installer is 3,923,241 bytes with SHA-256 `f45a1c10de9a5264470bdc2fcda0bd3cbbbbec957fdb6bb2b2310ba363099119`. GitHub preview release `v0.1.4` targets the exact build source.

After a successfully restored encrypted pre-deployment backup, API deployed at 13:39 UTC and dashboard at 13:55 UTC on October 21, 2026. Live checks covered app/location validation, legacy reads, screenshot upload authorization, login/revocation, new installer bytes/checksum/headers, unchanged old installers, and a real 375px owner dashboard with the new application panel and download link.
User/session/block counts remained 2/4/4; no real tracking/location/app-use records were created for acceptance. Services stayed healthy with no restarts/OOM events, original limits, no new public ports, and no database/shared-proxy recreation. WorkTrack, OMS, and portal remained HTTPS 200.
No automatic-update manifest was published. Real connected-Windows geolocation accuracy, capture/lock/suspend, and old-to-new upgrade preservation remain unverified. Location denial/unavailability is expected on unsupported or policy-restricted PCs and must not be bypassed.
See `deploy/SHARED-HOST.md` for the critical API rollback compatibility warning and backup/rollback paths, and `deploy/DOWNLOADS.md` for installation/consent instructions.

## Diagnostic deployment and signed Windows release

On October 21, 2026, production API/dashboard images built from `fb46c07483dadb6309306ba087d5dcc33e113186` were deployed API first (12:38 UTC), then dashboard (12:58 UTC).
An encrypted off-host pre-deployment database backup restored successfully into isolated PostgreSQL 17. Tracking counts remained 2 users, 4 sessions, and 4 blocks; the database/shared proxy were not recreated.

Protected production-channel workflow `39600736918` passed native Windows Rust tests, signed NSIS build, exact installer fresh-install/startup smoke, and independent Ubuntu signature/version/checksum verification.
The downloaded candidate was independently verified locally against the committed key before manual publication at `/downloads/0.1.3/WorkTrack_0.1.3_x64-setup.exe`.
Its 3,890,558 bytes have SHA-256 `28e0a0b88a34292fa2272f53e2794ed98f0f0ec1f238d8e9f506d41a4aeb279f`.
Both ordinary CI (`39600731183`) and Windows build/test CI (`39600731230`) passed for the same source.

Public HTTPS tests passed actual device diagnostic ingestion, duplicate retries, owner reads, browser-upload rejection, free-form text rejection, authenticated session reads, and browser/device logout revocation.
Only one synthetic log event was inserted and then removed by its exact owner/event UUID; no tracking records or passwords were changed.
New installer bytes/checksum, attachment/cache headers, dashboard link, hidden/missing/directory 404s, and unchanged v0.1.2 checksum passed through public HTTPS.
Live Chromium at 375px width passed existing-owner sign-in, v0.1.3 download link, no automatic diagnostic fetch, explicit log loading, real empty state, and no full-page horizontal overflow. Its session was revoked afterward.
WorkTrack, OMS, and portal remained HTTPS 200, with healthy WorkTrack containers, zero restarts/OOM events, unchanged resource ceilings, and no new public ports.

No automatic-update manifest was published, and `/updates/windows/x86_64/latest.json` still returns 404.
Real worker capture/lock/suspend, installed-app diagnostic delivery, and old-to-new identity/data-preserving upgrade acceptance still need a connected Windows PC. Installer startup smoke is not proof of those journeys.
Deployment, backup, rollback, installer signature, and consent instructions are recorded in `deploy/SHARED-HOST.md`, `deploy/DOWNLOADS.md`, and `agent/README.md`.

## Audit-fix deployment follow-up

API and dashboard source `f60d9604852dbdfeffcc077992ccf3786cf029ca` was deployed to the existing shared Hetzner host at approximately 11:35 UTC on 2026-10-21.
The API was replaced and checked before the dashboard. The new report index is valid, both services are healthy with zero restarts/OOM events, and their resource limits and private networking remain enforced.
Database and shared-proxy container identities were unchanged, as were counts of users, sessions, and blocks.
The exact published v0.1.2 installer and checksum are unchanged.

Before replacement, an encrypted off-host custom-format database dump was restored successfully into an isolated disposable PostgreSQL 17 instance, with matching row counts.
Recovery identity and encrypted dump are stored outside git on the developer machine, as documented in `deploy/SHARED-HOST.md`. The recovery identity still needs protected offline storage.
This proves database-dump restoration, not screenshot-object recovery or a scheduled backup service.

Post-deployment HTTPS checks passed for the recovery UI bundle, current-session reads, JSON/CSV reports, device logout and revoked-token rejection, the existing installer bytes/cache policy, and missing/hidden/directory 404s.
Authenticated reads used one labelled five-minute test credential that was revoked and removed after the checks. No account password, tracking record, or production session was changed.
Both unrelated public applications remained HTTPS 200.
Old API/web images and a host-only rollback overlay are retained.

The source desktop logout fix has not shipped in the immutable v0.1.2 installer. A new versioned, signed Windows installer remains required, and no update feed was published.

## Updater source implementation follow-up

The new source implements Windows-only update checks, explicit worker-approved installation, and a Rust-side exclusive installation reservation.
The existing released 0.1.0 and 0.1.1 installers are unchanged and cannot discover updates.
The committed development configuration deliberately has no public signing key and cannot install updates.

Local frontend TypeScript and production build passed after integration.
The committed `agent/tests/updater.html` harness passed all 16 checks in Firefox against the real React app with mocked Tauri IPC.
Observed cases included startup and six-hour scheduling, version/notes display, Later without installation, active-tracking and queued-data blocking, stale-offer removal, explicit installation arguments, progress, failure recovery, reserved sign-in controls, and neutral unavailable-build messaging.
This validates frontend interactions, not native updater behavior or Windows installation.
All 15 Rust tests passed, including six updater tests for active/paused sessions, pending queue and stop markers, unreadable SQLite tables, exclusive mutation admission, quit admission, and reservation release after failure.
Strict all-target Clippy passed.
An independent cross-model source review found no blocking issue in the reservation race, frontend capability restrictions, signature/version checks, or default-disabled configuration.
The shared staging/production signing-key trust limitation is documented in `deploy/UPDATES.md`.
Linux CI run `39569652459` passed on source commit `86efd51`, including Go/PostgreSQL race tests, real API acceptance, dashboard tests/build, Docker builds, actual minisign boundary tests, Caddy update hosting, and the existing production HTTPS container journey.
The real release CLI also refused the committed legacy/unconfigured build before generating a release overlay.
Native Windows run `39569652544` passed all-target compilation, Cargo tests, unsigned NSIS release packaging, and artifact upload on the same source commit.
Its `windows-nsis-unsigned` CI artifact is a development validation build with no updater key, not a new published updater-enabled release.
Windows installer smoke run `39571471042` then passed per-user installation and five-second application process survival using that upstream artifact.
That is native packaging/startup evidence, not a signed in-app upgrade or a worker-data-preservation test.
Twelve release-plumbing tests passed for version validation, signature-version binding, archive restrictions, failed-public-download recovery, immutable artifacts, publication locking, interruption recovery, and rollback prevention.
Four additional tests exercised the actual `minisign` CLI through the release verifier in an isolated Python 3.12 Alpine container.
A public upstream Tauri test signature was accepted, while modified payload bytes with a recomputed checksum, a different valid public key, and forged trusted-comment/version metadata were rejected.
These public fixtures contain no private signing key and do not prove installation of a real signed Windows artifact.
The actual Caddy shared-host configuration passed local container HTTP checks for manifest JSON/cache policy, exact installer bytes, immutable caching, missing/hidden-file 404 responses, SPA fallback, and rejected PUT writes.
These checks do not prove production HTTPS update delivery.

A native macOS Tauri development process compiled and ran for about 75 seconds without an observed startup panic or early exit.
The frontend HTTP endpoint was reachable, but the accessibility bridge could not resolve the native window for interaction.
No native update IPC, Windows installation, restart, or data preservation behavior is claimed from that startup probe.
The isolated probe was stopped without signing in or starting monitoring.

No production signing key or protected GitHub release environment was available during implementation.
No signed updater-enabled release, public update files, production manifest, restricted deployment accounts, or shared-host changes were created.
The signed staging-to-newer-staging Windows journey, malicious-signature rejection through the installed app, and production delivery remain explicit release gates in `deploy/UPDATES.md`.
The local checks validate implementation and file-serving boundaries, not completion of those externally blocked release gates.

## Windows 0.1.1 release follow-up

Release `v0.1.1` was published from `25196d07ecb4bb08b7ccb83ec1d371de3f0eef64` with `WorkTrack_0.1.1_x64-setup.exe`.
The Rust backend pins the deployed workspace origin and the rendered sign-in form contains only email/password, not a server URL input.
Nine local Rust tests, frontend build and strict Clippy passed.
Native Windows run `39564341709` passed compilation, nine tests, NSIS packaging and artifact upload.
Separate installer run `39567029465` completed silent per-user installation and five-second process survival at 08:08:47 UTC.
Installer SHA-256: `adc9a32444ba8a27399f6ae2840f04348281f92b6d6e8e845b6bd28b6b5585f9`.
GitHub reported the same digest on the uploaded release asset.
The application identifier and storage paths are unchanged, and pending records from a different origin are not migrated into the pinned workspace.
Neither 0.1.0 nor 0.1.1 implements automatic update checks or notifications.
Workers must stop, sync, quit and run the new installer manually.
Actual Windows login/capture and an in-place upgrade with existing worker data are not claimed verified by the fresh-install smoke.

## Live deployment follow-up

WorkTrack was deployed to the existing approved `neuskale-app-ash` VM on 2026-10-21.
The approved hostname `worktrack.178.156.213.40.sslip.io` serves the rendered React login page with valid HTTPS.
Owner login, device login, reports and an actual private Cloudflare R2 PUT/GET round trip passed through the public application API.
A synthetic JPEG-marker object was used and the associated test block was deleted, so this does not prove Windows screen capture.
Screenshot-only deletion preserved time, anonymous object access was rejected, and test auth tokens were revoked.
After removing bootstrap settings and recreating the API, the original owner credentials still logged in.
Both pre-existing public apps remained HTTP 200 with valid TLS.
The complete live workflow was rerun after final bootstrap removal at 07:39 UTC and passed again.
Additional real-interface checks observed unauthenticated team reads returning 401, hostile or absent Origin cookie mutations returning 403, SPA deep links loading, old signed image URLs returning 404 after deletion, and both revoked token types returning 401.
All three WorkTrack containers were healthy with zero restarts, no OOM events, enforced memory limits and no published host ports.
The short owner password was explicitly approved by the user and remains a security limitation.
See `deploy/SHARED-HOST.md` for image revisions, resource limits and remaining backup/runtime gates.
The following initial validation record predates this deployment, so statements about unavailable Hetzner access below are historical.

## Passed locally

- Go API compiled, `go vet ./...` passed.
- `WT_TEST_DATABASE_URL=... go test -race ./...` passed against disposable PostgreSQL 17.
- `scripts/integration.mjs` passed against a running HTTP server and real PostgreSQL.
  It exercises browser-cookie login, invite creation and acceptance, device tokens, worker access restrictions, session start and stop, exact-duration blocks, immutable retries, invalid activity rejection, hour totals, CSV export, screenshot-only deletion preserving hours, explicit time deletion and logout token revocation.
- Dashboard TypeScript checks, production Vite build and utility tests passed.
- A real Firefox session completed owner login, team selection, a one-minute timeline with 50% input activity and matching weekly totals.
- The browser created an invitation, logged out, accepted that invitation, and signed in as the new worker.
  The worker view hid the team and invite controls and displayed only that worker's report.
- Desktop frontend TypeScript and production build passed.
- Rust desktop code compiled on macOS and eight tests passed.
  These cover stopped/locked/suspended scheduling, fixed 600-second capture boundaries, whole-second partial stops, SQLite transaction rollback, queue persistence, retrying finalized blocks without uploading the screenshot again, and reuploading retained evidence after an expired upload reservation.
- `bash scripts/container-acceptance.sh` passed against the actual production Docker images.
  It started isolated, nonroot, read-only Caddy and Go containers with real PostgreSQL, reached the public HTTPS endpoint, used a process-scoped trusted local CA, completed the full authentication/invite/tracking/report/deletion workflow through Caddy, and fetched the React SPA invite route.
  Production `DEV_MODE=false` was used, so the browser session cookie had its production Secure policy.
  This is an end-to-end server deployment check, not a copied or stubbed API.
- The same production HTTPS acceptance run created 25 actual invited test users and device tokens.
  Concurrent heartbeats showed all 25 as working, each user's report contained exactly 60 seconds, CSV included all 25, and concurrent stops changed all 25 to not working.
  This is functional acceptance for the expected team size, not a throughput or latency benchmark.
- Go production Docker image built successfully.
- Dashboard Docker image built and its nonroot, read-only Caddy startup, SPA fallback, HTTPS, health and public redirect smoke tests passed.
- A review reproduced a 48-hour offline upload failure against real PostgreSQL.
  The fix extends unfinalized upload grace to eight days, beyond the seven-day data acceptance window.
  A regression now checks that delayed screenshot finalization survives cleanup.
- Deployment worker validated Compose and Caddy configuration and shell syntax.
  A hardened Caddy smoke test caught and fixed an incompatible file capability before commit.

## GitHub CI

- Linux CI run `39556205956` passed on commit `c8cf00a`, including real PostgreSQL race tests, public HTTP acceptance, Docker/Caddy smoke and the production HTTPS container journey.
- Native Windows run `39555423364` passed on application commit `464f774`.
  All-target compilation, eight Rust tests, unsigned NSIS release packaging and artifact upload succeeded.
  Subsequent changes through `c8cf00a` affect verification/deployment configuration, not desktop application source.
- Installer workflow run `39557691598` downloaded that artifact, silently installed it per user on Windows, verified the executable and launched it successfully for five seconds.
  The installer smoke passed at 06:48:24 UTC.
  Process survival proves installation/startup only, not tracking state or screenshot capture.
- Artifact: `windows-nsis-unsigned`, installer `WorkTrack_0.1.0_x64-setup.exe`.
  Downloaded installer SHA-256: `b1dff44d7b0acf68daba7a5db87198cf327b9857168223ca8ab1c3a34718efeb`.
  CI artifacts expire after seven days, so a permanent release still needs an approved distribution process.
- All six Go tests against PostgreSQL and all eight Rust tests passed after offline-recovery fixes.

## Test limitations

- Rust tests simulate clock and lock inputs.
  They are not proof that Windows screenshots, secure-desktop detection or suspend notifications work on a real worker PC.
- Storage integration tests use a local fake S3 endpoint.
  Hetzner bucket permissions, browser CORS, lifecycle expiry and actual screenshot upload still need deployment acceptance testing.
- No production Hetzner server or bucket has been provisioned.
- No real worker screenshots or credentials were used.
- Signing, updates and autostart are not approved release features until the desktop README release checklist passes.
- Account recovery, device management and stronger authentication need further work before a broad production rollout.

## Explicit external acceptance constraints

The development machine is macOS and there is no connected interactive Windows worker PC or Windows VM available to this session.
The desktop deliberately refuses monitoring on non-Windows platforms, so running it on macOS cannot validate screenshots.
GitHub Windows compilation and installer smoke can verify packaging, but cannot substitute for the lock/suspend and ten-minute screenshot journey on an interactive worker desktop.
That part of acceptance is externally blocked until a Windows test machine is available.
No Hetzner access, domain or private bucket configuration has been supplied for production provisioning, so the actual Hetzner storage boundary is also unverified.
The local production-image HTTPS test closes the server deployment feedback loop without pretending those external checks passed.

## Before a worker pilot

1. Download the verified Windows installer and complete interactive acceptance on a clean Windows 11 PC.
2. Configure private Hetzner Object Storage with the approved retention period and narrowly scoped credentials.
3. Verify a real capture arrives after ten active minutes and is visible only to authorized users.
4. Stop tracking and verify that no more screenshots are produced.
5. Test lock, sleep, resume, network loss, reboot, token expiry and full disk behavior.
6. Verify screenshot deletion removes evidence while keeping time, and explicit time deletion changes reports.
7. Restore a database backup into an isolated environment.
8. Review notice, access policy, retention and Windows security policy before inviting real workers.
