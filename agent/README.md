# WorkTrack desktop agent V1

Windows-first Tauri 2 application with React and TypeScript.
No projects, autostart, hidden tracking, keyboard hooks, or keylogging.
The source includes an opt-in signed updater for release-configured builds.
Development builds reject update checks. Unsigned CI installers clear the trusted update key and endpoints, so they cannot install updates.

## Worker sign-in and updates

Version 0.1.1 pins the server origin to `https://worktrack.178.156.213.40.sslip.io` in Rust.
Workers enter only their invited account email and password, with no server URL field.
The invite creates their account when accepted, but installation and Start remain explicit actions.

There is no update check, update notification, or automatic installation in versions 0.1.0 or 0.1.1.
Publishing a GitHub release alone does not update installed agents.
Stop tracking, wait until queued records reach zero, quit the agent, and run the new per-user installer manually.
Do not uninstall or remove application data as an update shortcut.
See `docs/AUTO-UPDATE-PLAN.md` for the update safety requirements and `deploy/UPDATES.md` for release setup.
Adding this feature to source does not retrofit an updater into already-installed versions.
Workers must manually install the first signed-updater-enabled release once.
Updater signatures authenticate downloaded updates but are not Windows publisher signatures and do not remove SmartScreen warnings.

Existing credentials and queued records for the pinned origin retain the same application identifier and storage paths.
Pending records from a different server are never redirected into this workspace.
Sync such records using version 0.1.0 before upgrading.
The new version blocks sign-in if it finds an incompatible pending queue rather than deleting or moving evidence.

## Run and package

Use Node 22.12+ and current stable Rust with the Windows MSVC build tools and WebView2 installed.

```sh
npm ci
npm run tauri -- dev
npm run tauri -- build --bundles nsis
```

The NSIS configuration installs for the current user without elevation.
The resulting installer is not code-signed by this repository.
Windows SmartScreen and organization application policies may block unsigned builds.
Do not bypass organization security policies.
The deployment worker owns Windows CI outside `agent/`.

Portable checks:

```sh
npm run build
cd src-tauri
cargo check --locked
cargo test --locked
cargo clippy --locked -- -D warnings
```

## Monitoring and privacy

- The window opens visibly and tracking is off on every launch.
- Start requires sign-in and an explicit disclosure checkbox.
- The tray shows tracking state and provides Open / Start, Stop, and Stop and quit.
  Starting from the tray opens the disclosure window rather than bypassing consent.
- Closing the window stops tracking before hiding it in the tray.
- Screenshots target exactly 600, 1200, 1800, and subsequent elapsed running seconds.
  There is no randomized capture, immediate Start capture, stopped capture, or catch-up burst after sleep.
  Windows is not a real-time operating system: the 100 ms collector dispatches at the first available scheduler tick after the boundary, and capture/encoding adds latency.
- Only the primary monitor is captured, downscaled to fit 1920 x 1080 and JPEG encoded at quality 65.
- Foreground application executable names and estimated milliseconds per app are sampled only during unlocked tracking, including idle time. No window titles, full executable paths, document names, or browser URLs are collected. Executable names are limited to 64 characters. At most 32 names per block are retained, with overflow grouped as Other and inaccessible processes as Unknown. Hosted UWP/PWA/browser windows can share an executable name.
- Location is mandatory and has no off switch. After sign-in the app requests Windows location permission (`request_location`) and Start is refused until it is granted. The blocked state offers **Open location settings** (`ms-settings:privacy-location`) and **Try again**. Automatic tracking requests a fresh Windows geolocation fix only at screenshot boundaries, never continuously, with a five-second timeout. Coordinates, accuracy, fix time, and the screenshot block timestamp are queued together. A stale or unavailable fix during tracking is recorded as unavailable and does not stop time or screenshots. WorkTrack implements no separate IP-based location fallback; the Windows service may use IP or default-location estimates.
- Location requests run outside the tracking mutex and are cancelled/ignored after Stop, lock, or consent/account changes. Pending fixes expire to unavailable within ten seconds so upload cannot remain blocked. No fix is obtained later during offline replay. Queued location/app data uses the existing account-bound durable tracking queue, not diagnostic logs.
- `GetLastInputInfo` exposes a last-input timestamp, not typed content.
  Active time is sampled when that input is less than one second old, and idle time is the remaining running time.
  This is an activity estimate, not an exact count of input events.
