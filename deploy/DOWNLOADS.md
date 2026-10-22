# Worker installer downloads

The signed-in dashboard reads `/updates/windows/x86_64/latest.json` and offers that production release's Windows x64 installer and adjacent `SHA256SUMS`.
It refreshes on mount, window focus, every five minutes, and explicit retry, without using a cached manifest.
Only a stable version and its canonical same-origin `/updates/windows/x86_64/releases/{version}/worktrack-setup.exe` URL are accepted.
Missing, invalid, or failed metadata hides download links rather than falling back to an old release. A newly published release needs no dashboard rebuild.
Existing workers use their existing email and password after installation.
A new invitation is not required.
Tracking starts only when the worker clicks Start tracking.

Only the production-channel candidate from the signed updater workflow may be used here.
Never substitute a staging installer or an ordinary unsigned CI artifact.
Verify the candidate's signature, version binding, and SHA-256 using `scripts/updater_release.py verify --channel production` before distributing its installer.
The download path is public, versioned, and immutable.
The private GitHub repository does not need to be made public.
No credentials or worker data are stored in the download directory.

## Standalone deployment

The default `compose.yaml` retains the legacy `/srv/worktrack-downloads` read-only mount and `/downloads/*` file routes.
The dynamic card requires the public updater mounts and verified production publication described in `UPDATES.md`; legacy installer files alone do not populate the card.
Use the standalone Compose commands in `README.md`. The shared-host image overlay below is not required.
`deploy/test-web.sh` checks exact fixture bytes, attachment/cache headers, and 404 responses for missing, hidden, and directory paths against the standalone image.

## Shared host deployment

Build the AMD64 web image away from the shared VM and load it using the reviewed release tag in `compose.release.yaml`.
Publish the verified installer and manifest through the guarded updater receiver described in `UPDATES.md`. Preserve existing legacy downloads.
Keep the existing image and Caddy configuration available for rollback.
Deploy the reviewed `Caddyfile.shared` and `compose.downloads.yaml` into `/opt/worktrack/deploy`.
The downloads overlay adds a read-only installer directory mount; the final release overlay selects the current web image.
It does not change the API, database, outer HTTPS proxy, signing secrets, or screenshot storage.

```sh
docker compose -p worktrack \
  -f /etc/worktrack/compose.runtime.json \
  -f /opt/worktrack/deploy/compose.downloads.yaml \
  -f /opt/worktrack/deploy/compose.updates.yaml \
  -f /opt/worktrack/deploy/compose.release.yaml \
  up -d --no-deps --no-build --pull never --wait web
```

Use all four files, in this order, for subsequent web operations so the current release image and public read-only mounts are retained.
The current API/dashboard release is recorded in `SHARED-HOST.md`; the downloads overlay alone still names the older dashboard image.
Never print the protected runtime configuration.
Verify the public HTTPS installer checksum against the verified candidate before announcing availability.
Verify missing download paths return 404, file responses are attachments, listing is disabled, API health is unchanged, and unrelated shared-host sites still work.

For application rollback, use the retained images and rollback overlay documented in `SHARED-HOST.md`.
Preserve published installer bytes and do not overwrite versioned paths with a different build.

## Public acceptance

Run `node scripts/download-acceptance.mjs` on Node 22+ with `WT_DOWNLOAD_BASE` and independently verified `WT_DOWNLOAD_SHA256`.
The script checks the deployed dynamic bundle, current manifest, anonymous exact installer bytes, attachment/cache headers, checksum link, missing/hidden paths, and disabled directory listing.
Existing-account `WT_ACCEPTANCE_EMAIL` and `WT_ACCEPTANCE_PASSWORD` are optional and must be supplied together through a protected environment. With them, the script also checks login and authenticated API, then revokes only its own session. Without them, it explicitly skips login checks.
It does not create workers or change tracking records.
Never include credential values in shell arguments or logs.

## Observed deployment, October 21, 2026

Production-channel signed build `39585141690` succeeded from `53792b70a0f0a75aaa5aa1d67e3ba14be41db578`.
The exact installer passed native Windows installation/startup smoke and independent signature, trusted-version, and checksum verification.
The downloaded production candidate was independently verified again locally, including matching its public key to the reviewed configuration and checking its production manifest URL.
The dashboard image was built from web source `31c783e` for AMD64 and deployed as `worktrack-web:downloads-0.1.2`.
The download overlay was activated on the shared host at approximately 10:55 UTC.

The installer is 3,871,906 bytes.
Its SHA-256 is `23f1e7ec845e49c2123c72cc2d2abe3bcf32350e534c1565ec74b201a4bfe9ff`.
Real public HTTPS acceptance passed for existing-account login, authenticated API access, deployed React download entry point, anonymous installer bytes/checksum, attachment/cache headers, checksum link, missing/hidden paths, and disabled listing.
The acceptance login session was revoked afterward.
The installer mount is read-only.
WorkTrack, OMS, and portal all returned HTTPS 200 after activation, and the API/database remained healthy with their original creation timestamps.
Real Firefox React checks with mocked APIs covered owner, manager, and worker download cards plus 1800px and 375px layouts without horizontal overflow.
These mocked browser checks do not constitute a live worker login or Windows tracking test.

No production update manifest was published and no old-to-new in-app upgrade is claimed.

## Diagnostic release v0.1.3, October 21, 2026

Protected production-channel build `39600736918` succeeded from `fb46c07483dadb6309306ba087d5dcc33e113186`, including all 22 native Rust tests, exact signed-installer fresh install/startup on Windows, and independent Ubuntu minisign verification.
The downloaded candidate was verified again locally against the committed public key, trusted version `0.1.3`, checksum, and production manifest URL before publishing only its manual-download files.

