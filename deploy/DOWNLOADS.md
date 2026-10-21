# Worker installer downloads

The signed-in dashboard offers the production-configured Windows x64 installer at `/downloads/0.1.2/WorkTrack_0.1.2_x64-setup.exe`.
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

The default `compose.yaml` mounts `/srv/worktrack-downloads` read-only, and its Caddy configuration serves `/downloads/*` as files rather than the React app.
Place the verified installer and `SHA256SUMS` under `/srv/worktrack-downloads/0.1.2/` with mode 0755 directories and 0644 files.
Use the standalone Compose commands in `README.md`. The shared-host image overlay below is not required.
`deploy/test-web.sh` checks exact fixture bytes, attachment/cache headers, and 404 responses for missing, hidden, and directory paths against the standalone image.

## Shared host deployment

Build the AMD64 web image away from the shared VM and load it as `worktrack-web:downloads-0.1.2`.
Place the verified installer in `/srv/worktrack-downloads/0.1.2/WorkTrack_0.1.2_x64-setup.exe` with public read permissions.
Keep the existing image and Caddy configuration available for rollback.
Deploy the reviewed `Caddyfile.shared` and `compose.downloads.yaml` into `/opt/worktrack/deploy`.
The overlay adds only a read-only installer directory mount and selects the new web image.
It does not change the API, database, outer HTTPS proxy, signing secrets, or screenshot storage.

```sh
docker compose -p worktrack \
  -f /etc/worktrack/compose.runtime.json \
  -f /opt/worktrack/deploy/compose.downloads.yaml \
  -f /opt/worktrack/deploy/compose.release.yaml \
  up -d --no-deps --no-build --pull never --wait web
```

Use all three files, in this order, for subsequent web operations so the current release image and installer mount are retained.
The current API/dashboard release is recorded in `SHARED-HOST.md`; the downloads overlay alone still names the older dashboard image.
Never print the protected runtime configuration.
Verify the public HTTPS installer checksum against the verified candidate before announcing availability.
Verify missing download paths return 404, file responses are attachments, listing is disabled, API health is unchanged, and unrelated shared-host sites still work.

For application rollback, use the retained images and rollback overlay documented in `SHARED-HOST.md`.
Preserve published installer bytes and do not overwrite versioned paths with a different build.

## Public acceptance

Run `node scripts/download-acceptance.mjs` with `WT_DOWNLOAD_BASE`, independently verified `WT_DOWNLOAD_SHA256`, and existing-account `WT_ACCEPTANCE_EMAIL` and `WT_ACCEPTANCE_PASSWORD` supplied through a protected environment.
The script checks the deployed bundle, real login and authenticated API, anonymous exact installer bytes, attachment/cache headers, published checksum, missing/hidden paths, and disabled directory listing.
It creates and revokes only its own authentication session and does not create workers or change tracking records.
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

## Auto-update scope

The production-configured v0.1.2 installer includes the production updater endpoint and verification public key.
Publishing an installer for manual installation does not publish a production update manifest.
Actual old-to-new signed Windows upgrade, identity/data preservation, and tracking/queue gate acceptance remain required before announcing production automatic updates.
Windows publisher identity warnings are separate from Tauri update signatures.
