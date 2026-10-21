# Signed Windows updates

Status: plumbing only.
No signing key, GitHub environment, public update directory, or production manifest is created by this change.
The source is prepared as version `0.1.2`, with an empty public key and updater artifact generation disabled until signing setup.
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
Required local secret names:

- `TAURI_SIGNING_PRIVATE_KEY`: Tauri's encoded private key contents, never a runner-local path.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: a nonempty password for that private key.
- `WORKTRACK_UPDATER_SSH_KEY`: production's dedicated restricted SSH private key.
- `WORKTRACK_UPDATER_STAGING_SSH_KEY`: a different dedicated staging SSH private key.

Commit only the actual Tauri public key into `agent/src-tauri/tauri.conf.json` at `plugins.updater.pubkey`.
Keep `requireSignedVersion: true`, the application identifier, current-user installation scope, and production endpoint unchanged.
Bump the committed Tauri, Cargo package, and npm package versions together for a release newer than `0.1.1`.
The release workflow uses a generated config overlay to enable updater artifacts and select a fixed staging or production endpoint.
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

Create these environments before dispatching the workflow.
Do not put these credentials in repository-wide secrets.
Restrict all three environments to the selected branch `main` only, require trusted reviewers, prevent self-review, and disable administrator bypass where the repository plan permits it.
Protect `main` and require review of workflow, script, dependency, and public-key changes before merge.
If the repository plan cannot enforce environment approval and branch restrictions, do not configure release secrets or run this workflow.

| Environment | Environment secrets | Environment variables |
| --- | --- | --- |
| `updater-release` | `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | none |
| `updater-staging` | `WORKTRACK_UPDATER_SSH_KEY`, populated from local `WORKTRACK_UPDATER_STAGING_SSH_KEY` | `WORKTRACK_UPDATER_HOST`, `WORKTRACK_UPDATER_KNOWN_HOSTS` |
| `updater-production` | `WORKTRACK_UPDATER_SSH_KEY`, populated from local `WORKTRACK_UPDATER_SSH_KEY` | `WORKTRACK_UPDATER_HOST`, `WORKTRACK_UPDATER_KNOWN_HOSTS` |

`WORKTRACK_UPDATER_HOST` is the SSH hostname/IP only, without user, port, or shell arguments.
`WORKTRACK_UPDATER_KNOWN_HOSTS` contains the host key line verified through an independent trusted channel.
Do not populate it by blindly trusting `ssh-keyscan` during a release.
Signing secrets are referenced only in the protected Windows build's signing step.
The public-verification job has no secrets, and deployment jobs receive no Tauri signing key.
The workflow accepts no arbitrary download URL, SSH user, host command, or signing key input.

## One-time root setup, operator only

These are setup instructions, not commands executed by CI or by this implementation.
Use the existing administrative access to the host only after approval.
Never give that root key, sudo, Docker membership, or access to the API environment/screenshot credentials to either deployment account.

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
    ForceCommand /usr/bin/timeout 600 /usr/bin/python3 -I /usr/local/lib/worktrack-updater/updater_release.py receive --root /srv/worktrack-updates-staging --public-key /etc/worktrack-updater/public-key.txt --base-url https://worktrack.178.156.213.40.sslip.io/updates-staging/windows/x86_64

Match all
```

The forced receiver ignores `SSH_ORIGINAL_COMMAND` and accepts only a bounded set of regular archive members on stdin.
It provides no shell, file-transfer subsystem, forwarding, or elevated command.
Test both account restrictions and that the staging account cannot write production files before saving the deployment keys as protected environment secrets.

6. After approved local configuration review, deploy the updated `Caddyfile.shared` and add `deploy/compose.updates.yaml` after the existing base and shared Compose files.
   This adds only read-only public-directory mounts to the web container.
   Do not mount the storage parents, staging scratch directories, SSH material, or the screenshot bucket.
   Preserve the existing outer Caddy HTTPS proxy and all its unrelated sites.
   Before and after the change, check WorkTrack login/API and another existing host site, not just the update route.
   Verify both update routes return 404 while no manifest exists, rather than dashboard HTML.
   Keep public directory listing disabled.

## Release and staging sequence

Run **Windows updater release** manually from reviewed `main` only.
Its default channel is `staging`, and `publish` defaults to false.
A build-only run creates a private GitHub candidate artifact but exposes nothing publicly.
The package includes the tested NSIS installer, its Tauri signature, manifest with signature contents, and SHA-256 checksum.
The Linux verification job independently verifies the minisign signature and trusted-comment version against the committed public key.
A fresh install on Windows is a prerequisite, not proof of a real in-app update.

1. After approved key and environment setup, commit the first staging version, proposed `0.1.2`.
   Dispatch `channel=staging`, that exact version, and `publish=true` after approving staging public distribution.
   Only `updater-release` and `updater-staging` are used, not the production deployment credentials.
   The staging installer embeds the separate `/updates-staging/windows/x86_64/latest.json` endpoint.
2. Manually install that staging installer once on a disposable, connected Windows worker environment.
   Prepare an existing worker identity, settings, pending queue, and tracking state for the acceptance checks.
3. Commit the next version, proposed `0.1.3`, and release it to staging through the same workflow.
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

## Official references reviewed

- Tauri 2 updater configuration, signing environment variables, NSIS `.exe` plus `.sig` artifacts, and static manifest format: https://v2.tauri.app/plugin/updater/
- Official CLI release notes explaining version-bound signatures and `requireSignedVersion`: https://tauri.app/release/%40tauri-apps/cli/v2.12.0/
- Official signing implementation showing the signed trusted-comment version and encoded signature format: https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-cli/src/helpers/updater_signature.rs
