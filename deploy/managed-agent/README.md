# WorkTrack managed-agent deployment (Intune Win32)

Disclosed monitoring agent for **company-owned** Windows laptops. Deployed and
controlled by IT, visible to the user. This folder packages the agent for
Microsoft Intune and hardens it so a standard (non-admin) user cannot stop,
reconfigure or remove it, using least privilege only, no stealth.

## What is here

- `install.ps1`   per-machine install run by Intune as SYSTEM: lays down the
  service and session helper, hardens ACLs/SDDL, sets service recovery, enrolls
  the device with a one-time secret.
- `uninstall.ps1` authorized removal (Intune uninstall assignment or dashboard
  `uninstall` command). Flushes the buffer, stops and deletes the service.
- `detect.ps1`    Intune detection rule (service present + binary on disk).

## Build the payload

On a Windows build host with the MSVC toolchain:

```sh
cd agent/managed
cargo build --release
```

Copy `target/release/worktrack-svc.exe` and `worktrack-session.exe` next to the
scripts, then wrap the folder with the Microsoft Win32 Content Prep Tool
(`IntuneWinAppUtil.exe`) into a `.intunewin`.

## Intune app configuration

- Install command:
  `powershell.exe -ExecutionPolicy Bypass -File install.ps1 -EnrollSecret "<secret>" -Server "https://worktrack.neuskale.com"`
  Mint `<secret>` in the dashboard (owner -> Devices -> Add). It is one-time and
  expires in 7 days. Prefer a per-ring secret via an Intune variable.
- Uninstall command:
  `powershell.exe -ExecutionPolicy Bypass -File uninstall.ps1`
- Detection: custom script `detect.ps1`.
- Install behavior: System. Device assignment.

## Why a standard user cannot stop it (least privilege only)

- The service runs as **LocalSystem**, auto-start, so it begins before any user
  logs in. A standard user is not an administrator, so:
  - Service SDDL (`sc sdset`) grants SYSTEM and Administrators stop/config/delete;
    interactive users get read/query only. The service is **visible** in the
    Services console but cannot be stopped or reconfigured by a non-admin.
  - `C:\ProgramData\WorkTrack` ACL denies Users all access; `Program Files\WorkTrack Agent`
    is read/execute only. The buffer is also sealed with machine DPAPI.
  - Service Recovery auto-restarts the service after a crash.
  - The session helper is launched by the service with a security descriptor that
    withholds PROCESS_TERMINATE from the user: it still shows in Task Manager
    (no hiding) but the user cannot kill it. If it dies anyway, the service
    relaunches it and records a gap event.
- Uninstall requires SYSTEM/admin (Intune or the dashboard command), so a user
  hits the elevation wall.

## Honest limit (stated plainly)

A **local administrator** can always stop or remove this agent. That is a
property of Windows, not a gap to paper over with stealth. The control is
organizational: employees are standard users, IT holds admin, and a missed
heartbeat raises an alert in the dashboard. We do not hide the process, block
Task Manager, disable security tools, or capture credential fields.

Offline disk-image theft of the buffer is out of scope for DPAPI+ACL; enforce
BitLocker via Intune compliance policy for that.

## Code signing

The service binary and scripts should be Authenticode-signed so Defender, ASR
and SmartScreen pass with Defender fully enabled. Do not ship an ASR/Defender
off switch. If no signing cert is available yet, scope a reversible Intune ASR
path exclusion for the install dir as an MVP interim, never a global disable.