- The input desktop must be accessible, named Default, and switchable.
  Secure desktops, lock screens, and API failures fail closed.
  The desktop is checked again after capture and unsafe images are discarded.
- Locked time and scheduler gaps over two seconds are excluded.
  Resuming uses a fresh wall-clock segment without changing the fixed elapsed capture boundaries.
  Privacy guards are polling-based and need real Windows lock/suspend validation before deployment.
- Offline records can upload while stopped, but no new automatic monitoring occurs. The worker screen shows a brief monitoring notice and consent before Start, with expandable privacy details. Technical monitoring-status and local location-diagnostic panels are omitted. For explicit Windows location troubleshooting, use `scripts/location_diagnostics.ps1`; its result does not correct old screenshots or certify the machine's physical position.

For Windows location, check **Settings > Privacy & security > Location**, including location services and desktop-app access. Keep WorkTrack visible when allowing location, then use **Try again** if permission was denied. Permission is required to start tracking; a later unavailable fix does not stop tracking. A PC without a reliable GPS/Wi-Fi fix may provide no coordinates or an inaccurate estimate. Windows itself may use IP address or a configured default location even though WorkTrack has no separate IP-geolocation fallback.

Workers, managers, and the owner can view location and app-use records through the existing timeline permissions. Deleting a screenshot clears its location from the live database but keeps app usage and tracked time. Deleting a time block clears both metadata types. Database backups retain their separate snapshots. These are client-reported estimates, not proof of attendance or productivity.

## Durable offline delivery

`queue.sqlite3` lives in the per-user application local-data directory.
SQLite uses full synchronous commits and a rollback journal.
Time blocks are committed every 30 running seconds, at capture boundaries, on pause, and on Stop.
Partial final blocks contain whole seconds and no forced screenshot.
An abrupt process termination can lose the unfinished interval, normally less than 30 seconds, plus fractional seconds at pause/stop.
The active session and last durable checkpoint are persisted atomically with queue records.
On restart an interrupted session is closed at its last durable checkpoint and tracking stays off.

Delivery follows `server/API.md`: device login, client UUID session start, block batches, presign plus raw JPEG PUT, session stop, and independent 30-second heartbeats while running.
Records are delivered FIFO with exponential retry capped at five minutes.
A successful object upload is saved as an immutable screenshot key before posting the block, so a lost block response does not cause a second presign request for an already-finalized block.
The original JPEG remains in the bounded SQLite queue until the block acknowledgement is committed.
If the server returns the specific `upload_expired` code, only the staged key is cleared and the same block UUID and retained JPEG are uploaded again on retry.
Other failures do not trigger reupload or silently discard data.
Permanent refusals (HTTP 400, 403, 404, 409, 410, 413 or 422, other than `upload_expired`) keep retrying for 24 hours from the first refusal in a streak. After that the refused head record moves to a local `rejected` table, newer records continue to sync, and the app shows the count. Further refusals in the same streak move aside immediately, and any accepted record resets the streak. The newest 20 rejected records, including JPEG bytes, are kept for support and never resent automatically. A `sync_rejected` diagnostic is recorded when diagnostics are enabled. 401, 429 and 5xx responses never set records aside.
No bearer token is sent to object storage.

The server URL defaults to the production origin. Set `WORKTRACK_SERVER_URL` at build time for a staging build, and change the updater endpoint in `tauri.conf.json` separately.

The payload budget is 256 MiB, with 64 KiB reserved for Stop records.
The database is capped at 73,728 SQLite pages, normally 288 MiB at 4 KiB/page.
A temporary rollback journal can add up to another database-sized allocation during a transaction.
Space is reused after acknowledgements, without automatic deletion of unsent evidence.
At the queue limit or on a capture/storage error, tracking stops and the window displays an error.
A failed Stop write leaves durable active-session recovery information and prevents a new Start until recovery.
Physical disk failure cannot guarantee a new commit.

