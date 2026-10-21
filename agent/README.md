# WorkTrack desktop agent V1

Windows-first Tauri 2 application with React and TypeScript.
No projects, autostart, updater, hidden tracking, keyboard hooks, or keylogging.

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
- `GetLastInputInfo` exposes a last-input timestamp, not typed content.
  Active time is sampled when that input is less than one second old, and idle time is the remaining running time.
  This is an activity estimate, not an exact count of input events.
- The input desktop must be accessible, named Default, and switchable.
  Secure desktops, lock screens, and API failures fail closed.
  The desktop is checked again after capture and unsafe images are discarded.
- Locked time and scheduler gaps over two seconds are excluded.
  Resuming uses a fresh wall-clock segment without changing the fixed elapsed capture boundaries.
  Privacy guards are polling-based and need real Windows lock/suspend validation before deployment.
- Offline records can upload while stopped, but no new monitoring occurs.

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
No bearer token is sent to object storage.

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

## Credentials and transport

Passwords are used only for login and are not written to disk.
Device tokens are stored using the OS credential service, including Windows Credential Manager.
Failure to store a token fails login rather than falling back to plaintext.
SQLite stores the server origin and normalized account email, never the token.
The Renew sign-in action remains available with queued records and only permits the same server/account until those records sync.

HTTPS is required, except explicit loopback HTTP for local development.
TLS certificate validation is enabled and HTTP redirects are disabled.
The WebView has no direct network access to the server, all authenticated requests run in Rust.
Screenshots and activity in SQLite are not encrypted at rest.
Protect the Windows user profile and use device encryption for sensitive deployments.

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
