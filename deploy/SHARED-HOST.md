# Shared Neuskale host deployment

Host: `neuskale-app-ash` (`178.156.213.40`).
Approved hostname: `worktrack.178.156.213.40.sslip.io`.
API and web image source: `12dbe5bf44832259401f099c807092f81ad191fe`.
Deployed images: `worktrack-api:12dbe5b` and `worktrack-web:12dbe5b`.
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

At this audit-fix deployment, the published Windows installer remained v0.1.2 with its original immutable bytes. The subsequent diagnostics release below ships the desktop logout fix. No update manifest was published.

## Diagnostic logging deployment, 2026-10-21

Source `fb46c07483dadb6309306ba087d5dcc33e113186` was built for AMD64 off-host. The API was deployed at 12:38 UTC, then the dashboard at 12:58 UTC after the new installer was verified and published.
Both containers are healthy with zero restarts/OOM events, original memory limits, correct revision labels, and no public API/database ports.
The database and shared HTTPS proxy were not recreated. Tracking counts remained 2 users, 4 sessions, and 4 blocks.
The new `agent_logs` table and indexes were created by the existing idempotent migration.

Public HTTPS acceptance used the existing owner account and temporary browser/device sessions. Device-only log ingestion, retry deduplication, owner reads, free-form text rejection, session reads, and device/browser revocation passed.
Only one synthetic diagnostic event was created and then removed by its exact owner/event UUID. No worker tracking records, passwords, or real sessions were changed.
Installer/download and live owner-dashboard acceptance are recorded in `DOWNLOADS.md` and `docs/VALIDATION.md`.
WorkTrack, OMS, and portal continued returning HTTPS 200. The immutable v0.1.2 installer checksum is unchanged, and no automatic-update manifest was published.

Pre-deployment encrypted backup: `~/.local/share/worktrack-backups/20261021T123549Z-fb46c07.dump.age`.
It was restored into isolated disposable PostgreSQL 17 with matching user/session/block counts.
Its recovery identity is the existing mode-0600 `20261021T113204Z-f60d960.agekey` in that directory, not a new key. Preserve a protected offline recovery copy. Screenshot objects are not part of this database backup.

For application rollback, append host-only `/opt/worktrack/deploy/compose.rollback-before-fb46c07.yaml` after the three normal Compose files. Recreate `web` first, then `api`, using `up -d --no-deps --no-build --pull never --wait`.
This selects retained `worktrack-web:f60d960` and `worktrack-api:f60d960` images. The added log table is backward compatible and needs no database restore.
The new manual v0.1.3 installer remains immutable even after server rollback. Diagnostics would receive 404/retry on the older API without blocking tracking. Do not repoint users to a downgrade or overwrite installer bytes.

## Screenshot location/application deployment, 2026-10-21

Reviewed source `9fb9e13be99e72cf586dc8eae5c177da546a09e9` was built for AMD64 off-host and deployed API first at 13:39 UTC, then web at 13:55 UTC after verifying/publishing signed Windows v0.1.4.
The existing migration added nullable `blocks.location` and default-empty `blocks.application_usage` JSONB columns. Older agents remain supported; new agents require this compatible API.
Both containers are healthy, carry the correct revision labels, retain original resource ceilings, have zero restarts/OOM events, and expose no new ports. Database and shared proxy creation timestamps are unchanged.

Tracking counts stayed 2 users, 4 sessions, and 4 blocks. No production location/application records were created for acceptance.
Public HTTPS checks verified new-field validation, legacy timeline reads, upload-reservation authorization, existing authentication/diagnostics, new installer bytes/checksum, new dashboard download/app-use panel, and credential revocation. Temporary diagnostic verification created and removed only its own synthetic event.
WorkTrack, OMS, and portal remained HTTPS 200. Published v0.1.2/v0.1.3 files retain their original checksums. The automatic-update feed remains unpublished/404.

Pre-deployment backup: `~/.local/share/worktrack-backups/20261021T133757Z-9fb9e13.dump.age`, restored successfully into isolated PostgreSQL 17 with matching tracking counts.
Recovery uses existing mode-0600 `20261021T113204Z-f60d960.agekey`. Keep a protected offline recovery copy. This backup does not include screenshot objects.

Retained pre-release images are `worktrack-api:fb46c07` and `worktrack-web:fb46c07`; host-only `/opt/worktrack/deploy/compose.rollback-before-9fb9e13.yaml` selects them when appended after the normal three Compose files.
The schema additions are backward compatible and do not require a database restore. However, do not roll the API back after v0.1.4 workers start uploading: older APIs reject the new block fields. Their queues would remain durable but stop syncing until a compatible API is restored within the seven-day offline window.
Prefer a forward API fix or retain the compatible API while rolling back only web. Never overwrite immutable installer bytes, direct workers to a downgrade, remove app data, or restore over production as an application rollback shortcut.
Real connected-Windows location/capture and in-place upgrade preservation still require worker acceptance; see `DOWNLOADS.md`.

## Combined desktop/screenshot-status hotfix, 2026-10-21

Source `12dbe5bf44832259401f099c807092f81ad191fe` was built for AMD64 off-host. API deployed at 14:48 UTC, web at 15:09 UTC after signed v0.1.5 passed native tests, exact-installer fresh install/responsive-window checks and independent signature verification. No schema or screenshot-cadence change was made.
Both containers are healthy with matching revision labels, zero restarts/OOM events and unchanged resource/port limits. Database and shared proxy were not recreated.

Backup `~/.local/share/worktrack-backups/20261021T144506Z-12dbe5b.dump.age` was restored into isolated PostgreSQL 17: 2 users, 6 sessions, 6 blocks. It uses existing protected `20261021T113204Z-f60d960.agekey`; retain an offline recovery copy. Screenshot objects are not backed up by this dump.
No worker tracking/session state was changed by acceptance. Two existing worker blocks were confirmed `not_captured`, not missing images. A separate synthetic JPEG was uploaded/downloaded/decoded with live storage settings and deleted. Public download and real 375px owner dashboard checks passed with test credentials revoked. Prior installer checksums remain unchanged; automatic-update feed remains 404.

Append `/opt/worktrack/deploy/compose.rollback-before-12dbe5b.yaml` last to select retained `worktrack-api:9fb9e13`/`worktrack-web:9fb9e13`. Recreate web then API with `--no-deps --no-build --pull never --wait` if rollback is needed. That API remains compatible with v0.1.5 block payloads, though screenshot-state UI improvements are lost. Never roll back farther to pre-v0.1.4 APIs that reject app/location fields, overwrite installer bytes, or restore a database for this application-only rollback.
The old desktop can remain frozen with an open server session and no uploads. Do not infer recorded time or close/backfill sessions remotely without explicit worker recovery. Keep app data intact during manual upgrade.
