# Shared Neuskale host deployment

Host: `neuskale-app-ash` (`178.156.213.40`).
Approved hostname: `worktrack.178.156.213.40.sslip.io`.
Application image source: `ae8b8f8`.

## Layout

`compose.shared.yaml` overlays `compose.yaml` for this existing shared host.
The existing `oms_shared_caddy` remains the only public listener on ports 80 and 443.
WorkTrack web joins the external `oms-network` with alias `worktrack-web`.
The API and database remain on WorkTrack-only networks.
The shared proxy should forward the approved hostname to `worktrack-web:8080` only after all WorkTrack services are healthy.
Use `Caddyfile.shared` for the internal WorkTrack static server.

Resource ceilings are 256 MiB for PostgreSQL, 512 MiB for Go and 96 MiB for web.
These are limits, not reserved memory or proof of peak-load capacity.
Build AMD64 images away from this memory-constrained host.

## Protected configuration

Secrets are supplied locally through envkit and transferred over verified SSH into `/etc/worktrack/compose.runtime.json` with mode 0600 inside a mode-0700 directory.
This runtime file is not source code and must never be committed or printed.
The database password is independently generated and is not the owner login password.
The owner bootstrap password must contain at least 12 characters.
Remove bootstrap variables from the protected runtime configuration after first successful owner login and recreate only the WorkTrack API.

## Observed state, 2026-10-21

AMD64 production images were built and loaded on the host.
The isolated WorkTrack database started and passed its health check.
API startup correctly rejected the supplied bootstrap password because it was shorter than 12 characters.
Only the failed WorkTrack API was stopped to avoid restart churn.
The shared public proxy has not been changed, so no deployed WorkTrack URL is available yet.
Resume after the owner supplies a compliant initial password through `envkit set BOOTSTRAP_PASSWORD`.
Do not weaken password validation to complete deployment.

Backups and actual Windows capture/lock/suspend acceptance remain required before a worker pilot.
