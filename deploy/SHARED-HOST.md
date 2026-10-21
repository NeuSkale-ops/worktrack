# Shared Neuskale host deployment

Host: `neuskale-app-ash` (`178.156.213.40`).
Approved hostname: `worktrack.178.156.213.40.sslip.io`.
API and web image source: `f60d9604852dbdfeffcc077992ccf3786cf029ca`.
Deployed images: `worktrack-api:f60d960` and `worktrack-web:f60d960`.
Apply `compose.release.yaml` last to retain these images.

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

Run `docker compose -p worktrack -f /etc/worktrack/compose.runtime.json -f /opt/worktrack/deploy/compose.downloads.yaml -f /opt/worktrack/deploy/compose.release.yaml ps` on the VM to inspect only this deployment.
Use all three files, in this order, for future operations to retain the release images and read-only installer mount.
Deploy API changes first with `up -d --no-deps --no-build --pull never --wait api`, then deploy web with the same command ending in `web`.
Do not print the runtime configuration because it contains storage and database credentials.
No public database or API ports are published.
No backup schedule is configured. An encrypted off-host database backup and isolated PostgreSQL 17 restore succeeded before the audit-fix deployment below.
The user-selected short owner password remains a known security limitation.

Scheduled backups, object-storage recovery, and actual Windows capture/lock/suspend acceptance remain required before a worker pilot.

## Audit-fix deployment, 2026-10-21

API and web were replaced in that order at approximately 11:35 UTC, from source `f60d9604852dbdfeffcc077992ccf3786cf029ca`.
Both AMD64 images were built off-host and their revision labels verified after loading.
The new `blocks_report_time` index is valid. Both services are healthy, have zero restarts/OOM events, retain their original memory limits, and publish no host ports.
The database and shared HTTPS proxy containers were not recreated. User, session, and block counts remained 2, 4, and 4.

Public HTTPS checks passed for the new recovery UI bundle, authenticated current-session reads, JSON/CSV reports, device logout/revocation, unchanged installer checksum, and hidden/missing/directory download 404s.
Authenticated reads used one explicitly labelled five-minute deployment-test credential, which was revoked and removed afterward. No passwords or tracking records were changed, and no production session was recovered.
Existing OMS and portal sites remained HTTPS 200.

The encrypted backup is stored outside git under `~/.local/share/worktrack-backups/20261021T113204Z-f60d960.dump.age` on the developer machine.
Its separate mode-0600 recovery identity is alongside it as `20261021T113204Z-f60d960.agekey`, never on the production host. Move that identity to protected offline recovery storage and retain a tested recovery copy.
The backup restored into an isolated disposable PostgreSQL 17 instance with matching row counts. Object bytes were not backed up by this database dump.

Previous images are retained on the host as `worktrack-api:before-f60d960` and `worktrack-web:before-f60d960`.
For application rollback, append `/opt/worktrack/deploy/compose.rollback-before-f60d960.yaml` after all three configuration files above and recreate `web` first, then `api`, with `up -d --no-deps --no-build --pull never --wait`.
This rollback overlay is host-only. The added index is backward compatible and does not require a database restore. Do not delete volumes or restore over production as an application rollback shortcut.

The published Windows installer remains v0.1.2 with its original immutable bytes. The desktop logout fix in source has not shipped to workers and needs a separately versioned signed Windows release. No update manifest was published.