The server rejects data older than seven days.
A permanent server rejection is retained, reported, and retried rather than silently dropping evidence.
An administrator must resolve permanently rejected records before the FIFO queue can progress.
There is no destructive purge button in V1.
If the original computer or app data is lost while tracking, sign in to the dashboard and use Recover my session after its heartbeat has been absent for two minutes. Stop and sync the original computer instead whenever possible. Recovery closes at the last uploaded block and can cause later unsynced records from the original computer to be rejected.

## Credentials and transport

Passwords are used only for login and are not written to disk.
Device tokens are stored using the OS credential service, including Windows Credential Manager.
Sign out revokes the device token on the server before removing its local copy. Network or server failures retain the saved sign-in for retry. An already expired or revoked token can still be removed locally.
Failure to store a token fails login rather than falling back to plaintext.
SQLite stores the server origin and normalized account email, never the token.
The Renew sign-in action remains available with queued records and only permits the same server/account until those records sync.

HTTPS is required, except explicit loopback HTTP for local development.
TLS certificate validation is enabled and HTTP redirects are disabled.
The WebView has no direct network access to the server, all authenticated requests run in Rust.
Screenshots and activity in SQLite are not encrypted at rest.
Protect the Windows user profile and use device encryption for sensitive deployments.

## Diagnostic logs

Diagnostics are mandatory. They turn on at sign-in and at startup when a saved sign-in exists, and turn off only at sign-out. The desktop monitoring notice explains them, with no off switch or technical delivery-status panel.
They may upload while tracking is stopped.
The owner can open **Desktop diagnostic logs (owner only)** below the dashboard timesheet and click **Load recent logs**.

Only fixed failure codes, event UUIDs, UTC timestamps, optional numeric HTTP status, and the compiled app version are sent to `POST /api/agent/logs` using the existing device credential.
The backend links them to the authenticated account and supplies fixed severity/messages. Raw error text, URLs, passwords, tokens, screen contents, typed content, and computer names are not diagnostic payload fields.
Events cover sign-in requests while already signed in, sync, screenshot capture, input sampling, local queue writes, heartbeats, and update checks/installations.
Errors before the first sign-in and startup/crash failures cannot be uploaded through this consent/authentication path.

A separate background thread uploads at most 20 events every 30 seconds, with a five-second request timeout and retry backoff up to five minutes.
It never holds the tracking mutex during network work and never uses, clears, or blocks the durable tracking queue.
Repeated consecutive code/status pairs are coalesced for one minute, including after acknowledgement.
The memory-only buffer holds at most 100 events, discards the oldest on overflow, and loses pending events on exit or sign-in changes. Events older than seven days are discarded.
Signing out clears unsent events immediately. An already in-flight request may finish, but its acknowledgement cannot clear events from a new account snapshot.
Delivery failures retry in the background, never as tracking failures or recursively generated log events.

The API accepts at most six diagnostic requests per account per minute and 120 new events per account per hour. Diagnostic quota failures retry without affecting tracking.
Owners see the newest 100 retained events. Logs older than seven days are hidden immediately and deleted hourly from the live database. Existing database backups follow their separate backup retention policy.
Diagnostics first ship in the manually installed v0.1.3 release; the immutable v0.1.2 installer does not include them.
Deploy the updated API before distributing the new installer. Automatic-update manifest publication remains gated on real signed-upgrade and data-preservation acceptance.

## Release acceptance checklist

Portable compilation and synthetic tests do not establish Windows acceptance.
Before distributing an installer, test on a real Windows account:

1. Install per-user without administrator elevation, launch twice, and confirm a single visible instance.
2. Sign in, accept disclosure, Start, and observe one primary-display capture at each 10-minute running boundary.
3. Stop before a boundary and confirm no screenshot, then confirm partial time uploads.
4. Lock before a boundary, wait, unlock, and confirm no lock-screen image and no counted locked time.
5. Suspend/resume, use UAC secure desktop, disconnect/reconnect RDP, and switch users.
6. Disconnect networking, restart the process, reconnect, and confirm ordered deduplicated delivery.
7. Reject a block response after successful upload and confirm retry keeps the same screenshot key.
8. Expire a token with queued records and confirm Renew sign-in preserves the queue and account ownership.
9. Fill the queue or deny disk writes and confirm visible stopped/error state with no further captures.
10. Verify Credential Manager storage, uninstall behavior, SmartScreen, and production signing policy.
