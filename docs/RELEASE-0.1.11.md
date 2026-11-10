# WorkTrack 0.1.11: new server address

Windows only. Mac stays at 0.1.8.

## Changes

- The app now connects to `https://worktrack.neuskale.com` instead of `https://worktrack.178.156.213.40.sslip.io`.
- On first launch, it moves the saved sign-in and any unsynced offline records from the old address. Workers do not need to sign in again.
- Update checks use `https://worktrack.neuskale.com/updates/windows/x86_64/latest.json`.

## Server side

Until the database moves to the new Nuremberg server, `worktrack.neuskale.com` proxies to the existing server. Both addresses therefore reach the same database. The final cutover only changes where `worktrack.neuskale.com` points.

## Validation

43 Rust tests (one physical-console test ignored), including three migration tests, and 22 updater-helper tests pass. GitHub Actions is still blocked by billing, so the build is a local cross-build and native Windows runtime testing was not performed.
