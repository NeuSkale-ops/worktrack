# Validation record

Date: 2026-10-21.
This records observed checks, not a production-readiness claim.

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
Linux CI run `39569652459` passed on source commit `86efd51`, including Go/PostgreSQL race tests, real API acceptance, dashboard tests/build, Docker builds, actual minisign boundary tests, Caddy update hosting, and the existing production HTTPS container journey.
The real release CLI also refused the committed legacy/unconfigured build before generating a release overlay.
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
