# Validation record

Date: 2026-10-21.
This records observed checks, not a production-readiness claim.

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
