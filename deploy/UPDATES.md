# Signed Windows updates

Status: signed candidates, manual installer distribution, and isolated update hosting are verified.
On October 21, 2026, the approved host setup installed both restricted receivers and read-only public mounts.
Update, November 12, 2026: the production feed at `https://worktrack.neuskale.com/updates/windows/x86_64/latest.json` returns HTTP 200 and offers 0.1.11. The statements below about unpublished feeds describe October 21 and no longer hold for production.
That release shipped from a local cross-build without a native Windows runtime test, see `docs/RELEASE-0.1.11.md`.
On October 21, both production and staging `latest.json` endpoints returned HTTP 404 because no accepted manifest had been published.
Signed workflow `39619325968` passed build and verification, but its publication job was skipped.
Workflow `39663283701` passed real installed Windows 0.1.5-to-0.1.6 upgrade acceptance with the exact signed candidate from `39658013988` and `publish=false`. Sign-in/local data survived, tracking stayed stopped, and stalled-download recovery completed in 602.14 seconds. This offline-seeded test does not close the connected-worker release gates below.
A successful candidate build, configured host, or GitHub release does not enable automatic updates.
Real signed Windows upgrade acceptance and manifest publication remain required.
The source is prepared as version `0.1.6`, with the owner-provided public key and ordinary updater artifact generation disabled.
Manual installer distribution is recorded in `DOWNLOADS.md` and does not publish an automatic-update manifest.
The owner key pair passed a real Tauri signing and independent minisign verification check on October 21, 2026.
This probe does not prove a signed Windows installer or an in-app upgrade.
This version change alone does not create a signed or published release.
The release helper refuses legacy versions, missing keys, mismatched versions, changed identity/scope, unsigned-version signatures, and unexpected URLs.
Ordinary unsigned Windows CI and its fresh-install smoke workflow are unchanged.

## Approval and key setup

Do not publish the first production manifest until the signed Windows upgrade and preservation gates in `docs/AUTO-UPDATE-PLAN.md` pass.
Public installer distribution and host configuration changes need separate operator approval.
Tauri updater signing is not Windows publisher signing, so it does not eliminate SmartScreen warnings.

After approval, arrange secure offline backup before generating the real Tauri signing key.
This repository does not generate keys or store their private contents.
The operator stores secret values interactively with `envkit set KEY`, not secret values in shell arguments, `envkit get`, or `envkit export`.
Required signing secret names:

- `TAURI_SIGNING_PRIVATE_KEY`: Tauri's encoded private key contents, never a runner-local path.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: a nonempty password for that private key.

The approved deployment identities are distinct local files `~/.ssh/worktrack_updater_production` and `~/.ssh/worktrack_updater_staging`, each mode `0600`.
Their private contents were supplied to the corresponding protected environment's `WORKTRACK_UPDATER_SSH_KEY` secret, not committed or printed.
These are restricted publication identities, not the administrative root key.
Do not assume deployment keys exist in the WorkTrack envkit project: its names-only inspection found no `WORKTRACK_UPDATER_SSH_KEY` or `WORKTRACK_UPDATER_STAGING_SSH_KEY` entries before provisioning.

Commit only the actual Tauri public key into `agent/src-tauri/tauri.conf.json` at `plugins.updater.pubkey`.
Keep `requireSignedVersion: true`, the application identifier, current-user installation scope, and production endpoint unchanged.
Bump the committed Tauri, Cargo package, and npm package versions together for a release newer than `0.1.1`.
The release workflow uses a generated config overlay to enable updater artifacts and select a fixed staging or production endpoint.
Development builds reject native update checks. The unsigned CI overlay explicitly clears the updater public key and endpoints, because disabling artifact generation alone does not disable receiving updates.
Update checks have a 60-second timeout. Installer downloads have an explicit ten-minute timeout because pinned plugin 2.14.0 does not carry the check timeout into the download.
Do not enable signing in the ordinary unsigned CI workflow.
Do not grant frontend `updater:*` capabilities, because only the custom Rust commands enforce the tracking/data installation gate.

### Signing trust boundary

