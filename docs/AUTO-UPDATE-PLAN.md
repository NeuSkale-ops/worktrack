# Windows auto-update plan

Status: implementation plan recorded October 21, 2026.
Source implementation and signed installer builds exist, but production updates remain unpublished pending real Windows upgrade acceptance.
See `deploy/UPDATES.md` and `docs/VALIDATION.md` for current setup and observed checks.

## Recommended behavior

Use the official Tauri 2 updater, not a custom installer or patching system.
Check automatically at startup and every six hours while the app is running, with a manual **Check for updates** button.
Show the available version, release notes, **Update now**, **Later**, download progress, and actionable errors.
Do not silently stop tracking or force installation.
Network or update failures must not prevent normal tracking.

Versions 0.1.0 and 0.1.1 have no updater.
Workers must manually install the first updater-enabled release once, proposed as 0.1.2.
Subsequent compatible releases can be offered inside that installed app.
The proposed version is not a promise that an installer already exists.

## Safety boundary

The Rust backend must enforce installation eligibility, not just disable a React button.
Installation requires tracking stopped, no unfinished session or stop operation, and an empty offline queue.
Enter an exclusive update state before checking these conditions so a concurrent Start request cannot bypass the gate.
Pending data postpones installation and is never discarded to make an update possible.
Release the gate on failure so the existing version remains usable.
Keep the same application identifier, current-user installation scope, SQLite location, and keyring identity.
After installation and restart, tracking remains off until the worker explicitly starts it.
Avoid automatically resuming tracking after any updater restart.

## Signing

Tauri update artifacts require cryptographic signatures.
Embed only the public verification key in the app.
Keep the private signing key and its password outside the repository, in envkit and protected release secrets, with a separate secure backup.
Generate this key only when implementation is approved and arrange its backup before distributing the first updater-enabled installer.
A lost key can prevent updates to installations that trust its public key.

Updater signatures are different from Windows publisher signing, also called Authenticode.
They verify update authenticity but do not remove SmartScreen warnings from our unsigned installer.
A publisher certificate is a separate decision and is not required to implement the updater.

## Hosting and release pipeline

Use our existing Hetzner server and Caddy for public, read-only update files.
The proposed manifest endpoint is `https://worktrack.178.156.213.40.sslip.io/updates/windows/x86_64/latest.json`.
This route does not exist merely because it is documented here.
Use immutable, versioned installer paths and keep previous release files available.
Do not expose the private screenshot R2 bucket or embed a GitHub access token in the agent.
Our private GitHub release assets cannot serve as anonymous worker downloads.
Public installer distribution is part of this proposal and needs approval before publishing files.
No new database table or Go endpoint is necessary for static update hosting.

Enable updater artifacts in the Windows build configuration and register the compatible official updater plugin.
Pin and review dependency versions during implementation.
Keep the current unsigned NSIS installer alongside its updater signature.
The manifest contains the version, release notes, publication time, and the Windows x86_64 installer URL and signature content.
It must contain the signature itself, not a URL to a signature file.

Use an approved release job, not every development push, to access signing secrets.
Build, test, sign, and verify the exact artifact before publication.
Upload the immutable installer and signature first, verify public download integrity, and atomically promote the manifest last.
Use a restricted deployment identity with access only to the update directory.
Do not give the release job the shared host's root credentials.
Prevent overlapping promotions and version rollback.
Serve the manifest with revalidation rather than long-lived caching.
If a release is faulty, stop offering it and publish a higher-version fix.
Do not implement forced downgrades in V1.

## Implementation order

1. Add signing configuration, protected release secrets, and updater artifact generation.
2. Add Rust update commands, the exclusive installation gate, and the React update prompt.
3. Configure read-only Caddy distribution and the approved, atomic release publication job.
4. Validate an actual signed Windows upgrade before enabling the production manifest.
5. Publish the first updater-enabled installer and explain the one-time manual installation to workers.

## Acceptance gates

| Requirement | Required observation |
| --- | --- |
| Version discovery | Installed older updater-enabled app finds a newer signed version through the actual HTTPS manifest. |
| Real upgrade | On Windows, upgrade between two signed staging versions through the app and verify the resulting installed version. A fresh installer smoke test alone does not qualify. |
| Data preservation | Test an existing worker identity, persisted queue, and settings. Installation is blocked with pending data, succeeds after synchronization, and preserves login and local data. |
| Tracking safety | Active tracking blocks installation. Concurrent Start is rejected while installation is reserved. Restarted app is not tracking. |
| Authenticity | Modified installer and wrong-key signature are rejected without replacing the working app. |
| Recovery | Offline server, invalid manifest, interrupted download, and installation cancellation produce a recoverable state without deleting evidence. |
| Compatibility | Same current-user install upgrades without elevation, with stable identifier and no duplicate installation. |
| Publication | Downloaded public installer matches the tested artifact. Manifest promotion never points to a missing artifact. |
| Shared-host isolation | Existing WorkTrack login/API and other Caddy sites still respond after deployment. Screenshot objects remain private. |

A connected Windows environment is required for the full in-app upgrade and restart checks.
GitHub Windows compilation, unit tests, and silent fresh installation are useful prerequisites but cannot replace those observations.
These real in-app upgrade checks have not been completed. Signed candidate builds and fresh-install smoke tests are recorded in `deploy/DOWNLOADS.md`; they do not satisfy this gate.

## Official references

- Tauri updater documentation: https://v2.tauri.app/plugin/updater/
- Windows publisher signing: https://v2.tauri.app/distribute/sign/windows/

The repository now includes the updater plugin and the real public verification key.
Ordinary unsigned CI explicitly clears its update key and endpoints and keeps `createUpdaterArtifacts` set to `false`.
Signed production-channel installers have been distributed manually, but both update feeds returned HTTP 404 on October 21, 2026.
A signed build, manual download, or GitHub release does not publish `latest.json` or prove an in-app upgrade.
