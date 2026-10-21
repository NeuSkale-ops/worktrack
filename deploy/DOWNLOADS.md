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
  up -d --no-deps --wait web
```

Use both files for subsequent web operations so the image and installer mount are retained.
Never print the protected runtime configuration.
Verify the public HTTPS installer checksum against the verified candidate before announcing availability.
Verify missing download paths return 404, file responses are attachments, listing is disabled, API health is unchanged, and unrelated shared-host sites still work.

To roll back, restore the backed-up Caddy configuration and run the previous protected-runtime-only web configuration.
Preserve published installer bytes and do not overwrite versioned paths with a different build.

## Public acceptance

Run `node scripts/download-acceptance.mjs` with `WT_DOWNLOAD_BASE`, independently verified `WT_DOWNLOAD_SHA256`, and existing-account `WT_ACCEPTANCE_EMAIL` and `WT_ACCEPTANCE_PASSWORD` supplied through a protected environment.
The script checks the deployed bundle, real login and authenticated API, anonymous exact installer bytes, attachment/cache headers, published checksum, missing/hidden paths, and disabled directory listing.
It creates and revokes only its own authentication session and does not create workers or change tracking records.
Never include credential values in shell arguments or logs.

## Auto-update scope

The production-configured v0.1.2 installer includes the production updater endpoint and verification public key.
Publishing an installer for manual installation does not publish a production update manifest.
Actual old-to-new signed Windows upgrade, identity/data preservation, and tracking/queue gate acceptance remain required before announcing production automatic updates.
Windows publisher identity warnings are separate from Tauri update signatures.
