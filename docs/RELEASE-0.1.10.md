# WorkTrack 0.1.10: simpler desktop controls

## Changes

- Removes the technical monitoring-status and local location-diagnostic panels from the worker screen.
- Keeps a brief, visible monitoring notice above consent and Start, with expandable privacy details. Screenshots, input activity, app use, location and signed-in diagnostic logs remain disclosed.
- Keeps Start/Stop, sync status, permission recovery controls, and updater safety checks.
- Includes the unpublished 0.1.9 status improvements: distinct saving state, status-failure recovery, usable Stop during a status failure, and an accessible screenshot countdown.

## Installation and limits

Stop tracking and let queued records sync before installing. Signed Windows releases install updates only after selecting Update now. Mac remains an Apple Silicon preview, ad-hoc signed, not notarized, with manual updates only.

Collection, storage, location providers, account permissions and database schema are unchanged. This release simplifies the interface and does not certify physical location accuracy. No server or dashboard deployment is required.

## Validation and publication

The desktop frontend passed its production build and 40 updater/status plus seven macOS permission browser checks with mocked native IPC. Layout checks passed at 390px and 520px without horizontal overflow. The versioned source also passed 40 Rust tests (one physical-console test ignored), 22 updater-helper tests and five Mac preview configuration tests. These checks do not prove a packaged application or native permissions.

The installed Windows upgrade check now verifies the brief notice, an unchecked monitoring-consent control, blocked Start, and absence of the removed local-diagnostic controls. All signature, preservation and updater failure-recovery scenarios remain required.

Publication requires the existing signed Windows build, independent signature verification, installed-upgrade acceptance and Mac preview build. A pushed version or a GitHub release entry alone does not publish the installers or update feed. Release results are recorded after the workflow completes.

## Publication status

Application source: `f208c4916df5f97b629e9cdc68cc6e47d60acbdb`. Production-channel candidate run: [40542438826](https://github.com/NarayanaSabari/worktrack/actions/runs/40542438826), with publication disabled pending successful checks.

On October 27, 2026, GitHub refused to start both the Windows build and Mac preview jobs. Their check annotations (`122324102548` and `122324102395`) report failed account payments or a spending limit that needs increasing. Both jobs have no assigned runner and no executed steps. Signature verification, installed-upgrade acceptance and publication were skipped. The updated Windows acceptance script passed a local PowerShell syntax parse, but its native UI checks have not run for this version.

Version 0.1.10 is pushed and prepared, not published. Fresh public manifest checks after the failure returned 0.1.8 for both Windows and Mac. No release tag, replacement installer or update manifest was published for 0.1.10.

The repository owner must resolve the GitHub billing or spending-limit issue before retrying that workflow. The local Windows build alternative below does not depend on GitHub Actions. For a workflow retry, dispatch the production-channel candidate for version 0.1.10 from the unchanged application source, inspect its verification and installed-upgrade evidence, then request publication using the verified candidate and evidence reference. Complete the separate Mac download acceptance before publishing its DMG. Do not replace existing immutable release artifacts or bypass the release checks.

## Local Windows cross-build, October 27, 2026

A Windows x64 NSIS installer was built successfully on this Apple Silicon Mac from clean committed source `4c17f651781ebb1a874f5b197eba242465e6e5ae`. No application-code changes were needed. The local path uses Rust 1.97.1, checksum-verified `cargo-xwin` 0.23.1, LLVM/LLD 23.1.4, NSIS 3.13 and Microsoft's downloaded MSVC/Windows SDK libraries. The optimized build completed in 3 minutes 24 seconds, followed by NSIS packaging.

- Installer: `WorkTrack_0.1.10_x64-setup.exe`, approximately 4.17 MiB.
- SHA-256: `06365e317389be46e24eae5a92ce0731794523395dc26c1168d944e446469856`.
- Static checks identify the application payload as a Windows AMD64 GUI executable. The NSIS bootstrapper is a normal 32-bit installer containing that x64 application. Imports were inspected; the build does not require a separately shipped Microsoft Visual C++ runtime DLL.
- Linker warnings concern unavailable Microsoft library debug-symbol files. The release executable and installer were produced successfully. Cross-compilation does not prove native execution.
- The local environment has neither `TAURI_SIGNING_PRIVATE_KEY` nor `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. This candidate has no updater signature and no Authenticode signature. The embedded updater verification key and endpoint are unchanged; its public key matches the VM's receiver key.
- The candidate, checksum file and build metadata are staged privately at `/var/lib/worktrack-release-candidates/0.1.10-06365e317389` on the existing VM. This directory is outside public download mounts.

This proves Windows builds can proceed without GitHub Actions or a dedicated Windows build PC. It does not complete Windows installation, data-preservation or updater acceptance. Public feeds remain on 0.1.8. Production promotion still requires the existing updater signing credentials, independent signature verification and Windows execution evidence. Never rotate the trusted key or publish a fabricated update signature as a workaround.

## Local signing completed, October 28, 2026

The signing credentials were already in envkit project `worktrack`. The earlier missing-credentials result came from automatic selection of the empty `NarayanaSabari__worktrack` vault. Selecting the original vault confirmed both credentials and an exact match between its public key and the committed app key. The repository's local `envkit.project` setting now selects `worktrack`; no secret values were displayed or copied, and no key was regenerated.

The exact existing installer was signed with Tauri's `--app-version 0.1.10`. `scripts/updater_release.py package` produced a production-channel candidate, and independent `minisign` verification passed alongside trusted-version, installer-checksum and canonical-production-URL checks. Installer bytes and SHA-256 remain unchanged.

- Detached signature SHA-256: `9f87213b4eb8b23ac64b72c639f63b3fe3adde477c6c0e3c710221a6541dce28`.
- Signed candidate archive SHA-256: `b945ae12df97899754187c324c4559496b4d042f01b365a8772e518a47e8547e`.

The signed archive and detached signature are staged in the same private VM candidate directory. Verification on the VM passed independently against `/etc/worktrack-updater/public-key.txt`, and both remote hashes match the local files. No public manifest was promoted.

The remaining release gate is native Windows installation/upgrade and data-preservation acceptance. A signed candidate alone does not prove those checks. The public update feed must remain unchanged until that evidence is available. Updater signing is separate from Authenticode publisher signing.
