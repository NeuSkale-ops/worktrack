# WorkTrack macOS Apple Silicon preview

This is an **ad-hoc signed, not notarized preview**, not a Developer ID release.
It targets Apple Silicon (`aarch64-apple-darwin`) on macOS 11 or newer. Intel and universal builds are not validated.
Gatekeeper can block a browser-downloaded preview. Do not disable Gatekeeper or strip quarantine to distribute it.
Automatic updates are disabled. Install a later approved build manually.

On October 22, 2026, `security find-identity -v -p codesigning` reported **0 valid identities** on the build Mac.
No signing credentials were read, created, imported or uploaded.

## Local build

From the repository root on an Apple Silicon Mac with Xcode command-line tools, Node 22 and stable Rust:

```sh
python3 scripts/macos_preview.py
python3 -m unittest discover -s scripts -p 'macos_preview_test.py' -v
rustup target add aarch64-apple-darwin
cd agent
npm ci
APPLE_SIGNING_IDENTITY=- npm run tauri -- build --target aarch64-apple-darwin --bundles app,dmg --config ../deploy/macos-preview.json -- --locked
```

Outputs are under `agent/src-tauri/target/aarch64-apple-darwin/release/bundle/`.
The automatic `tauri.macos.conf.json` overlay also clears the Windows updater key and endpoint for ordinary Mac builds.
The explicit preview overlay repeats that boundary so CI cannot inherit a future updater-enabled Mac default.
`Info.plist` supplies location permission descriptions, not permission grants. The user must approve native privacy prompts.

## Future pipeline

`.github/workflows/macos-preview.yml` runs on relevant PRs and main pushes, accepts manual dispatch, and supports `workflow_call`.
The Windows updater release workflow calls it as an isolated job without inherited secrets, including when reusing a Windows candidate.
Mac builds use the current reviewed source, while a reused Windows candidate keeps its recorded provenance.
The Windows publish job requires Mac preview success in addition to every existing Windows approval and verification gate.
A passing Mac build does not publish Mac downloads or authorize Windows publication by itself.

The job checks updater isolation, runs backend tests, builds app and DMG, verifies ARM64 and ad-hoc signing,
and retains a preview ZIP, DMG, checksums, candidate `latest.json` and source commit/run provenance as a 14-day CI artifact named `macos-preview`.
It does not publish a GitHub Release, deploy the website, dispatch another workflow, or create an updater manifest.
Future CI execution uploads only a repository CI artifact, not a website download or GitHub Release.

The candidate manifest uses `{version, architecture: "aarch64", url, sha256, signing: "ad-hoc", notarized: false}`.
Its relative same-origin URL is `/downloads/macos/{version}/WorkTrack_{version}_aarch64.dmg`.
It is website download metadata, not a Tauri updater manifest. Generating it does not claim it is published.

Website publication requires separate operator approval: validate exact bytes and `SHA256SUMS`, install and test on a clean Mac,
then place the approved DMG on a versioned Mac-specific download path and label the link **Apple Silicon preview, not notarized**.
Never point Mac downloads or Mac updater code at `/updates/windows/x86_64/latest.json` or the Windows updater receiver.
Do not describe availability on the website before the file is present and its download checksum is verified.

## Gate for a supported signed Mac release

1. Obtain a real Developer ID Application identity and notarization access through the owner's Apple Developer account.
2. Add a separate protected Mac signing environment. Do not reuse Windows updater/deploy secrets.
3. Replace ad-hoc signing in a reviewed release-only overlay, sign, notarize and staple the application/DMG.
4. Verify signing identity, notarization, downloaded installation, screen capture consent, idle/lock/sleep behavior,
   native location allow/deny handling, login, offline sync and existing-data preservation on a clean Mac.
5. Add separately signed Tauri Mac updater artifacts and architecture-specific manifests only after an actual Mac upgrade test.
   Apple signing/notarization and Tauri updater signatures are separate trust requirements.
6. Add a Mac-specific publisher and protected approval. The current updater packaging/receiver accepts Windows artifacts only.
   Do not enable Mac updater endpoints until that complete signed pipeline and recovery path pass.

Official references reviewed October 22, 2026:

- https://v2.tauri.app/distribute/sign/macos/ (ad-hoc identity `-`, Developer ID and notarization)
- https://v2.tauri.app/distribute/macos-application-bundle/ (app packaging and `Info.plist` merge)
- https://v2.tauri.app/reference/config/ (automatic platform configuration merge)
- https://v2.tauri.app/plugin/updater/ (signed updater artifacts and platform manifests)
- https://docs.github.com/en/actions/reference/runners/github-hosted-runners (ARM64 `macos-15` runner)
