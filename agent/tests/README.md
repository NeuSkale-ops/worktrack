# Updater UI browser tests

## Simplified worker screen

The worker screen omits technical monitoring-status and local location-diagnostic panels. A brief monitoring notice stays visible before consent and Start, with expandable privacy details. The current harness checks panel removal, absence of diagnostic IPC calls, the notice's content and position, consent, location permission, and the existing updater/status behavior.

The native location diagnostic and its privacy guards remain covered by Rust tests. The worker UI no longer invokes or displays that diagnostic.

## Status-clarity validation before panel removal (October 27, 2026)

The desktop usability pass was interpreted as targeted status clarity and recovery, not a full redesign or a new release. The production frontend build passed, as did 51 updater/status and seven macOS permission browser checks against the real React UI with mocked IPC.

A current Apple Silicon app bundle was also built and its ad-hoc signature verified. The actual packaged app launched with a fresh isolated HOME and an incompatible offline test queue, rendering the sign-in fields, native queue compatibility error, version and Mac manual-update guidance through real Tauri IPC. The Check for updates control was invoked through Accessibility, and the application exited through its native Quit menu. The original user's queue hash was unchanged and the isolated queued row was retained. No account was used and no monitoring or sensor permission was requested.

This packaged smoke test verifies the native/frontend startup boundary, not the new signed-in failure states. There is no supported public action to inject a transient native status-IPC failure while retaining the UI. Saving, stale-status recovery, Start/update gating, usable Stop and countdown behavior therefore remain covered by explicit mocked-IPC browser regressions. A real Windows installation and a new release were not exercised for this change.

## macOS permission checks

Open `http://127.0.0.1:1427/tests/macos.html` with the same Vite server for seven synthetic permission checks. These mock every native IPC call and verify Mac disclosure, explicit-only screen recording consent, settings actions, and Start gating. They do not request real consent or collect a device location.

Run the native delegate fixtures from the repository root:

```sh
xcrun clang -fobjc-arc -fblocks -Wall -Werror -framework Foundation -framework CoreLocation agent/src-tauri/src/location_macos_test.m -o "$JCODE_SCRATCH_DIR/location_macos_test"
"$JCODE_SCRATCH_DIR/location_macos_test"
```

These fixtures construct only synthetic `CLLocation` values and a delegate, never `CLLocationManager`. They check stale, future and inaccurate fixes, permission-only and cancelled states, and recoverable versus denied errors. Rust location tests cover state-change cancellation and diagnostic privacy. Real consent, packaged app identity, revocation and device positioning require a separately approved acceptance run. The provider uses the main run loop, stops after five seconds, and reports unknown source metadata instead of inferring Wi-Fi, GPS or IP.


This dependency-free harness runs the actual React app against mocked Tauri IPC.
It never contacts the update server, signs in a worker, or installs an update.
It is a separate Vite development entry point and is not imported by the production app or included in the normal production build.

## Run

From the repository root:

```sh
npm --prefix agent ci
npm --prefix agent run dev -- --port 1427
```

Open `http://127.0.0.1:1427/tests/updater.html` in a normal browser.
Wait for `PASS: 40 synthetic browser checks` above the app.
A failed check prints `FAIL` with its description and stack trace.
Reload the page to rerun.
Keep the tab visible to avoid background timer throttling.
Stop Vite with Ctrl+C when finished.

The result is also exposed as `document.documentElement.dataset.testResult`, with `passed` or `failed` after completion.
Automation can wait for that attribute and read `#results` without adding a test library.
The harness uses bounded polling for React updates instead of assuming immediate rendering.
It records and invokes the real app's status-poll callback to test backend state changes.
It checks registration of the six-hour interval, not six hours of real elapsed time.

## Coverage and limits

The checks cover startup and manual discovery, StrictMode duplicate-check protection, installed versus available versions, release notes, Later without installation, reopening the offer, tracking and queue safety, failed-check stale-offer invalidation, no-update display, explicit versioned installation, reservation gating, known and unknown download sizes, installation progress, failure recovery, sign-in gating, and neutral unavailable-build messaging.

The checks also cover unsaved final-stop gating with sign-in renewal still available, and actionable missing-feed errors without blaming the worker's connection. Five status-clarity checks verify the saving state, status-loss Start/update gating, automatic recovery, remaining-time accessibility text, and an available Stop action without a stale countdown or green tracking indicator. These use mocked IPC failure, not a native process crash.

The screen checks verify that technical panels and the local diagnostic action are absent, that no diagnostic IPC request occurs, and that internal diagnostic-delivery failures do not block tracking. The visible notice names time, input activity, app use, screenshots and location before consent. Expandable privacy details explain signed-in diagnostics, access and retention. Permission alone cannot bypass consent, and Start passes explicit consent to the native command.

The harness also checks that no location or diagnostic off switch exists, that the app requests Windows location after sign-in, that Start stays disabled until location is granted, the settings shortcut IPC, retry, and that the disclosure names both requirements. It does not access a real Windows location provider.
`tests/preview.html?state=signedout|stopped|blocked|tracking|paused` renders single states for visual review.
These are synthetic browser tests of frontend behavior, not proof of updater signatures, backend concurrency safety, Windows installation, restart, or data preservation.
The signed Windows upgrade acceptance gates in `docs/AUTO-UPDATE-PLAN.md` still require a connected Windows environment.
