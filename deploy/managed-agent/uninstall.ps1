# WorkTrack managed agent: Intune/admin uninstall (SYSTEM context).
#
# Authorized only two ways: an Intune uninstall assignment, or the dashboard
# 'uninstall' command which the service self-applies on next check-in by
# invoking this script. A standard user cannot run it (needs SYSTEM/admin to
# stop and delete the hardened service).
param(
  [string]$InstallDir = "$env:ProgramFiles\WorkTrack Agent",
  [string]$DataDir = "$env:ProgramData\WorkTrack"
)
$ErrorActionPreference = "SilentlyContinue"
$ServiceName = "WorkTrackAgent"

# Best-effort final flush so buffered events are not lost on offboarding. The
# service exposes a flush entrypoint; ignore failure (offline is acceptable).
& "$InstallDir\worktrack-svc.exe" --flush-and-exit 2>$null

& sc.exe stop $ServiceName | Out-Null
Start-Sleep -Seconds 3
& sc.exe delete $ServiceName | Out-Null

# Stop any running session helpers.
Get-Process worktrack-session -ErrorAction SilentlyContinue | Stop-Process -Force

Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $DataDir -ErrorAction SilentlyContinue

Write-Output "WorkTrack agent removed."
exit 0
