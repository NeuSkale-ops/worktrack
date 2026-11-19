# WorkTrack 0.1.12: updated app text

Windows only. Mac stays at 0.1.8.

## Changes

- Wording changes in the desktop app (`agent/src/main.tsx`), written by the owner and committed as written.
- No change to what is recorded, to sync, or to the updater.

## Release tooling

- The production upgrade test downloads its pinned 0.1.5 baseline installer from `worktrack.neuskale.com`. The old `sslip.io` address no longer answers. The SHA-256 pin is unchanged.

## Validation

- The frontend production build passes.
- The mocked-IPC browser checks in `agent/tests/updater.html` were not rerun. Some assert the previous notice wording and may need updating.
- Native build, signature verification and the installed-upgrade test run in the `Windows updater release` workflow. See that run for results.
