# Updater UI browser tests

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
Wait for `PASS: 46 synthetic browser checks` above the app.
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

The checks also cover unsaved final-stop gating with sign-in renewal still available, and actionable missing-feed errors without blaming the worker's connection.

The local location diagnostic checks cover explicit-only invocation, native permission denial, safe error allowlisting, single-flight duplicate clicks, loading/action gates, readable source/remote/coordinates/accuracy/timestamps, unavailable values, clearing, renewal/start/logout/auth-loss cleanup, and stale completion suppression. The original 29 checks remain included in the 46 total checks.

Contract assumptions: `diagnose_location` takes no arguments and returns the documented nullable location report. Native code enforces permission, unlocked/stopped state and single-flight safety, performs at most one provider request, and never queues, uploads or logs the report. Missing permission deliberately leaves the button enabled so native denial is visible. Only four known fixed native errors are shown; arbitrary native error strings use a fixed generic fallback. Browser mocks cannot prove these backend privacy guarantees or real Windows provider behavior.

The harness also checks that no location or diagnostic off switch exists, that the app requests Windows location after sign-in, that Start stays disabled until location is granted, the settings shortcut IPC, retry, and that the disclosure names both requirements. It does not access a real Windows location provider.
`tests/preview.html?state=signedout|stopped|blocked|tracking|paused` renders single states for visual review.
These are synthetic browser tests of frontend behavior, not proof of updater signatures, backend concurrency safety, Windows installation, restart, or data preservation.
The signed Windows upgrade acceptance gates in `docs/AUTO-UPDATE-PLAN.md` still require a connected Windows environment.
