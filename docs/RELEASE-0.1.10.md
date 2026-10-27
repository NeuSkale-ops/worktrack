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
