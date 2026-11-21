# Install the unsigned NSIS build per-user into a throwaway folder and check the
# process survives startup. Used by .woodpecker/windows.yaml on m1-windows.
# Not verified: tracking-off UI, capture, idle/lock/suspend, or a real worker desktop.
$ErrorActionPreference = 'Stop'
$bundle = Join-Path $PSScriptRoot '..\..\agent\src-tauri\target\release\bundle\nsis'
$installers = @(Get-ChildItem $bundle -Filter '*-setup.exe' -File | Sort-Object LastWriteTime)
if ($installers.Count -lt 1) { throw 'NSIS installer missing' }
$installDir = Join-Path $env:TEMP "worktrack-install-$env:CI_PIPELINE_NUMBER-$PID"
# NSIS requires /D to be last and the path must not contain spaces.
if ($installDir.Contains(' ')) { throw 'NSIS smoke path must not contain spaces' }
$app = $null
try {
  $p = Start-Process -FilePath $installers[-1].FullName -ArgumentList "/S /D=$installDir" -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "NSIS exited with $($p.ExitCode)" }
  $exe = Join-Path $installDir 'worktrack-agent.exe'
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Installed application executable missing' }
  $app = Start-Process -FilePath $exe -PassThru
  Start-Sleep -Seconds 5
  $app.Refresh()
  if ($app.HasExited) { throw "Application exited during startup with $($app.ExitCode)" }
  Write-Host 'PASS: unsigned per-user NSIS install and five-second process survival'
} finally {
  if ($null -ne $app -and -not $app.HasExited) { Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue }
  $un = Join-Path $installDir 'uninstall.exe'
  if (Test-Path $un) { Start-Process $un -ArgumentList '/S' -Wait -ErrorAction SilentlyContinue }
  Remove-Item -Recurse -Force $installDir -ErrorAction SilentlyContinue
}
