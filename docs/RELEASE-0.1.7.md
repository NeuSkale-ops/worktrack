# Windows diagnostic release 0.1.7

Published on October 22, 2026 from commit `30e257e53d29aa3c29aa070e9ce2e83da930fdb0`.
GitHub Actions run `39729490105` completed build, independent verification, installed Windows acceptance, and production publication successfully. GitHub tag `v0.1.7` is a published preview release with the same installer bytes.

## Requirement-to-check results

| Requirement | Observed check and result |
| --- | --- |
| Installable new Windows version | Real signed updater installed 0.1.7 over the pinned 0.1.5 baseline. Executable changed, expected product version matched, and restart succeeded. |
| Keep existing local state | Native Windows checks preserved seeded OS-keyring identity, settings, and rejected records across install and restart. Offline queued records disabled Update and remained intact. This is not a connected worker login or sync-drain test. |
| Explicit local diagnostic | Real WebView button invoked the native command. Hosted Windows denied permission with the expected actionable error. Clear removed the error, controls recovered, and stopped state and local data remained intact. No successful sensor fix or physical accuracy is claimed. |
| Display source and coordinates safely | Rust tests checked source labels, nullable metadata, freshness, cancellation and privacy. Synthetic browser checks exercised complete reports, unknown values, clearing, account changes and single flight. Successful Windows sensor rendering still needs the affected PC. |
| Reject unsafe updater inputs | Installed baseline rejected missing/invalid feeds, modified installer bytes, wrong-key signatures and interrupted downloads without changing its executable. |
| Recover from hung download | Installed 0.1.7 recovered after 604.97 seconds, retained its executable and state, and completed a subsequent real update check. |
| Publish the tested bytes | Public HTTPS manifest matched the candidate manifest. Downloaded installer, signature and SHA256SUMS matched the tested archive byte-for-byte. Committed trust anchor and independent signature verification passed. |
| Preserve service availability | Public dashboard, health endpoint and existing 0.1.5 manual installer returned HTTP 200 after publication. |

All 14 installed Windows scenarios passed with no cleanup errors. Evidence archive SHA256: `b6456215832b45ffa2fc5e85b919f6045b44715afe85f8b727d66958d4050271`.
Installer SHA256: `55d9a508a6af86e52e481ce56e7b0dfb71ee886b90ae9e8e9e975ca7ea4a1786`.
Local checks also passed: 35 Rust tests, clippy with warnings denied, formatting, production frontend build, 46 synthetic browser checks, 22 updater/signature tests, PowerShell parser, actionlint and whitespace validation.

## Affected-PC check still required

Stop tracking and wait for queued records to sync before installing. Sign in, allow Windows location access, keep tracking stopped, and select **Run local location diagnostic**. Review source, remote-source status, coordinates, accuracy radius and request/fix timestamps. Use **Clear location diagnostic** afterward. Coordinates are sensitive and stay local to this test.

This release does not fix or prove physical location accuracy. Historical screenshot records lack provider metadata and remain unchanged. Connected worker authentication, actual queue drainage, active tracking, screenshot capture, successful sensor access and installer cancellation were not exercised by the hosted acceptance run. The updater signature does not imply Authenticode signing or SmartScreen reputation.
