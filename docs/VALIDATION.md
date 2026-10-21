# Validation record

Date: 2026-10-21.
This records observed checks, not a production-readiness claim.

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
