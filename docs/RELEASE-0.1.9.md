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

The versioned source passed 40 native Rust tests (one physical-console test ignored), 22 release-helper tests, the production frontend build, and 51 updater/status plus seven Mac permission browser checks. The new status-failure behavior is regression-tested through mocked IPC because there is no supported public native status-fault injection action. A packaged Mac startup/quit smoke test does not replace that fault-path test.

## Publication status

Application source: `bd4ec635a9a8f6738d0c689cd87203cf70b60a04`. Production release run: `40518307240`.

On October 27, 2026, GitHub refused to start the Windows build job. Check annotation `122237836392` states that recent account payments failed or the spending limit must be increased. The job had no runner and no executed steps. Verification, installed upgrade and publication did not run. This is an external account prerequisite, not an application test failure.

Version 0.1.9 is prepared, not published. Existing public Windows and Mac downloads remain 0.1.8. After the repository owner resolves GitHub billing or spending limits, rerun the release workflow for the frozen application source and complete all signature, installed-upgrade and public-download checks. Do not bypass those gates or replace the existing immutable artifacts.
