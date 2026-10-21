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
Wait for `PASS: 26 synthetic browser checks` above the app.
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

The harness also checks default-off location consent, app-usage disclosure, explicit location opt-in IPC, and opting out during an update reservation. It does not access a real Windows location provider.
The harness also checks default-off diagnostic consent, explicit opt-in IPC, independent delivery status, opting out during an update reservation, and blocked opt-in while reserved or signed out.
These are synthetic browser tests of frontend behavior, not proof of updater signatures, backend concurrency safety, Windows installation, restart, or data preservation.
The signed Windows upgrade acceptance gates in `docs/AUTO-UPDATE-PLAN.md` still require a connected Windows environment.
