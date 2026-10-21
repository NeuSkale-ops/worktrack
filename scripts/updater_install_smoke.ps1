param([Parameter(Mandatory = $true)][string]$Bundle)
$ErrorActionPreference = 'Stop'
$installers = @(Get-ChildItem $Bundle -Filter '*-setup.exe' -File)
if ($installers.Count -ne 1) { throw 'Expected exactly one signed installer' }
if (-not (Test-Path "$($installers[0].FullName).sig")) { throw 'Updater signature is missing' }
$installDir = Join-Path $env:RUNNER_TEMP "worktrack-update-smoke-$env:GITHUB_RUN_ID"
if ($installDir.Contains(' ')) { throw 'NSIS smoke path must not contain spaces' }
$installer = Start-Process -FilePath $installers[0].FullName -ArgumentList "/S /D=$installDir" -Wait -PassThru
if ($installer.ExitCode -ne 0) { throw "Installer exited with $($installer.ExitCode)" }
$exe = Join-Path $installDir 'worktrack-agent.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Installed executable missing' }
$app = $null
try {
    $app = Start-Process -FilePath $exe -PassThru
    Start-Sleep -Seconds 5
    $app.Refresh()
    if ($app.HasExited) { throw "Application exited during startup with $($app.ExitCode)" }
    for ($i = 0; $i -lt 5; $i++) {
        $app.Refresh()
        if ($app.HasExited) { throw 'Application exited during responsiveness check' }
        if ($app.MainWindowHandle -eq [IntPtr]::Zero) { throw 'Application main window is missing' }
        if (-not $app.Responding) { throw 'Application main window is not responding' }
        Start-Sleep -Seconds 1
    }
    Write-Host 'PASS: exact signed installer fresh install, process startup and responsive main window'
    Write-Host 'NOT an in-app upgrade test. Windows upgrade/data-preservation evidence is required before production approval.'
} finally {
    if ($null -ne $app -and -not $app.HasExited) { Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue }
}
