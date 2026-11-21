# Build the unsigned Windows NSIS installer without updater artifacts.
# Used by .woodpecker/windows.yaml on the m1-windows agent.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..\agent')
# Woodpecker sets CI=woodpecker. The Tauri CLI only accepts true/false.
$env:CI = 'true'
function Run($exe, [string[]]$a) { & $exe @a; if ($LASTEXITCODE -ne 0) { throw "$exe $a exited $LASTEXITCODE" } }

Run corepack @('pnpm', 'install', '--frozen-lockfile')
Run cargo @('check', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--all-targets')
Run cargo @('test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml')
Run corepack @('pnpm', 'run', 'tauri', 'build', '--bundles', 'nsis', '--config', '../deploy/windows-ci.json')
$exe = @(Get-ChildItem 'src-tauri/target/release/bundle/nsis' -Filter '*-setup.exe' -File)
if ($exe.Count -lt 1) { throw 'NSIS installer missing' }
Write-Host "Built $($exe[-1].Name)"
