# IT QA checklist: managed-device agent (before fleet rollout)

Run on a real Intune-enrolled test laptop with a standard (non-admin) test user.
This checklist is manual acceptance; the automated suite (`cargo test`, Go
`TestDevicesHTTP`, the `managed-agent` Windows workflow) covers the units but not
the live OS behavior below.

## Install and boot
- [ ] Push the Win32 app from Intune. Install reports success; detection passes.
- [ ] Service `WorkTrackAgent` is visible in services.msc, Automatic, LocalSystem.
- [ ] Program is listed and discoverable (no hiding).
- [ ] Reboot without logging in. Confirm the service is Running and the device
      checked in (dashboard Last check-in updates) before any user login.

## First logon and disclosure
- [ ] First logon of the test user shows the one-time monitoring acknowledgment.
- [ ] A persistent tray indicator appears while capture is active.
- [ ] Second logon does not re-prompt but capture continues.
- [ ] A second Windows user on the same laptop gets their own first-run notice.

## Tamper resistance (standard user) — all must FAIL with access denied
- [ ] `sc stop WorkTrackAgent`
- [ ] `sc config WorkTrackAgent start= disabled`
- [ ] `sc delete WorkTrackAgent`
- [ ] `taskkill /IM worktrack-svc.exe /F`
- [ ] `taskkill /IM worktrack-session.exe /F` (helper terminate denied)
- [ ] Delete/modify `C:\ProgramData\WorkTrack` and `Program Files\WorkTrack Agent`
- [ ] `msiexec /x` or run uninstall.ps1 as the standard user (elevation wall)
- [ ] Both processes remain visible in Task Manager (we do not hide them).

## Capture scope and privacy
- [ ] Add an app to the exclusion list in the dashboard; confirm it is recorded
      as "Excluded", never by name, after the next config check-in.
- [ ] Lock the screen / UAC secure desktop: no screenshot is captured.
- [ ] No window titles, URLs, file paths, or keystrokes appear in any record.
- [ ] Screenshots and location only when enabled in config; off by default.

## Offline and sync
- [ ] Disconnect network for 48h while using the laptop. Buffer grows, capped.
- [ ] Reconnect: buffered events sync; dashboard Last sync advances; buffer drains.
- [ ] Pull network mid-upload; confirm resume with no duplicates and no loss.
- [ ] VPN-only network: check-in and sync still work (poll model, no inbound port).
- [ ] Sleep/hibernate then resume: no catch-up burst, intervals stay clean.

## Admin control plane
- [ ] Pause from the dashboard; capture stops within one check-in, heartbeat stays.
- [ ] Resume; capture restarts.
- [ ] Disable; capture stops, device still reports health.
- [ ] Change config; agent applies new config_version on next check-in.
- [ ] Trigger uninstall; agent flushes, stops, removes itself; detection fails.
- [ ] Admin actions appear in the audit log; the hash chain is contiguous.

## Observability
- [ ] Dashboard shows version, last check-in, last sync, buffer depth, dropped.
- [ ] Stop the service as admin and confirm the device goes "stale" within 15 min
      (this is the only tamper signal; there is no hidden watchdog).

## Reimage
- [ ] Reimage the laptop and re-enroll. New device_id issued; old events retained
      server-side; no seq collision.

## Security baseline
- [ ] Binaries Authenticode-signed; Defender fully enabled; no ASR/Defender off.
- [ ] BitLocker enforced by Intune compliance (covers offline disk-image theft).
- [ ] Monitoring notice and employment policy legally reviewed before rollout.
