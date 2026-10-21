# Shared Neuskale host deployment

Host: `neuskale-app-ash` (`178.156.213.40`).
Approved hostname: `worktrack.178.156.213.40.sslip.io`.
API image source: `641cf6b`.
Web image source: `31c783e`, deployed as `worktrack-web:downloads-0.1.2`.

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
The owner bootstrap password normally must contain at least 12 characters.
For this deployment the user explicitly approved a shorter initial password using `ALLOW_WEAK_BOOTSTRAP_PASSWORD=true`.
The exception and bootstrap credentials were removed from the protected runtime file and running API after successful login.
This did not reset an existing password or weaken invitation password validation.

## Observed state, 2026-10-21

AMD64 production images were built and loaded on the host.
The isolated database, API and web containers are healthy.
The shared proxy configuration was backed up to `/opt/neuskale/Caddyfile.before-worktrack-20261021`, validated, then gracefully reloaded with an additive WorkTrack route.
The approved hostname serves the actual React login page with valid HTTPS.
Owner cookie login, device login, team reads, CSV, actual R2 signed PUT/GET and anonymous-access rejection passed through public interfaces.
A minimal JPEG-marker fixture was used for storage acceptance, not an actual worker screenshot.
Screenshot-only deletion preserved the one-second test block, and the test time block was then removed.
Test device/browser tokens were revoked.
After bootstrap settings were removed and the API recreated, the original owner password still logged in successfully.
Existing OMS and portal sites continued returning HTTP 200 with valid HTTPS.
The VM had about 1.5 GiB available RAM after deployment in a short snapshot, not a peak-load guarantee.

## Operation

Run `docker compose -p worktrack -f /etc/worktrack/compose.runtime.json -f /opt/worktrack/deploy/compose.downloads.yaml ps` on the VM to inspect only this deployment.
Use both files for future web updates to retain the deployed image and read-only installer mount.
Do not print the runtime configuration because it contains storage and database credentials.
No public database or API ports are published.
No backup schedule or restore drill has been completed.
The user-selected short owner password remains a known security limitation.

Backups and actual Windows capture/lock/suspend acceptance remain required before a worker pilot.
