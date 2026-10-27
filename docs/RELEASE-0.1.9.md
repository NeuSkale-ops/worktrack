# WorkTrack 0.1.9: clearer desktop status and recovery

## Changes

- Shows "Saving tracked time" while the final interval is still being saved.
- Reports unavailable app status instead of claiming records are synced or showing a green tracking indicator and stale screenshot countdown.
- Disables Start and update installation while status is unavailable, while keeping Stop usable if tracking was last reported active.
- Automatically clears the temporary status warning when status polling recovers.
- Screen readers announce the actual time remaining until the next screenshot.

## Installation and limits

Stop tracking and let records sync before installing. Signed Windows builds check for updates automatically and install only after selecting Update now. Mac remains an Apple Silicon preview, ad-hoc signed, not notarized, with manual updates only.

This release does not change location providers or certify physical location accuracy. Existing location source and uncertainty reporting remains intact. No server or database changes are required.

## Validation

The prior source passed 51 updater/status browser checks and seven Mac permission checks against the real React app with mocked native IPC. Current release checks and artifact publication must also pass before this version is described as available. The new status-failure behavior is regression-tested through mocked IPC because there is no supported public native status-fault injection action. A packaged Mac startup/quit smoke test does not replace that fault-path test.