V1 uses one updater verification key for both staging and production builds.
The separate endpoints, accounts, directories, and deployment approvals isolate publication, not cryptographic trust.
An artifact signed for staging is therefore also trusted by the production public key if it is offered through a compromised production manifest.
Treat staging signing approval as production-sensitive and do not sign unreviewed code for either channel.
Separate signing keys and protected signing environments would be required for cryptographic channel isolation.
This is a known limitation, not a claim that staging signatures are production-incompatible.

## Protected GitHub environments

All three environments now exist with selected-branch `main` restrictions, verified during the approved October 21, 2026 setup.
Both deployment environments have their dedicated SSH secret and host/verified-known-host variables configured.
Verify their metadata again before a release, without reading secret values.
Do not put these credentials in repository-wide secrets.
Restrict all three environments to the selected branch `main` only.
For this solo project, the owner explicitly approved proceeding without required reviewers on October 21, 2026.
Keep release dispatch manual and signing credentials scoped to `updater-release`, never repository-wide secrets.
Anyone who can modify trusted release code or workflows can misuse these credentials, so this setup does not provide independent approval or protection against a compromised owner account.
Use required reviewers, prevent self-review, and disable administrator bypass if a future repository plan and team support those controls.
Verify the environment's `main` branch restriction before configuring release secrets or running this workflow.

| Environment | Environment secrets | Environment variables |
| --- | --- | --- |
| `updater-release` | `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | none |
| `updater-staging` | `WORKTRACK_UPDATER_SSH_KEY`, from `~/.ssh/worktrack_updater_staging` | `WORKTRACK_UPDATER_HOST`, `WORKTRACK_UPDATER_KNOWN_HOSTS` |
| `updater-production` | `WORKTRACK_UPDATER_SSH_KEY`, from `~/.ssh/worktrack_updater_production` | `WORKTRACK_UPDATER_HOST`, `WORKTRACK_UPDATER_KNOWN_HOSTS` |

`WORKTRACK_UPDATER_HOST` is the SSH hostname/IP only, without user, port, or shell arguments.
`WORKTRACK_UPDATER_KNOWN_HOSTS` contains the host key line verified through an independent trusted channel.
Do not populate it by blindly trusting `ssh-keyscan` during a release.
Signing secrets are referenced only in the protected Windows build's signing step.
The public-verification job has no secrets, and deployment jobs receive no Tauri signing key.
The workflow accepts no arbitrary download URL, SSH user, host command, or signing key input.

## One-time root setup, operator only

The operator reviewed and executed `scripts/setup_updater_host.sh` on the approved Linux host on October 21, 2026.
It is never a CI deployment command. Keep an existing administrative session open during setup and restricted-key checks.
For a newly approved host, supply only the reviewed receiver and three public-key files:

```sh
sudo bash scripts/setup_updater_host.sh \
  scripts/updater_release.py /path/to/tauri-public-key.txt \
  /path/to/production-ed25519.pub /path/to/staging-ed25519.pub
