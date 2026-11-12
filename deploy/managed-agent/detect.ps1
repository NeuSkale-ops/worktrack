# WorkTrack managed agent: Intune Win32 detection rule.
# Exit 0 + stdout => installed; exit 1 / no output => not installed.
# An unenrolled install counts as not installed so Intune runs install.ps1 again.
$svc = Get-Service -Name "WorkTrackAgent" -ErrorAction SilentlyContinue
$exe = Test-Path "$env:ProgramFiles\WorkTrack Agent\worktrack-svc.exe"
$enrolled = Test-Path "$env:ProgramData\WorkTrack\enrollment.json"
if ($svc -and $exe -and $enrolled) {
  Write-Output "WorkTrackAgent present"
  exit 0
}
exit 1
