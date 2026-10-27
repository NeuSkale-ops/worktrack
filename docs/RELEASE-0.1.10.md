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

The repository owner must resolve the GitHub billing or spending-limit issue before retrying. Dispatch the production-channel candidate for version 0.1.10 from the unchanged application source, inspect its verification and installed-upgrade evidence, then request publication using the verified candidate and evidence reference. Complete the separate Mac download acceptance before publishing its DMG. Do not replace existing immutable release artifacts or bypass the release checks.