Public installer: `/downloads/0.1.3/WorkTrack_0.1.3_x64-setup.exe`, 3,890,558 bytes.
SHA-256: `28e0a0b88a34292fa2272f53e2794ed98f0f0ec1f238d8e9f506d41a4aeb279f`.
The same directory contains `SHA256SUMS` and `WorkTrack_0.1.3_x64-setup.exe.sig`.
The v0.1.2 directory and its original checksum are unchanged.

AMD64 API/dashboard images `worktrack-api:fb46c07` and `worktrack-web:fb46c07` are deployed.
Public HTTPS download acceptance passed for the new React entry point, existing-account login, anonymous executable bytes, exact checksum, attachment/immutable-cache headers, and hidden/missing/directory 404s. Acceptance credentials were revoked afterward.

After manual installation, sign in and enable **Send diagnostic logs for this launch**. Owners expand **Desktop diagnostic logs (owner only)** on the dashboard and click **Load recent logs**.
Only failures are logged, so a healthy run can leave this list empty. Consent resets on restart or successful sign-in. Pending diagnostics are memory-only; tracking records remain durable and separate.
Real worker login/capture/lock/suspend and old-to-new identity/data-preserving upgrade acceptance remain unperformed. Windows publisher warnings remain possible because Tauri updater signatures are not Authenticode publisher signing.
No production automatic-update manifest was published. This is a manual-install testing release.

## Location and application release v0.1.4, October 21, 2026

Production-channel protected workflow `39609351264` succeeded from `9fb9e13be99e72cf586dc8eae5c177da546a09e9`.
It passed native Windows Rust tests, the exact signed NSIS install/startup smoke, and independent Ubuntu signature/trusted-version/checksum verification. The candidate was independently reverified locally against the committed public key before manual publication.
GitHub preview release `v0.1.4` targets the same source and contains only the verified setup, signature, and checksum. It does not publish an update feed.

Public installer: `/downloads/0.1.4/WorkTrack_0.1.4_x64-setup.exe`, 3,923,241 bytes.
SHA-256: `f45a1c10de9a5264470bdc2fcda0bd3cbbbbec957fdb6bb2b2310ba363099119`.
`SHA256SUMS` and `WorkTrack_0.1.4_x64-setup.exe.sig` are beside it.
Public HTTPS download acceptance, real existing-account login/revocation, correct dashboard link, executable/checksum identity, attachment/cache headers, and hidden/missing/directory 404s passed. Old v0.1.2 and v0.1.3 checksums remain unchanged.

Stop tracking, wait for queued records to sync, and quit before upgrading. Do not uninstall or delete app data.
After sign-in, accept the updated monitoring disclosure. Foreground executable minutes upload with time blocks, normally every 30 seconds, and appear under **Applications on selected day** for the selected worker/date. This includes idle time and is not proof of productivity; old agents have no retroactive app-use data.
For location, explicitly enable **Share location with screenshots for this launch**, allow Windows permission, and check Windows location services/desktop-app access. Location requests occur only at screenshot boundaries (every ten running minutes), never continuously or immediately on Start. Screenshots show coordinates, accuracy and fix time, or sharing-off/unavailable. No IP-location guesses or external map provider are used by WorkTrack.

A location-capable connected Windows PC is still required to validate real fixes/accuracy, capture/lock/suspend behavior, and in-place identity/data-preserving upgrade acceptance. Publisher warnings remain possible. This preview is manual-install only; automatic-update publication remains gated.

## Combined hotfix v0.1.5, October 21, 2026

Reviewed source `12dbe5bf44832259401f099c807092f81ad191fe`, protected workflow `39619325968`, and GitHub preview release `v0.1.5` combine the desktop UI lock-order/status-poll fix with explicit screenshot statuses in the API/dashboard.
The exact signed installer passed native tests, fresh install/startup and five responsive-main-window probes, independent Ubuntu verification, and local verification against the committed public key, exact trusted version and production URL.

Public installer: `/downloads/0.1.5/WorkTrack_0.1.5_x64-setup.exe`, 3,928,439 bytes.
SHA-256: `0ed92d211340e34d9228b5d3d434e6463ac8507102f3a2ac85ad633479935638`.
Detached signature and `SHA256SUMS` are adjacent. The immutable directory was published atomically, then the dashboard switched to it. Anonymous HTTPS bytes/checksum/headers, authenticated dashboard entry, missing/hidden/listing 404s, and a real 375px owner view of existing worker time-only blocks all passed. Temporary acceptance credentials were revoked.

Two reported "screenshots" were actually 30-second time-only blocks from a one-minute session. No worker image was attached or lost. The dashboard now distinguishes no capture, deletion and temporary unavailability. A synthetic 16x16 JPEG storage probe passed upload, signed download, exact checksum and decoding using live API storage settings, then was removed without changing worker data.
Screenshots still occur every ten running minutes, not on Start/Stop. Keep the desktop unlocked and tracking for a full interval to test a real capture.

Stop, sync to zero and quit before upgrading. Never uninstall or remove app data. If the old UI remains frozen, force-closing can lose an unflushed partial interval; already durable records remain queued. Do not assume an open server session means time is uploading, and never backfill unobserved time.
Real-PC capture/location and in-place upgrade preservation remain acceptance gaps. Automatic updates remain unpublished, and updater signatures are not Authenticode.

## Auto-update scope

The production-configured v0.1.2 installer includes the production updater endpoint and verification public key.
Publishing an installer for manual installation does not publish a production update manifest.
Actual old-to-new signed Windows upgrade, identity/data preservation, and tracking/queue gate acceptance remain required before announcing production automatic updates.
Windows publisher identity warnings are separate from Tauri update signatures.