```

The Tauri input is the committed encoded `plugins.updater.pubkey` value, not a private signing key.
The script checks Python 3.11+, installs `minisign` through trusted OS packages if missing, validates distinct plain Ed25519 public keys, and rejects unexpected existing managed files or accounts.
It provisions the layout below and `/etc/ssh/sshd_config.d/70-worktrack-updates.conf`, validates both syntax and effective per-account sshd rules, then gracefully reloads `ssh.service`.
It backs up an existing matching fragment and restores the previous fragment if validation or reload fails.
Package installation and account/storage provisioning are not transactional, so inspect partial state before retrying an interrupted setup.
It does not change global sshd configuration, reset passwords, touch runtime secrets, mount containers, or publish a manifest.
Never give that root key, sudo, Docker membership, or access to the API environment/screenshot credentials to either deployment account.

Required layout and restrictions, also used for operator review:

1. Install Python 3.11+ and `minisign` from the host's trusted OS packages.
   Install the reviewed `scripts/updater_release.py` as `/usr/local/lib/worktrack-updater/updater_release.py`, owned by root, with its containing directory not writable by either deployment user.
   Install the committed encoded public key as `/etc/worktrack-updater/public-key.txt`, owned by root and readable by both accounts.
   This file is public, not a private signing key.
2. Create two service accounts with `/bin/sh` as their shell so sshd can execute its forced command: `worktrack-updates` and `worktrack-updates-staging`.
   Disable password login and all interactive access through the sshd rules below.
   Keep their home directories root-owned and do not add supplementary privileged groups.
3. Provision `/srv/worktrack-updates` for production and `/srv/worktrack-updates-staging` for staging, each writable only by its corresponding account and root.
   Create `public/windows/x86_64` under each storage directory before the first release.
   Use traversable `0755` directories for `public` and its descendants, because Caddy must read them.
   Parent storage directories can be `0711`, and should be isolated with an appropriate disk quota.
   Staging, locks, and the `highest-version` watermark stay outside `public` on the same filesystem.
   Preserve `highest-version` when withdrawing a release so an old version cannot be promoted later.
4. Put only each account's dedicated public SSH key in `/etc/ssh/authorized_keys/ACCOUNT`, with the directory and files owned by root.
   Prefix each authorized key with `restrict`.
   The account must not be able to change its authorized keys, sshd config, receiver code, or trusted public key.
5. Add the following reviewed sshd configuration, validate it with `sshd -t`, and reload sshd through the existing administrative session.
   Keep an administrative session open while checking restricted-key authentication.

```text
Match User worktrack-updates
    AuthorizedKeysFile /etc/ssh/authorized_keys/%u
    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    DisableForwarding yes
    PermitTTY no
    ForceCommand /usr/bin/timeout 600 /usr/bin/python3 -I /usr/local/lib/worktrack-updater/updater_release.py receive --root /srv/worktrack-updates --public-key /etc/worktrack-updater/public-key.txt

Match User worktrack-updates-staging
    AuthorizedKeysFile /etc/ssh/authorized_keys/%u
    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    DisableForwarding yes
    PermitTTY no
    ForceCommand /usr/bin/timeout 600 /usr/bin/python3 -I /usr/local/lib/worktrack-updater/updater_release.py receive --root /srv/worktrack-updates-staging --public-key /etc/worktrack-updater/public-key.txt --base-url https://worktrack.neuskale.com/updates-staging/windows/x86_64

