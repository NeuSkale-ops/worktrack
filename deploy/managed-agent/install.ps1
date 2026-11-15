# WorkTrack managed agent: Intune install script (per-machine, SYSTEM context).
#
# Deployed as a Win32 app. Intune runs this as SYSTEM, so it can install the
# service, harden ACLs and enroll the device. Nothing here hides the agent: the
# service and program stay visible in the Services console and Programs and
# Features. Tamper resistance is least privilege only.
#
# Install command (Intune): powershell.exe -ExecutionPolicy Bypass -File install.ps1 -EnrollSecret "<secret>" -Server "https://worktrack.neuskale.com"
#
# Exit codes: 0 installed and enrolled, 1 installed but not enrolled. Intune
# reports 1 as a failed install and retries it; detect.ps1 agrees because it
# requires the enrollment file.
param(
  [Parameter(Mandatory = $true)][string]$EnrollSecret,
  [string]$Server = "https://worktrack.neuskale.com",
  # Work account that owns this laptop. Default: the Intune enrollment UPN.
  [string]$Upn = "",
  [string]$InstallDir = "$env:ProgramFiles\WorkTrack Agent",
  [string]$DataDir = "$env:ProgramData\WorkTrack"
)
$ErrorActionPreference = "Stop"
$ServiceName = "WorkTrackAgent"

# 0. Reinstall or upgrade: stop the running service and its session helpers
#    first, or Windows keeps the old executables locked and the copy fails.
if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
  & sc.exe stop $ServiceName | Out-Null
  Start-Sleep -Seconds 3
  & sc.exe delete $ServiceName | Out-Null
  Start-Sleep -Seconds 2
}
Get-Process worktrack-session -ErrorAction SilentlyContinue | Stop-Process -Force

# 1. Lay down binaries (packaged alongside this script by the Win32 wrapper).
#    uninstall.ps1 is kept next to them so the dashboard uninstall command can
#    run it.
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Force "$PSScriptRoot\worktrack-svc.exe" $InstallDir
Copy-Item -Force "$PSScriptRoot\worktrack-session.exe" $InstallDir
Copy-Item -Force "$PSScriptRoot\uninstall.ps1" $InstallDir

# 2. Durable data dir. ACL: SYSTEM + Administrators full control, Users NO access.
#    This is what stops a standard user reading or deleting the buffer. The
#    buffer payloads are additionally sealed with machine DPAPI.
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)  # drop inherited ACEs
foreach ($who in @("NT AUTHORITY\SYSTEM", "BUILTIN\Administrators")) {
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
      $who, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")))
}
$acl.SetOwner((New-Object System.Security.Principal.NTAccount("BUILTIN\Administrators")))
Set-Acl -Path $DataDir -AclObject $acl

# 3. Write server config the service reads at boot.
@{ server = $Server } | ConvertTo-Json | Set-Content -Path "$DataDir\config.json" -Encoding UTF8

# 4. Register the service: LocalSystem, auto-start (begins before user login).
& sc.exe create $ServiceName binPath= "`"$InstallDir\worktrack-svc.exe`"" start= auto obj= LocalSystem DisplayName= "WorkTrack Monitoring Agent" | Out-Null
& sc.exe description $ServiceName "Disclosed activity monitoring for company-owned devices. Managed by IT." | Out-Null

# 5. Service recovery: auto-restart after a crash (5s, 30s, 60s; reset daily).
& sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/30000/restart/60000 | Out-Null

# 6. Harden the service object: deny stop/config/delete to non-admins while
#    LEAVING read/query so the service stays visible (SDDL). A standard user can
#    see it but cannot stop, reconfigure or delete it.
#    D: SY/BA get full control; IU (interactive users) get read/query only.
$sddl = "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCLCSWRPWPDTLOCRRC;;;BA)(A;;CCLCSWLORC;;;IU)(A;;CCLCSWLORC;;;SU)"
& sc.exe sdset $ServiceName $sddl | Out-Null

# 7. Harden the install dir: Users read/execute, no write.
icacls "$InstallDir" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-32-545:(OI)(CI)RX" | Out-Null

# 8. Start the service and enroll this device. The secret is shared by every
#    laptop in the Intune assignment; the server returns a per-device token.
& sc.exe start $ServiceName | Out-Null
$enrollment = "$DataDir\enrollment.json"
if (Test-Path $enrollment) {
  # Reinstall or Intune retry: keep the existing device identity.
  Write-Output "WorkTrack agent installed (already enrolled)."
  exit 0
}
# This script runs as SYSTEM, which has no UPN of its own, so `whoami /upn`
# is only a last resort for a manual run by an admin.
if (-not $Upn) {
  $Upn = Get-ChildItem "HKLM:\SOFTWARE\Microsoft\Enrollments" -ErrorAction SilentlyContinue |
    ForEach-Object { (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).UPN } |
    Where-Object { $_ } | Select-Object -First 1
}
if (-not $Upn) {
  try { $Upn = (& whoami.exe /upn) 2>$null } catch { $Upn = "" }
}
try {
  if (-not $Upn) { throw "no user UPN found; pass -Upn" }
  $body = @{ secret = $EnrollSecret; upn = "$Upn".Trim(); hostname = $env:COMPUTERNAME } | ConvertTo-Json
  $resp = Invoke-RestMethod -Method Post -Uri "$Server/api/devices/enroll" -ContentType "application/json" -Body $body
  # The device token is stored in the data dir, which only SYSTEM and
  # Administrators can read.
  $resp | ConvertTo-Json | Set-Content -Path $enrollment -Encoding UTF8
  (Get-Acl $DataDir) | Set-Acl -Path $enrollment
} catch {
  # Nothing retries enrollment later: the secret is not kept on disk. Fail the
  # install so Intune shows it and runs this script again.
  Write-Error "WorkTrack agent installed but NOT enrolled: $_" -ErrorAction Continue
  exit 1
}

Write-Output "WorkTrack agent installed."
exit 0
