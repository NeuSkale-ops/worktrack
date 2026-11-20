# WorkTrack 0.1.12: shorter start screen

Windows only. Mac stays at 0.1.8.

## Changes

- The monitoring notice on the sign-in and start screens now reads "Welcome to worktrack". The list of what is recorded and the Privacy details section are removed.
- The consent checkbox reads "I understand and agree to this monitoring".
- No change to what is recorded, to sync, or to the updater.

## Known deviation

`README.md` requires that workers receive a clear monitoring notice. From this version the desktop app no longer shows one. This was the owner's explicit decision on 20 November 2026. Workers need to be told what is recorded by another route.

## Release tooling

- The installed-upgrade gate (`scripts/updater_upgrade_acceptance.ps1`) no longer requires the recording notice on screen. It requires the welcome line and the consent checkbox.
- The browser checks in `agent/tests/updater.html` and `agent/tests/macos.html` no longer assert the notice content or the Privacy details.
- The production upgrade test downloads its pinned 0.1.5 baseline installer from `worktrack.neuskale.com`. The old `sslip.io` address no longer answers. The SHA-256 pin is unchanged.

## Validation

- The frontend production build and both browser test pages pass.
- Native build, signature verification and the installed-upgrade test run in the `Windows updater release` workflow. See that run for results.
