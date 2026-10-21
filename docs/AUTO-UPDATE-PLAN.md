# Windows auto-update plan

Status: implementation and approved host provisioning recorded October 21, 2026.
Signed installer builds and isolated update hosting exist, but both manifests remain unpublished pending real Windows upgrade acceptance.
The production release workflow now enforces a native `upgrade` job; no passing native result is claimed here.
See `deploy/UPDATES.md` and `docs/VALIDATION.md` for current setup and observed checks.

## Recommended behavior

Use the official Tauri 2 updater, not a custom installer or patching system.
Check automatically at startup and every six hours while the app is running, with a manual **Check for updates** button.
Show the available version, release notes, **Update now**, **Later**, download progress, and actionable errors.
Do not silently stop tracking or force installation.
Network or update failures must not prevent normal tracking.

Versions 0.1.0 and 0.1.1 have no updater.
Workers must manually install an updater-enabled production release once; signed production installers through `0.1.5` have been distributed manually.
Subsequent compatible releases can be offered inside that installed app only after a signed manifest is published.
Source candidate `0.1.6` does not by itself create an automatic update.

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
The production manifest endpoint is `https://worktrack.178.156.213.40.sslip.io/updates/windows/x86_64/latest.json`; staging uses `/updates-staging/windows/x86_64/latest.json` on the same host.
Approved provisioning on October 21, 2026 installed the root-owned receiver/public key, `minisign`, two isolated fixed service accounts, distinct restricted SSH identities, and separate storage trees.
The reviewed operator-only `scripts/setup_updater_host.sh` accepts a receiver path and three public-key file paths, validates inputs and effective sshd restrictions, and rolls back its SSH fragment on validation or reload failure.
It does not create public mounts, modify runtime configuration, or publish manifests.
The web container now mounts only each channel's `public` subtree read-only through `deploy/compose.updates.yaml`; storage parents and signing material remain outside the container.
All three GitHub environments exist with `main` branch restrictions. Dedicated SSH secrets and verified host variables are configured separately for staging and production.
Both dedicated keys reached the forced receiver rather than a requested shell command; cross-account and trusted-file writes were denied in account-isolation checks.
A production archive submitted through the staging identity was rejected for its download URL, not promoted.
The web-only recreation preserved its image and the API, database, and shared proxy container IDs. WorkTrack health, dashboard, and existing installer download returned `200`; hidden update paths returned `404`.
Both `latest.json` endpoints still return `404`, intentionally: prepared hosting is not a published feed.
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

## Native workflow gate and remaining evidence

The production channel in `.github/workflows/updater-release.yml` runs independent signature verification, then `scripts/updater_upgrade_acceptance.ps1` on a disposable GitHub-hosted Windows runner.
It starts with the immutable `0.1.5` installer, pinned by SHA-256, and drives the actual installed WebView through UI Automation against an isolated HTTPS feed for the exact production hostname.
The hostname maps to loopback before app launch, so the acceptance fixture neither publishes a public manifest nor contacts a real worker API.
The runner uploads `windows-upgrade-evidence`, containing `worktrack-upgrade-evidence/upgrade-evidence.json` when available, even for partial or failed observations.
Production publication depends on successful `verify` and `upgrade` jobs plus explicit `publish=true` and a nonempty `upgrade_evidence` reference.
Staging publication remains independently isolated and does not run this production-only native job.
Workflow `39663283701` passed installed Windows upgrade acceptance using the exact signed 0.1.6 candidate from `39658013988`, with publication disabled. Real UIAutomation confirmed signature-failure recovery, preserved keyring/settings/SQLite, stopped tracking after upgrade/restart, missing-feed guidance, and stalled-download recovery after 602.14 seconds. The evidence JSON reports no cleanup errors. Real worker login, actual sync drain, active/concurrent tracking, location/capture and installer cancellation remain separate release gates; see `VALIDATION.md`.
The fixture's seeded identity can prove local preservation, not real server login, active tracking, geolocation, or screenshot acceptance.
Complete the unproven connected-worker gates below, and inspect retained native evidence before publication.

## Implementation order

1. Signing configuration, protected release credentials, and updater artifacts are implemented.
2. Rust update commands, the exclusive installation gate, and the React prompt are implemented.
3. Approved isolated hosting and read-only Caddy mounts are provisioned; publication remains gated.
4. Obtain passing native Windows upgrade evidence and complete the remaining connected-worker checks before enabling the production manifest.
5. Publish an accepted signed release and explain the one-time manual installation to workers on versions without an updater.

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
The native upgrade job has been added, but these real in-app upgrade checks have no recorded passing result here. Signed candidate builds and fresh-install smoke tests are recorded in `deploy/DOWNLOADS.md`; they do not satisfy this gate.
Host readiness and basic account isolation were verified separately. They do not prove public artifact publication, native upgrade/data preservation, real worker login, or native tracking/location behavior.

## Official references

- Tauri updater documentation: https://v2.tauri.app/plugin/updater/
- Windows publisher signing: https://v2.tauri.app/distribute/sign/windows/

The repository now includes the updater plugin and the real public verification key.
Ordinary unsigned CI explicitly clears its update key and endpoints and keeps `createUpdaterArtifacts` set to `false`.
Signed production-channel installers have been distributed manually, but both prepared update feeds still returned HTTP 404 after the approved October 21, 2026 host provisioning.
A signed build, manual download, configured receiver, or GitHub release does not publish `latest.json` or prove an in-app upgrade.