Match all
```

The forced receiver ignores `SSH_ORIGINAL_COMMAND` and accepts only a bounded set of regular archive members on stdin.
It provides no shell, file-transfer subsystem, forwarding, or elevated command.
Test both account restrictions and that the staging account cannot write production files before saving the deployment keys as protected environment secrets.

6. After approved local configuration review, deploy the updated `Caddyfile.shared` and append `deploy/compose.updates.yaml` to the existing approved Compose file set.
   On the current host that set is `/etc/worktrack/compose.runtime.json`, `/opt/worktrack/deploy/compose.downloads.yaml`, and `/opt/worktrack/deploy/compose.release.yaml`, with project `worktrack` and working directory `/etc/worktrack`.
   Do not print runtime configuration contents or drop those existing overlays.
   This adds only read-only public-directory mounts to the web container.
   Do not mount the storage parents, staging scratch directories, SSH material, or the screenshot bucket.
   Preserve the existing outer Caddy HTTPS proxy and all its unrelated sites.
   Before and after the change, check WorkTrack login/API and another existing host site, not just the update route.
   Verify both update routes return 404 while no manifest exists, rather than dashboard HTML.
   Keep public directory listing disabled.

## Verified host readiness, October 21, 2026

- Python 3.12.3 and `minisign` are installed. Both fixed accounts, root-owned receiver/public key/authorized-key files, and separate storage trees were provisioned.
- Each dedicated key authenticated with strict existing host-key verification. Sending requested command `id` with empty stdin reached the forced receiver and exited `1` with `Release refused: empty file`, rather than opening a shell.
- Root-run account checks found neither deployment account could write the other channel, trusted public key, or receiver.
- Sending the production baseline archive through the staging key exited `1` with an expected download-URL mismatch. This is channel-boundary rejection, not successful staging publication.
- `worktrack-web-1` now has `/srv/worktrack-updates/public:/srv/updates:ro` and `/srv/worktrack-updates-staging/public:/srv/updates-staging:ro`, alongside its existing Caddy and installer-download mounts.
- Only the web container was recreated, using its unchanged image. API, database, and shared proxy container IDs were unchanged.
- WorkTrack `/` and `/healthz` returned `200`, the existing installer download returned `200`, and hidden update paths returned `404`.
- Both `latest.json` feeds returned `404` after provisioning. Empty prepared feeds are intentional until an accepted signed release is promoted.

These observations prove host readiness and basic isolation, not native Windows upgrade acceptance or a published update.

## Release and staging sequence

Run **Windows updater release** manually from reviewed `main` only.
Its default channel is `staging`, and `publish` defaults to false.
Requesting production publication without Windows upgrade evidence now fails preflight instead of silently skipping publication.
A build-only run creates a private GitHub candidate artifact but exposes nothing publicly.
The package includes the tested NSIS installer, its Tauri signature, manifest with signature contents, and SHA-256 checksum.
The Linux verification job independently verifies the minisign signature and trusted-comment version against the committed public key.
A fresh install on Windows is a prerequisite, not proof of a real in-app update.

### Native production publication gate

For `channel=production`, `.github/workflows/updater-release.yml` now runs an `upgrade` job after independent signature verification, even when `publish=false`.
It downloads the pinned `0.1.5` baseline and verifies its recorded SHA-256, then runs `scripts/updater_upgrade_acceptance.ps1` against the exact newer candidate through real installed WebView UI Automation.
The disposable GitHub-hosted Windows runner maps the existing production hostname to an isolated loopback HTTPS fixture before launching the app.
This exercises the embedded production endpoint without publishing a public feed or using production worker credentials.
The job retains `worktrack-upgrade-evidence/upgrade-evidence.json` as artifact `windows-upgrade-evidence`, including failed or partial observations when available.
Production publication requires successful `verify` and `upgrade` jobs, `publish=true`, a nonempty `upgrade_evidence` reference, and reviewed `main`.
An evidence reference alone cannot bypass a failed native job. Staging publication does not run this production-only native job.
Native evidence is recorded in workflow `39663283701`, artifact `windows-upgrade-evidence/upgrade-evidence.json` (`status=passed`, no cleanup errors). See `docs/VALIDATION.md` for requirement mapping. Real worker login, actual sync drain, active/concurrent tracking, location/capture and installer cancellation remain unobserved; do not treat the seeded offline pass as those checks.
A seeded fixture identity proves local continuity, not a real server login, active tracking, geolocation, or screenshot acceptance.
The staging sequence below remains useful for broader connected-worker checks and the complete acceptance matrix.

1. After approved key and environment setup, commit an unused staging version newer than the installed test version.
   Do not reuse the already distributed `0.1.2` through `0.1.5` production installer identities for changed production bytes.
   Dispatch `channel=staging`, that exact version, and `publish=true` after approving staging public distribution.
   Only `updater-release` and `updater-staging` are used, not the production deployment credentials.
   The staging installer embeds the separate `/updates-staging/windows/x86_64/latest.json` endpoint.
2. Manually install that staging installer once on a disposable, connected Windows worker environment.
   Prepare an existing worker identity, settings, pending queue, and tracking state for the acceptance checks.
3. Commit a strictly higher unused version and release it to staging through the same workflow.
   From the installed older staging app, exercise the actual in-app signed upgrade and restart.
   Verify the resulting version, stable current-user installation, preserved identity/settings/data, pending-data/tracking installation blocks, stopped tracking after restart, and all failure/tampering cases from the plan.
   Record the Windows observations and workflow run/artifact identifiers.
4. Only after those checks pass, run the production channel for the reviewed version with an `upgrade_evidence` reference and production publication explicitly selected.
   The production reviewer must inspect the evidence, commit, signed artifact verification, and public distribution approval before approving `updater-production`.
   Rebuilding for production changes the embedded endpoint, so retain both channel artifacts and verify production's exact installer independently as the workflow does.
   No real production upgrade is claimed by the staging run alone.
5. Existing `0.1.0` and `0.1.1` workers need a one-time manual installation of the production updater-enabled installer.
   Never distribute the staging installer to normal workers or confuse an ordinary unsigned CI artifact with an updater-enabled signed release.

Publication holds both workflow concurrency and a host file lock.
It rejects lower/repeated current versions and versions below the durable high-water mark.
It installs versioned files without overwriting an existing version, verifies the anonymous HTTPS installer and signature bytes, then atomically replaces `latest.json` last.
A failed public download leaves the old manifest untouched.
Re-running the same workflow job after an interruption can reuse identical immutable files, but a rebuild with different bytes under the same version is refused.
Keep old version directories available.
To stop offering a faulty release, an authorized operator can withdraw `latest.json` while preserving the high-water mark and all immutable files, then publish a higher-version fix.
Do not replace an old installer or attempt forced downgrade.

## Local validation

```sh
python3 -m unittest discover -s scripts -p 'test_updater*.py' -v
actionlint .github/workflows/updater-release.yml
bash -n scripts/test_updater_hosting.sh
# Requires an existing local Caddy web image, uses ephemeral local-only containers.
UPDATER_CADDY_IMAGE=worktrack-web:test bash scripts/test_updater_hosting.sh
```

The Python fixtures are synthetic and do not prove cryptographic acceptance of a real signed Windows artifact.
The protected release workflow performs actual public-key verification using `minisign` before publication, and the host verifies it again with its root-owned key.
The hosting test exercises the actual shared Caddy configuration over local HTTP for JSON/cache behavior, byte identity, missing/hidden 404s, SPA fallback, and rejected writes.
It does not prove production TLS, shared-host isolation, or a signed Windows in-app upgrade.

## Local Windows builds when GitHub Actions is unavailable

Tauri supports NSIS cross-compilation from macOS with caveats. This path successfully produced the 0.1.10 Windows x64 candidate on October 27, 2026. See `docs/RELEASE-0.1.10.md` for the exact tool versions, source and checksum.

Use a clean committed source archive and the locked pnpm/Cargo dependencies. Install NSIS, LLVM and LLD, the Windows Rust standard library, and `cargo-xwin`:

```sh
brew install nsis llvm lld
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin
```

With their binaries on PATH, run from `agent/`:

```sh
pnpm run tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis -- --locked
```

The default committed configuration produces an installer candidate without updater artifacts. It preserves the installed app's verification key and production endpoint. Validate its Windows AMD64 payload, version and checksum, then keep unsigned candidates outside public download mounts.

An authorized local build does not need to recreate GitHub Actions, but production publication still needs the existing signing key and Windows installation/upgrade evidence. For manual updater signing, use the installed Tauri signer's private-key file/environment options and `--app-version` to bind the signature to the exact version. Never put private key material or its password in command arguments or logs. Package and independently verify the signed candidate using `scripts/updater_release.py` before sending it to the existing restricted SSH receiver.

The current automated Windows acceptance fixture deliberately runs only on disposable GitHub-hosted Windows runners because it changes credentials, hosts and installation state. Do not run it on a worker's regular PC or spoof its runner guards. A different disposable Windows test environment needs an explicitly reviewed fixture, or record equivalent manual acceptance without destructive fixture setup.

Official build instructions: https://v2.tauri.app/distribute/windows-installer/#build-windows-apps-on-linux-and-macos.

## Official references reviewed

- Tauri 2 updater configuration, signing environment variables, NSIS `.exe` plus `.sig` artifacts, and static manifest format: https://v2.tauri.app/plugin/updater/
- Official CLI release notes explaining version-bound signatures and `requireSignedVersion`: https://tauri.app/release/%40tauri-apps/cli/v2.12.0/
- Official signing implementation showing the signed trusted-comment version and encoded signature format: https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-cli/src/helpers/updater_signature.rs

## Release host after the November 2026 migration

Since November 11, 2026 the receiver runs on app-nbg (`46.225.13.28`, Nuremberg k3s node), provisioned with `scripts/setup_updater_host.sh`.
GitHub runners connect to a dedicated restricted sshd on port 2222 (`sshd-worktrack-release.service`, config `/etc/ssh/sshd_worktrack_release_config`).
It allows only the two release accounts, public keys only, with the same forced receiver command. Admin SSH on port 22 stays firewalled to operators.
The `updater-production` and `updater-staging` environments set `WORKTRACK_UPDATER_HOST=46.225.13.28`, `WORKTRACK_UPDATER_PORT=2222` and a pinned `WORKTRACK_UPDATER_KNOWN_HOSTS` line.
The worktrack-web pod serves `/srv/worktrack-updates/public` and `/srv/worktrack-updates-staging/public` read-only via hostPath.
