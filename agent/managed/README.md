# WorkTrack managed-device agent

Disclosed monitoring agent for **company-owned** Windows laptops, deployed by
Intune and controlled from the WorkTrack dashboard. This is a separate program
from the per-user Tauri desktop app in `../src-tauri` (which is unchanged and
still serves personal PCs with explicit Start/Stop). Nothing here is covert:

- The installed service and program are discoverable (Services console, Programs
  and Features). No process hiding, no Task Manager blocking, no keylogging.
- Capture is config-driven and admin-gated. A visible tray indicator runs in the
  user session whenever capture is active, and the user acknowledges monitoring
  once on first logon. Tamper resistance comes only from least privilege: the
  service runs as LocalSystem with an ACL that denies stop/config/delete to
  non-admins, and uninstall is gated behind admin/Intune.

## Layout

- `src/config.rs`  capture config schema and validation (versioned).
- `src/redact.rs`  exclusion lists and field redaction, enforced at capture time.
- `src/buffer.rs`  durable SQLite WAL buffer: seq, encryption-at-rest hook, caps,
  coarsening under pressure, corruption recovery.
- `src/sync.rs`    batch builder, backoff schedule, ack-prune (exactly-once).
- `src/update.rs`  self-update: pick a newer pinned release, verify SHA-256.
- `src/bin/worktrack-svc.rs`     Windows service host (LocalSystem). cfg(windows).
- `src/bin/worktrack-session.rs` per-user helper: tray, ack screen, collectors.

Core modules are platform-independent and unit-tested on any OS:

```sh
cd agent/managed
cargo test
cargo clippy -- -D warnings
```

The service and helper binaries are Windows-only and are built in Windows CI.
