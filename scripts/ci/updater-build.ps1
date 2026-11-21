# Windows updater release on the m1-windows agent: validate, test, signed build,
# install smoke, package, independent verify, optional publish. Replaces the
# build/verify/publish jobs of the old updater-release.yml in one workspace.
# Inputs come from manual pipeline variables (see .woodpecker/updater-release.yaml).
$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
function Run($exe, [string[]]$a) { & $exe @a; if ($LASTEXITCODE -ne 0) { throw "$exe $($a -join ' ') exited $LASTEXITCODE" } }

$channel = if ($env:RELEASE_CHANNEL) { $env:RELEASE_CHANNEL } else { 'staging' }
$version = $env:RELEASE_VERSION
$publish = $env:RELEASE_PUBLISH -eq 'true'
if ($channel -notin 'staging', 'production') { throw 'RELEASE_CHANNEL must be staging or production' }
if ([string]::IsNullOrWhiteSpace($version)) { throw 'RELEASE_VERSION is required' }
if ([string]::IsNullOrWhiteSpace($env:RELEASE_NOTES)) { throw 'RELEASE_NOTES is required' }
if ($publish -and $channel -eq 'production' -and [string]::IsNullOrWhiteSpace($env:UPGRADE_EVIDENCE)) {
  throw 'Production publication requires real Windows upgrade evidence. Use RELEASE_PUBLISH=false for a private candidate.'
}

$work = Join-Path $env:TEMP "worktrack-release-$env:CI_PIPELINE_NUMBER"
New-Item -ItemType Directory -Force $work | Out-Null
try {
  Run python @('scripts/updater_release.py', 'config', '--config', 'agent/src-tauri/tauri.conf.json', '--version', $version, '--channel', $channel, '--output', 'deploy/windows-release.generated.json')
  [IO.File]::WriteAllText("$work\release-notes.txt", $env:RELEASE_NOTES)

  Push-Location agent
  Run corepack @('pnpm', 'install', '--frozen-lockfile')
  Pop-Location
  Run python @('-m', 'unittest', 'discover', '-s', 'scripts', '-p', 'test_updater*.py', '-v')
  Run cargo @('test', '--locked', '--manifest-path', 'agent/src-tauri/Cargo.toml')

  if (-not $env:TAURI_SIGNING_PRIVATE_KEY -or -not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) { throw 'Signing secrets are missing' }
  Push-Location agent
  Run corepack @('pnpm', 'run', 'tauri', 'build', '--bundles', 'nsis', '--target', 'x86_64-pc-windows-msvc', '--config', '../deploy/windows-release.generated.json', '--', '--locked')
  Pop-Location
  Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY, Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD

  $bundle = 'agent/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis'
  $env:RUNNER_TEMP = $work
  $env:GITHUB_RUN_ID = $env:CI_PIPELINE_NUMBER
  & ./scripts/updater_install_smoke.ps1 -Bundle $bundle

  $tar = "$work\updater-candidate.tar"
  $pub = "$work\updater-public-key.txt"
  Run python @('scripts/updater_release.py', 'package', '--config', 'agent/src-tauri/tauri.conf.json', '--version', $version, '--channel', $channel, '--bundle', $bundle, '--notes', "$work\release-notes.txt", '--output', $tar, '--public-key', $pub)

  # Independent verification against the committed trust anchor.
  $expected = (Get-Content agent/src-tauri/tauri.conf.json -Raw | ConvertFrom-Json).plugins.updater.pubkey
  if ((Get-Content $pub -Raw).Trim() -ne $expected) { throw 'Candidate key differs from committed trust anchor' }
  Run python @('scripts/updater_release.py', 'verify', '--archive', $tar, '--public-key', $pub, '--channel', $channel)
  Write-Host "Candidate $version ($channel) verified: $tar"

  if (-not $publish) { Write-Host 'RELEASE_PUBLISH is not true. Candidate built and verified, not published.'; return }

  $user = if ($channel -eq 'production') { 'worktrack-updates' } else { 'worktrack-updates-staging' }
  $keyVar = if ($channel -eq 'production') { 'UPDATER_SSH_KEY_PRODUCTION' } else { 'UPDATER_SSH_KEY_STAGING' }
  $key = [Environment]::GetEnvironmentVariable($keyVar)
  if ([string]::IsNullOrWhiteSpace($key)) { throw "$keyVar is missing" }
  $keyFile = "$work\updater-key"; $hosts = "$work\known_hosts"
  [IO.File]::WriteAllText($keyFile, ($key.Trim() + "`n"))
  icacls $keyFile /inheritance:r /grant:r "SYSTEM:F" | Out-Null
  # Pinned receiver host key (same value as the old WORKTRACK_UPDATER_KNOWN_HOSTS variable).
  [IO.File]::WriteAllText($hosts, "[46.225.13.28]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAlsWMP7YauyyUZAmzo/ibPFROpkLciiE2pW+frRZOz1`n")
  # The server forces the receiver command. No shell, scp, sudo or root.
  cmd /c "ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -o UserKnownHostsFile=`"$hosts`" -o ConnectTimeout=15 -i `"$keyFile`" -p 2222 $user@46.225.13.28 < `"$tar`""
  if ($LASTEXITCODE -ne 0) { throw "Publish failed with $LASTEXITCODE" }
  Write-Host "Published $version to $channel"
} finally {
  Remove-Item -Force "$work\updater-key" -ErrorAction SilentlyContinue
}
