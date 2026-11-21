# Managed agent build plus security gates. Used by .woodpecker/managed-agent.yaml
# on the m1-windows agent (SYSTEM, elevated). M1 is a long-lived host, not a
# throwaway runner, so the service install test always uninstalls in finally.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location (Join-Path $root 'agent\managed')
function Run($exe, [string[]]$a) { & $exe @a; if ($LASTEXITCODE -ne 0) { throw "$exe $a exited $LASTEXITCODE" } }

Run cargo @('test', '--locked')
Run cargo @('clippy', '--locked', '--all-targets', '--', '-D', 'warnings')
Run cargo @('build', '--locked', '--release')

# No-credential-capture gate: the binaries must not import keyboard-hook or
# key-state APIs.
$bad = 'SetWindowsHookEx', 'GetAsyncKeyState', 'GetKeyboardState', 'RegisterRawInputDevices'
$dumpbin = Get-ChildItem 'C:\Program Files*\Microsoft Visual Studio\*\*\VC\Tools\MSVC\*\bin\Hostx64\x64\dumpbin.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $dumpbin) { throw 'dumpbin.exe not found (install VS Build Tools VCTools)' }
foreach ($exe in 'worktrack-svc.exe', 'worktrack-session.exe') {
  $imports = & $dumpbin.FullName /imports "target\release\$exe" 2>$null
  foreach ($api in $bad) { if ($imports -match $api) { throw "$exe imports $api (credential/keylogging API forbidden)" } }
}
Write-Host 'No keylogging imports found.'

# Tamper enforcement: install as SYSTEM, verify a standard user cannot stop or
# delete the service and that the ACLs hold.
$deploy = Join-Path $root 'deploy\managed-agent'
Copy-Item target\release\worktrack-svc.exe, target\release\worktrack-session.exe $deploy
Push-Location $deploy
try {
  # Enrollment fails (no server). Install must still harden locally and exit 1.
  & powershell -ExecutionPolicy Bypass -File install.ps1 -EnrollSecret 'ci-noop' -Server 'http://127.0.0.1:1' -Upn 'ci@example.test'
  if ($LASTEXITCODE -ne 1) { throw "failed enrollment must exit 1, got $LASTEXITCODE" }
  $sddl = (& sc.exe sdshow WorkTrackAgent) -join ''
  if ($sddl -notmatch 'A;;CCLCSWRPWPDTLOCRRC;;;BA') { throw "admins lack full control: $sddl" }
  if ($sddl -match '\(A;;CCLCSWRPWPDTLOCRRC;;;IU\)') { throw 'interactive users must not get stop/config' }
  $acl = (icacls "$env:ProgramData\WorkTrack") -join "`n"
  if ($acl -match 'BUILTIN\\Users') { throw "Users have access to data dir: $acl" }
  & .\detect.ps1; if ($LASTEXITCODE -ne 1) { throw 'unenrolled install must not be detected' }
  Set-Content "$env:ProgramData\WorkTrack\enrollment.json" '{}'
  & .\detect.ps1; if ($LASTEXITCODE -ne 0) { throw 'detection failed after enrollment' }
  Write-Host 'Service hardening verified.'
} finally {
  & powershell -ExecutionPolicy Bypass -File uninstall.ps1
  if (Get-Service WorkTrackAgent -ErrorAction SilentlyContinue) { & sc.exe stop WorkTrackAgent | Out-Null; & sc.exe delete WorkTrackAgent | Out-Null }
  Remove-Item worktrack-svc.exe, worktrack-session.exe -ErrorAction SilentlyContinue
  Pop-Location
}

# Stage the Intune payload (unsigned) for download from the pipeline workspace.
New-Item -ItemType Directory -Force payload | Out-Null
Copy-Item target\release\worktrack-svc.exe, target\release\worktrack-session.exe payload\
Copy-Item (Join-Path $deploy '*.ps1') payload\
Write-Host "Payload staged in agent\managed\payload"
