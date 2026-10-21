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
- Go production Docker image built successfully.
- Dashboard Docker image built and its nonroot, read-only Caddy startup, SPA fallback, HTTPS, health and public redirect smoke tests passed.
- A review reproduced a 48-hour offline upload failure against real PostgreSQL.
  The fix extends unfinalized upload grace to eight days, beyond the seven-day data acceptance window.
  A regression now checks that delayed screenshot finalization survives cleanup.
- Deployment worker validated Compose and Caddy configuration and shell syntax.
  A hardened Caddy smoke test caught and fixed an incompatible file capability before commit.

## GitHub CI

- Linux CI passed on commit `c0f2f98`, including real database tests, HTTP acceptance and Docker/Caddy smoke tests.
- Windows compilation and NSIS packaging are running in GitHub Actions.
  Do not interpret portable macOS compilation as a successful Windows build.
- Offline-recovery changes after that CI snapshot were rerun locally with all six Go tests against PostgreSQL and all eight Rust tests passing.
  The latest pushed revision must also pass CI before release.

## Test limitations

- Rust tests simulate clock and lock inputs.
  They are not proof that Windows screenshots, secure-desktop detection or suspend notifications work on a real worker PC.
- Storage integration tests use a local fake S3 endpoint.
  Hetzner bucket permissions, browser CORS, lifecycle expiry and actual screenshot upload still need deployment acceptance testing.
- No production Hetzner server or bucket has been provisioned.
- No real worker screenshots or credentials were used.
- Signing, updates and autostart are not approved release features until the desktop README release checklist passes.
- Account recovery, device management and stronger authentication need further work before a broad production rollout.

## Before a worker pilot

1. Get the Windows installer through the Windows CI workflow and test installation on a clean Windows 11 PC.
2. Configure private Hetzner Object Storage with the approved retention period and narrowly scoped credentials.
3. Verify a real capture arrives after ten active minutes and is visible only to authorized users.
4. Stop tracking and verify that no more screenshots are produced.
5. Test lock, sleep, resume, network loss, reboot, token expiry and full disk behavior.
6. Verify screenshot deletion removes evidence while keeping time, and explicit time deletion changes reports.
7. Restore a database backup into an isolated environment.
8. Review notice, access policy, retention and Windows security policy before inviting real workers.
