# WorkTrack managed agent: Intune Win32 detection rule.
# Exit 0 + stdout => installed; exit 1 / no output => not installed.
$svc = Get-Service -Name "WorkTrackAgent" -ErrorAction SilentlyContinue
$exe = Test-Path "$env:ProgramFiles\WorkTrack Agent\worktrack-svc.exe"
if ($svc -and $exe) {
  Write-Output "WorkTrackAgent present"
  exit 0
}
exit 1
