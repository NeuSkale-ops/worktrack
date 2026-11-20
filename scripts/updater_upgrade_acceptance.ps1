<#
.SYNOPSIS
Exercises the real installed Windows updater through WebView UI Automation.
.DESCRIPTION
Run only on an elevated, disposable GitHub-hosted Windows runner with an unlocked
interactive desktop, Python 3, OpenSSL, WebView2, and the coordinator's HTTPS feed
helper. Candidate signatures and the pinned baseline SHA are verified upstream.
No app builds, IPC calls, production credentials, or production traffic are used.
Evidence survives at $env:RUNNER_TEMP/worktrack-upgrade-evidence; private fixture
state, certificate keys, hosts changes, and the installation are removed finally.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Candidate,
    [Parameter(Mandatory = $true)][string]$Baseline,
    [Parameter(Mandatory = $true)][string]$ExpectedVersion
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Windows PowerShell supplies the desktop UIAutomation assemblies and STA thread.
if ($PSVersionTable.PSEdition -ne 'Desktop') {
    & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File $PSCommandPath -Candidate $Candidate -Baseline $Baseline -ExpectedVersion $ExpectedVersion
    if ($LASTEXITCODE -ne 0) { throw "Windows acceptance exited with $LASTEXITCODE" }
    return
}
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or -not $env:RUNNER_TEMP) {
    throw 'This script changes hosts, current-user credentials, and installation state. Use a disposable GitHub-hosted Windows runner only.'
}
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Self-hosted runners are not safe for this acceptance fixture.' }
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'An elevated runner is required to map hosts.' }
if (-not [Environment]::UserInteractive) { throw 'UI Automation needs an interactive, unlocked Windows desktop.' }
if ([Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') { throw 'Run Windows PowerShell with -STA.' }
if ($ExpectedVersion -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' -or [version]$ExpectedVersion -le [version]'0.1.5') {
    throw 'ExpectedVersion must be a stable version newer than baseline 0.1.5.'
}
$Candidate = (Resolve-Path -LiteralPath $Candidate).Path
$Baseline = (Resolve-Path -LiteralPath $Baseline).Path
$helper = Join-Path $PSScriptRoot 'updater_acceptance_feed.py'
if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { throw 'Coordinator HTTPS feed helper is missing.' }
$python = (Get-Command python -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$opensslCommand = Get-Command openssl -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -ne $opensslCommand) { $openssl = $opensslCommand.Source }
else {
    $openssl = Join-Path $env:ProgramFiles 'Git\usr\bin\openssl.exe'
    if (-not (Test-Path -LiteralPath $openssl -PathType Leaf)) { throw 'OpenSSL is not on PATH or in the hosted runner Git installation.' }
}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

# keyring 3.6.3 windows-native: Entry::new(service, user) maps to user.service,
# and set_password stores UTF-16LE with CRED_PERSIST_ENTERPRISE (not cmdkey ANSI).
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class AcceptanceCredential {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential {
        public uint Flags, Type;
        public string TargetName, Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist, AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias, UserName;
    }
    [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool ReadNative(string target, uint type, uint flags, out IntPtr credential);
    [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool WriteNative(ref Credential credential, uint flags);
    [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool DeleteNative(string target, uint type, uint flags);
    [DllImport("advapi32.dll")] private static extern void CredFree(IntPtr credential);
    public static string Read(string target) {
        IntPtr pointer;
        if (!ReadNative(target, 1, 0, out pointer)) {
            int error = Marshal.GetLastWin32Error();
            if (error == 1168) return null;
            throw new Win32Exception(error);
        }
        try {
            var value = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
            return Marshal.PtrToStringUni(value.CredentialBlob, checked((int)value.CredentialBlobSize / 2));
        } finally { CredFree(pointer); }
    }
    public static void Write(string target, string user, string password) {
        IntPtr blob = Marshal.StringToCoTaskMemUni(password);
        try {
            var value = new Credential {
                Type = 1, TargetName = target, UserName = user,
                Comment = "Disposable WorkTrack acceptance fixture",
                CredentialBlob = blob, CredentialBlobSize = checked((uint)password.Length * 2), Persist = 3
            };
            if (!WriteNative(ref value, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        } finally { Marshal.ZeroFreeCoTaskMemUnicode(blob); }
    }
    public static void Delete(string target) {
        if (!DeleteNative(target, 1, 0)) {
            int error = Marshal.GetLastWin32Error();
            if (error != 1168) throw new Win32Exception(error);
        }
    }
}
'@

# Baseline 0.1.5 uses the old hostname. The candidate migrates its sign-in and
# queue to the new hostname on first launch, so both are isolated to loopback.
$oldDomain = 'worktrack.178.156.213.40.sslip.io'
$oldServer = "https://$oldDomain"
$oldCredentialTarget = "$oldServer.com.worktrack.agent"
$domain = 'worktrack.neuskale.com'
$server = "https://$domain"
$credentialTarget = "$server.com.worktrack.agent"
$dataDir = Join-Path $env:LOCALAPPDATA 'com.worktrack.agent'
$evidenceDir = Join-Path $env:RUNNER_TEMP 'worktrack-upgrade-evidence'
$root = Join-Path $env:RUNNER_TEMP ("worktrack-upgrade-" + [guid]::NewGuid().ToString('N'))
$installDir = Join-Path $root 'installed'
$exe = Join-Path $installDir 'worktrack-agent.exe'
$hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$feed = $null
$cert = $null
$hostsOriginal = $null
$hostsChanged = $false
$identityCreated = $false
$credentialCreated = $false
$installStarted = $false
$oldWebViewArgs = [Environment]::GetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', 'Process')
$oldTlsProtocol = [Net.ServicePointManager]::SecurityProtocol
$oldWebProxy = [Net.WebRequest]::DefaultWebProxy
$oldTemp = $env:TEMP
$oldTmp = $env:TMP
# Windows environment names are case-insensitive, including NO_PROXY/no_proxy.
$proxyNames = @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY')
$oldProxy = @{}
$evidence = [ordered]@{
    status = 'running'; baselineVersion = '0.1.5'; expectedVersion = $ExpectedVersion
    baselineInstallerSha256 = (Get-FileHash -LiteralPath $Baseline -Algorithm SHA256).Hash.ToLowerInvariant()
    candidateArchiveSha256 = (Get-FileHash -LiteralPath $Candidate -Algorithm SHA256).Hash.ToLowerInvariant()
    interaction = 'Windows UIAutomation InvokePattern on real WebView buttons'
    scenarios = @(); cleanupErrors = @()
    limits = @(
        'Pinned baseline SHA and candidate updater signatures are verified by the coordinator before this script.',
        'Seeded non-production identity proves local sign-in continuity, not a real server login.',
        'No real geolocation, active tracking, screenshots, or native location acceptance is claimed.',
        'Exact production hostname is mapped to loopback before application launch. The helper returns API 503 only if the API client reaches HTTP.',
        'The main API client uses bundled web PKI roots and may reject the disposable certificate before HTTP. API requests need not appear in local logs; the retained offline queue is the acceptance evidence. No TLS bypass is used.',
        'The disposable public TLS certificate is trusted in LocalMachine\Root on the elevated GitHub-hosted runner only, avoiding CurrentUser Root consent UI. Its private key remains in CurrentUser\My. Exact certificate thumbprints are removed during cleanup.',
        'Future-stalled advertises one higher patch only to exercise the new binary download timeout; it is never installed.'
    )
}

function Save-Evidence {
    [IO.File]::WriteAllText((Join-Path $evidenceDir 'upgrade-evidence.json'), ($evidence | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
}
function Get-AppProcesses {
    @(Get-Process -Name 'worktrack-agent' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe })
}
function Get-AppWindow {
    foreach ($process in @(Get-AppProcesses)) {
        try {
            $process.Refresh()
            if ($process.MainWindowHandle -ne [IntPtr]::Zero) {
                return [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
            }
        } catch [System.InvalidOperationException] { continue }
    }
    return $null
}
function Get-UiElements {
    $window = Get-AppWindow
    if ($null -eq $window) { return @() }
    try {
        @($window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition))
    } catch [System.Windows.Automation.ElementNotAvailableException] { return @() }
}
function Get-UiText {
    $names = foreach ($element in @(Get-UiElements)) {
        try {
            if (-not $element.Current.IsOffscreen) {
                if ($element.Current.Name) { $element.Current.Name }
                # Visible TextPattern ranges join adjacent React text nodes without
                # accepting text that is merely present offscreen in the DOM.
                if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document) {
                    $pattern = $null
                    if ($element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
                        foreach ($range in $pattern.GetVisibleRanges()) { $range.GetText(-1) }
                    }
                }
            }
        } catch [System.Windows.Automation.ElementNotAvailableException] { continue }
    }
    return (($names -join "`n").Replace("`r", ''))
}
function Scroll-Ui([double]$Percent) {
    foreach ($element in @(Get-UiElements)) {
        try {
            $pattern = $null
            if ($element.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$pattern) -and $pattern.Current.VerticallyScrollable) {
                $pattern.SetScrollPercent([System.Windows.Automation.ScrollPattern]::NoScroll, $Percent)
                return
            }
        } catch [System.Windows.Automation.ElementNotAvailableException] { continue }
    }
}
function Wait-UiText([string]$Pattern, [int]$Seconds = 90) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    $percent = 0
    do {
        $text = Get-UiText
        if ($text -match $Pattern) { return $text }
        Scroll-Ui $percent
        $percent = ($percent + 20) % 120
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Timed out waiting for visible UI text /$Pattern/. Last visible UI: $text"
}
function Get-Button([string]$Name) {
    foreach ($element in @(Get-UiElements)) {
        try {
            if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $element.Current.Name -eq $Name) { return $element }
        } catch [System.Windows.Automation.ElementNotAvailableException] { continue }
    }
    return $null
}
function Wait-Button([string]$Name, [bool]$Enabled = $true, [int]$Seconds = 90) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        $button = Get-Button $Name
        try {
            if ($null -ne $button -and $button.Current.IsEnabled -eq $Enabled) { return $button }
        } catch [System.Windows.Automation.ElementNotAvailableException] { $button = $null }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Button '$Name' did not reach enabled=$Enabled. UI: $(Get-UiText)"
}
function Invoke-Button([string]$Name) {
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $button = Wait-Button $Name
        try {
            if ($button.Current.IsOffscreen) {
                $scrollItem = $null
                if ($button.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$scrollItem)) { $scrollItem.ScrollIntoView() }
                else {
                    foreach ($percent in @(0, 20, 40, 60, 80, 100)) {
                        Scroll-Ui $percent
                        Start-Sleep -Milliseconds 100
                        $button = Get-Button $Name
                        if ($null -ne $button -and -not $button.Current.IsOffscreen) { break }
                    }
                }
                $button = Get-Button $Name
            }
            if ($null -eq $button -or $button.Current.IsOffscreen) { throw "Button '$Name' is not visible." }
            $pattern = $null
            if (-not $button.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
                throw "Real WebView button '$Name' does not expose InvokePattern. No IPC or JavaScript fallback is allowed."
            }
            $pattern.Invoke()
            return
        } catch [System.Windows.Automation.ElementNotAvailableException] {
            # React and a genuine installer restart may invalidate a UIA node.
            Start-Sleep -Milliseconds 100
        }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Button '$Name' kept disappearing from the real WebView UI."
}
function Add-Result([string]$Name, [hashtable]$Details) {
    $evidence.scenarios += [ordered]@{ name = $Name; result = 'passed'; utc = [DateTime]::UtcNow.ToString('o'); details = $Details }
    Save-Evidence
    Write-Host "PASS: $Name"
}
function Set-FeedMode([string]$Mode) {
    $feed.Refresh()
    if ($feed.HasExited) { throw "HTTPS feed exited: $(Get-Content (Join-Path $root 'feed.stderr') -Raw)" }
    [IO.File]::WriteAllText((Join-Path $root 'mode'), $Mode, [Text.UTF8Encoding]::new($false))
}
function Get-FeedRecords {
    $path = Join-Path $root 'access.jsonl'
    if (Test-Path -LiteralPath $path) {
        foreach ($line in @(Get-Content -LiteralPath $path)) {
            if ($line) { $line | ConvertFrom-Json }
        }
    }
}
function Wait-FeedRequest([string]$Path, [string]$Mode, [int]$Before, [int]$Status = 200) {
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $requests = @(Get-FeedRecords | Where-Object { $_.path -eq $Path -and (-not $Mode -or $_.mode -eq $Mode) })
        if ($requests.Count -gt $Before) {
            if ($requests[-1].status -ne $Status) { throw "Unexpected local HTTP status for $Mode $Path" }
            return
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "No real local HTTPS request observed for $Mode $Path"
}
function Invoke-Check {
    $path = '/updates/windows/x86_64/latest.json'
    $mode = [IO.File]::ReadAllText((Join-Path $root 'mode')).Trim()
    $before = @(Get-FeedRecords | Where-Object { $_.path -eq $path -and $_.mode -eq $mode }).Count
    Invoke-Button -Name 'Check for updates'
    $status = 200
    if ($mode -eq 'missing') { $status = 404 }
    Wait-FeedRequest $path $mode $before $status
    $null = Wait-Button 'Check for updates'
}
function Invoke-Update {
    $path = "/updates/windows/x86_64/releases/$ExpectedVersion/worktrack-setup.exe"
    $mode = [IO.File]::ReadAllText((Join-Path $root 'mode')).Trim()
    $before = @(Get-FeedRecords | Where-Object { $_.path -eq $path -and $_.mode -eq $mode }).Count
    Invoke-Button -Name 'Update now'
    Wait-FeedRequest $path $mode $before
}
function Assert-SignedInStopped([string]$Version) {
    # Baseline is the actual published 0.1.5 build at 12dbe5b, before the UI redesign.
    if ($Version -eq '0.1.5') {
        $null = Wait-UiText 'Installed version 0\.1\.5\.'
        $null = Wait-UiText '(?m)^TRACKING OFF$'
    } else {
        $null = Wait-UiText ('(?m)^Version ' + [regex]::Escape($Version) + '$')
        $null = Wait-UiText '(?m)^Not tracking$'
    }
    $null = Wait-Button 'Renew sign-in'
    $null = Wait-Button 'Check for updates'
    if ($null -ne (Get-Button 'Sign in') -or $null -ne (Get-Button 'Stop tracking')) { throw 'Expected persisted sign-in with tracking stopped.' }
    if ($Version -eq '0.1.5') { $target = $oldCredentialTarget; $stale = $credentialTarget }
    else { $target = $credentialTarget; $stale = $oldCredentialTarget }
    if ([AcceptanceCredential]::Read($target) -cne $script:fixtureToken) { throw 'OS credential changed or disappeared.' }
    if ($null -ne [AcceptanceCredential]::Read($stale)) { throw 'Credential for the other hostname must not exist.' }
}
function Start-App([string]$Version) {
    $null = Start-Process -FilePath $exe -PassThru
    Assert-SignedInStopped $Version
}
function Stop-App([switch]$AllFixtureProcesses) {
    $processes = @(Get-AppProcesses)
    if ($AllFixtureProcesses) { $processes = @(Get-Process -Name 'worktrack-agent' -ErrorAction SilentlyContinue) }
    foreach ($process in $processes) {
        # This fixture never starts tracking. Close the real window before forcing exit.
        $null = $process.CloseMainWindow()
        if (-not $process.WaitForExit(10000)) {
            & taskkill.exe /PID $process.Id /T /F | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Could not stop fixture app process tree.' }
            $process.WaitForExit()
        }
    }
    if ($AllFixtureProcesses) { $remaining = @(Get-Process -Name 'worktrack-agent' -ErrorAction SilentlyContinue) }
    else { $remaining = @(Get-AppProcesses) }
    if ($remaining.Count -ne 0) { throw 'App must be fully stopped before touching SQLite.' }
}
function Invoke-Fixture([string]$Action) {
    if (@(Get-AppProcesses).Count -ne 0) { throw 'Fixture SQLite reads or writes require a stopped app.' }
    & $python (Join-Path $root 'fixture.py') $Action (Join-Path $dataDir 'queue.sqlite3') $(if ($Action -eq 'check-final') { $server } else { $oldServer })
    if ($LASTEXITCODE -ne 0) { throw "SQLite fixture $Action failed." }
}
function Assert-OldBinary {
    if ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ne $script:oldExeHash) { throw 'Failed update changed baseline executable.' }
    Assert-SignedInStopped '0.1.5'
}

# Refuse existing user state rather than backing up or overwriting any real identity.
if (Test-Path -LiteralPath $dataDir) { throw "Existing application state must not be touched: $dataDir" }
if ($null -ne [AcceptanceCredential]::Read($credentialTarget) -or $null -ne [AcceptanceCredential]::Read($oldCredentialTarget)) { throw 'Existing WorkTrack OS credential must not be overwritten.' }
if (@(Get-Process -Name 'worktrack-agent' -ErrorAction SilentlyContinue).Count -ne 0) { throw 'A WorkTrack process already exists.' }
if (Test-Path -LiteralPath $evidenceDir) { throw "Evidence directory already exists: $evidenceDir" }
$null = New-Item -ItemType Directory -Path $root, $evidenceDir
Save-Evidence
try {
    # Native updater/NSIS temporary executables stay inside our disposable root.
    $runtimeTemp = Join-Path $root 'runtime-temp'
    $null = New-Item -ItemType Directory -Path $runtimeTemp
    $env:TEMP = $runtimeTemp
    $env:TMP = $runtimeTemp
    foreach ($name in $proxyNames) {
        $oldProxy[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
    $env:NO_PROXY = "$domain,$oldDomain,127.0.0.1,localhost"
    $env:no_proxy = $env:NO_PROXY
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--force-renderer-accessibility'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    [Net.WebRequest]::DefaultWebProxy = $null
    $cert = New-SelfSignedCertificate -DnsName $domain, $oldDomain -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -NotAfter (Get-Date).AddDays(1)
    $cer = Join-Path $root 'feed.cer'
    $pfx = Join-Path $root 'feed.pfx'
    $pem = Join-Path $root 'feed.pem'
    $pfxPassword = [guid]::NewGuid().ToString('N')
    $null = Export-Certificate -Cert $cert -FilePath $cer
    # CurrentUser Root import requires consent UI and fails under -NonInteractive.
    # This guarded disposable elevated runner may silently trust the public cert
    # machine-wide. The private key stays in CurrentUser My and is never imported.
    & "$env:SystemRoot\System32\certutil.exe" -addstore -f Root $cer | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not trust the disposable public certificate in LocalMachine Root.' }
    if (-not (Test-Path "Cert:\LocalMachine\Root\$($cert.Thumbprint)")) { throw 'Disposable root certificate is missing after import.' }
    $evidence.tlsRootStore = 'LocalMachine\Root'
    $evidence.tlsPrivateKeyStore = 'CurrentUser\My'
    $evidence.tlsCertificateThumbprint = $cert.Thumbprint
    $null = Export-PfxCertificate -Cert $cert -FilePath $pfx -Password (ConvertTo-SecureString $pfxPassword -AsPlainText -Force)
    # Export both private key and certificate to one PEM for Python SSLContext.
    $env:WORKTRACK_ACCEPTANCE_PFX_PASSWORD = $pfxPassword
    try {
        & $openssl pkcs12 -in $pfx -out $pem -nodes -passin env:WORKTRACK_ACCEPTANCE_PFX_PASSWORD
        if ($LASTEXITCODE -ne 0) { throw 'OpenSSL PEM export failed.' }
    } finally { Remove-Item Env:\WORKTRACK_ACCEPTANCE_PFX_PASSWORD -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $pfx
    $hostsOriginal = [IO.File]::ReadAllBytes($hostsPath)
    $hostsText = [IO.File]::ReadAllText($hostsPath)
    foreach ($name in @($domain, $oldDomain)) {
        if ($hostsText -match ('(?im)^[^#\r\n]*\s' + [regex]::Escape($name) + '(?:\s|$)')) { throw 'Production hostname already has a hosts mapping.' }
    }
    $hostsChanged = $true
    [IO.File]::AppendAllText($hostsPath, "`r`n127.0.0.1 $domain # worktrack-disposable-updater-acceptance`r`n127.0.0.1 $oldDomain # worktrack-disposable-updater-acceptance`r`n", [Text.Encoding]::ASCII)
    Clear-DnsClientCache
    $resolved = @(@($domain, $oldDomain) | ForEach-Object { [Net.Dns]::GetHostAddresses($_) } | ForEach-Object { $_.IPAddressToString })
    if ($resolved.Count -eq 0 -or @($resolved | Where-Object { $_ -ne '127.0.0.1' }).Count -ne 0) { throw "Unsafe hostname resolution: $resolved" }
    $feedArgs = '"{0}" --archive "{1}" --root "{2}" --cert "{3}" --port 443' -f $helper, $Candidate, $root, $pem
    $feed = Start-Process -FilePath $python -ArgumentList $feedArgs -RedirectStandardOutput (Join-Path $root 'feed.stdout') -RedirectStandardError (Join-Path $root 'feed.stderr') -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while (-not (Test-Path -LiteralPath (Join-Path $root 'ready.json'))) {
        $feed.Refresh()
        if ($feed.HasExited -or [DateTime]::UtcNow -ge $deadline) { throw "Feed failed to start: $(Get-Content (Join-Path $root 'feed.stderr') -Raw)" }
        Start-Sleep -Milliseconds 250
    }
    $ready = Get-Content -LiteralPath (Join-Path $root 'ready.json') -Raw | ConvertFrom-Json
    if ($ready.version -ne $ExpectedVersion -or $ready.port -ne 443) { throw 'Feed ready metadata does not match the candidate.' }
    Set-FeedMode 'valid'
    # The real HTTPS request validates Windows certificate trust and hostname, not a TLS bypass.
    $manifest = Invoke-RestMethod -Uri "$server/updates/windows/x86_64/latest.json" -TimeoutSec 20
    if ($manifest.version -ne $ExpectedVersion) { throw 'Candidate manifest version mismatch.' }
    $platform = $manifest.platforms.'windows-x86_64'
    if ($platform.url -cne "$server/updates/windows/x86_64/releases/$ExpectedVersion/worktrack-setup.exe") { throw 'Candidate immutable installer URL is unexpected.' }
    Add-Result 'isolated-https-feed' @{ hostname = $domain; addresses = $resolved; port = 443; tlsValidation = 'Windows trusted root, no bypass' }

    # SQLite here is fixture setup and observation only, never updater implementation.
    $fixture = @'
import json, sqlite3, sys
from pathlib import Path

action, filename, server = sys.argv[1:]
settings = {
    "server": server,
    "email": "updater-acceptance@example.invalid",
    "active_session": "",
    "checkpoint": "2026-01-01T00:00:00Z",
    "updater_acceptance_sentinel": "existing-settings-must-survive",
}
queued = (870015, "/api/sessions/stop", '{"id":"00000000-0000-4000-8000-000000000015","stopped_at":"2026-01-01T00:00:00Z"}', None)
rejected = (870016, "/api/blocks", '{"fixture":"rejected-local-evidence"}', b"UPDATER-REJECTED-FIXTURE", 422, "2026-01-01 00:00:00")
assert action in {"seed", "check-queued", "remove-queue", "check-final"}
if action == "seed":
    assert not Path(filename).exists(), "Refusing an existing SQLite identity"
else:
    assert Path(filename).is_file(), "Application SQLite identity disappeared"
with sqlite3.connect(filename) as db:
    if action == "seed":
        db.executescript("""
        PRAGMA journal_mode=DELETE;
        PRAGMA synchronous=FULL;
        CREATE TABLE queue(id INTEGER PRIMARY KEY, path TEXT NOT NULL, json TEXT NOT NULL, image BLOB);
        CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE rejected(id INTEGER PRIMARY KEY, path TEXT NOT NULL, json TEXT NOT NULL, image BLOB, status INTEGER NOT NULL, rejected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        """)
        db.executemany("INSERT INTO settings VALUES (?,?)", settings.items())
        db.execute("INSERT INTO queue VALUES (?,?,?,?)", queued)
        db.execute("INSERT INTO rejected VALUES (?,?,?,?,?,?)", rejected)
    assert db.execute("PRAGMA integrity_check").fetchone() == ("ok",)
    actual = dict(db.execute("SELECT key,value FROM settings"))
    assert all(actual.get(key) == value for key, value in settings.items()), "Identity, tracking state, or settings changed"
    assert db.execute("SELECT * FROM rejected ORDER BY id").fetchall() == [rejected], "Rejected evidence changed"
    if action in {"seed", "check-queued", "remove-queue"}:
        assert db.execute("SELECT * FROM queue ORDER BY id").fetchall() == [queued], "Offline queue fixture changed"
    if action == "remove-queue":
        # Remove only our exact row, while all app processes are stopped.
        assert db.execute("DELETE FROM queue WHERE id=? AND path=? AND json=? AND image IS NULL", queued[:3]).rowcount == 1
    if action in {"remove-queue", "check-final"}:
        assert db.execute("SELECT count(*) FROM queue").fetchone() == (0,), "Unexpected queued tracking records"
print(json.dumps({"action": action, "integrity": "ok", "settings_preserved": True, "rejected_preserved": True}))
'@
    [IO.File]::WriteAllText((Join-Path $root 'fixture.py'), $fixture, [Text.UTF8Encoding]::new($false))
    $identityCreated = $true
    $null = New-Item -ItemType Directory -Path $dataDir
    Invoke-Fixture 'seed'
    $script:fixtureToken = 'not-a-production-token-updater-acceptance-' + [guid]::NewGuid().ToString('N')
    $credentialCreated = $true
    [AcceptanceCredential]::Write($oldCredentialTarget, $oldServer, $script:fixtureToken)

    if ($installDir.Contains(' ')) { throw 'NSIS /D path must not contain spaces.' }
    $installStarted = $true
    $installer = Start-Process -FilePath $Baseline -ArgumentList "/S /D=$installDir" -Wait -PassThru
    if ($installer.ExitCode -ne 0) { throw "Baseline installer failed: $($installer.ExitCode)" }
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Baseline installed executable is missing.' }
    $installedVersion = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion
    if ($installedVersion -notmatch '^0\.1\.5(?:\.|\+|$)') { throw "Wrong installed baseline ProductVersion: $installedVersion" }
    $script:oldExeHash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
    $evidence.baselineExeSha256 = $script:oldExeHash.ToLowerInvariant()
    Start-App '0.1.5'
    Invoke-Check
    $null = Wait-UiText ('Version\s+' + [regex]::Escape($ExpectedVersion) + '\s+is available\.')
    $null = Wait-UiText '1 records waiting to sync'
    $null = Wait-Button 'Update now' $false
    Assert-OldBinary
    Stop-App
    Invoke-Fixture 'check-queued'
    # Main API rustls uses bundled roots, unlike the updater's platform verifier.
    # A certificate rejection before HTTP is a valid offline state, not a missing
    # API fixture request. The real disabled button and exact retained row above
    # prove the queue guard without bypassing application TLS validation.
    $apiRequests = @(Get-FeedRecords | Where-Object { $_.path -eq '/api/sessions/stop' })
    if (@($apiRequests | Where-Object { $_.status -ne 503 }).Count -ne 0) { throw 'The isolated API helper must never accept fixture records.' }
    Add-Result 'queued-update-disabled' @{ actualButtonEnabled = $false; baselineVersion = '0.1.5'; queuePreserved = $true; identityPreserved = $true; localApiHttpObserved = ($apiRequests.Count -gt 0); apiState = 'Offline: loopback only; bundled API trust may reject disposable TLS before HTTP; helper returns 503 if reached' }
    Invoke-Fixture 'remove-queue'
    Start-App '0.1.5'
    $null = Wait-UiText '0 records waiting to sync'
    Add-Result 'baseline-restart-sign-in' @{ persisted = $true; stopped = $true; queueRemovedOnlyWhileStopped = $true }

    foreach ($mode in @('missing', 'invalid')) {
        Set-FeedMode $mode
        Invoke-Check
        $text = Wait-UiText 'Could not check for updates:'
        $null = Wait-Button 'Check for updates'
        $null = Wait-Button 'Renew sign-in'
        Assert-OldBinary
        Add-Result "feed-$mode" @{ visibleError = $text; oldExeUnchanged = $true; controlsUsable = $true }
    }
    foreach ($mode in @('tampered', 'wrong-key', 'interrupted')) {
        Set-FeedMode $mode
        Invoke-Check
        $null = Wait-UiText ('Version\s+' + [regex]::Escape($ExpectedVersion) + '\s+is available\.')
        Invoke-Update
        $text = Wait-UiText 'Update could not be installed:' 120
        if ($mode -in @('tampered', 'wrong-key') -and $text -notmatch '(?i)signature|verification|key') { throw "Expected a cryptographic rejection for $mode, not an unrelated failure: $text" }
        $null = Wait-Button 'Update now'
        $null = Wait-Button 'Check for updates'
        $null = Wait-Button 'Renew sign-in'
        $null = Wait-Button 'Sign out'
        Assert-OldBinary
        Add-Result "install-$mode" @{ visibleError = $text; oldExeUnchanged = $true; controlsUsable = $true; signedIn = $true; stopped = $true }
    }
    Set-FeedMode 'valid'
    Invoke-Check
    $null = Wait-UiText ('Version\s+' + [regex]::Escape($ExpectedVersion) + '\s+is available\.')
    Invoke-Update
    $deadline = [DateTime]::UtcNow.AddMinutes(5)
    $lastSampleHash = $null
    $lastReadError = ''
    do {
        Start-Sleep -Milliseconds 500
        try {
            # NSIS locks and replaces this path. A changed or partially written
            # file is not acceptance evidence until its version and hash settle.
            $sampleVersion = (Get-Item -LiteralPath $exe -ErrorAction Stop).VersionInfo.ProductVersion
            $sampleHash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256 -ErrorAction Stop).Hash
            if ($sampleVersion -match ('^' + [regex]::Escape($ExpectedVersion) + '(?:\.|\+|$)') -and $sampleHash -ne $script:oldExeHash) {
                if ($sampleHash -eq $lastSampleHash) {
                    $newExeHash = $sampleHash
                    $newProductVersion = $sampleVersion
                    break
                }
                $lastSampleHash = $sampleHash
            } else { $lastSampleHash = $null }
        } catch {
            # Retry bounded transient sharing/read errors, never treat them as an
            # unchanged or successfully installed executable.
            $lastSampleHash = $null
            $lastReadError = $_.Exception.Message
        }
        if ([DateTime]::UtcNow -ge $deadline) { throw "Real plugin did not produce a stable $ExpectedVersion executable. Last read error: $lastReadError. UI: $(Get-UiText)" }
    } while ($true)
    # NSIS may restart automatically. Starting the same installed path also handles
    # the app's documented manual-restart outcome, without running the installer.
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while (@(Get-AppProcesses).Count -eq 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 500 }
    if (@(Get-AppProcesses).Count -eq 0) { Start-App $ExpectedVersion }
    Assert-SignedInStopped $ExpectedVersion
    Stop-App
    Invoke-Fixture 'check-final'
    $evidence.installedExeSha256 = $newExeHash.ToLowerInvariant()
    Add-Result 'valid-plugin-upgrade' @{ installedVersion = $ExpectedVersion; oldExeReplaced = $true; identityKeyringSettingsRejectedPreserved = $true; stopped = $true }
    Set-FeedMode 'valid'
    Start-App $ExpectedVersion
    Add-Result 'candidate-restart-sign-in' @{ persisted = $true; stopped = $true }

    # Check the installed worker screen without requesting location or starting monitoring.
    # Since 0.1.12 the screen no longer lists what is recorded (owner's decision).
    $null = Wait-UiText 'Welcome\s+to\s+worktrack' 30
    $null = Wait-UiText 'I\s+understand\s+and\s+agree\s+to\s+this\s+monitoring' 30
    if ($null -ne (Get-Button 'Run local location diagnostic') -or $null -ne (Get-Button 'Clear location diagnostic')) {
        throw 'Technical location diagnostic controls must not appear on the worker screen.'
    }
    $checkboxes = @(Get-UiElements | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::CheckBox })
    $toggle = $null
    if ($checkboxes.Count -ne 1 -or -not $checkboxes[0].TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$toggle) -or $toggle.Current.ToggleState -ne [System.Windows.Automation.ToggleState]::Off) {
        throw 'Monitoring consent must start unchecked.'
    }
    $null = Wait-Button 'Start tracking' $false
    Assert-SignedInStopped $ExpectedVersion
    Stop-App
    Invoke-Fixture 'check-final'
    Start-App $ExpectedVersion
    Add-Result 'candidate-monitoring-notice-and-consent' @{ noticeVisible = $true; consentUnchecked = $true; startBlocked = $true; diagnosticControlsAbsent = $true; localStatePreserved = $true }

    Set-FeedMode 'missing'
    Invoke-Check
    $text = Wait-UiText '(?s)Could not check for updates:.*no release has been published'
    if ($text -notmatch '(?s)administrator.*publication') { throw 'Candidate feed 404 must explain the publication problem, not silently report no update.' }
    Assert-SignedInStopped $ExpectedVersion
    if ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ne $newExeHash) { throw 'Missing feed changed installed candidate.' }
    Add-Result 'candidate-feed-missing-publication-guidance' @{ visibleError = $text; candidateExeUnchanged = $true; controlsUsable = $true }

    Set-FeedMode 'future-stalled'
    Invoke-Check
    $parts = $ExpectedVersion.Split('.')
    $futureVersion = '{0}.{1}.{2}' -f $parts[0], $parts[1], ([int]$parts[2] + 1)
    $null = Wait-UiText ('Version\s+' + [regex]::Escape($futureVersion) + '\s+is ready')
    $watch = [Diagnostics.Stopwatch]::StartNew()
    Invoke-Update
    $text = Wait-UiText 'Update could not be installed:' 660
    $watch.Stop()
    if ($watch.Elapsed.TotalSeconds -lt 570 -or $watch.Elapsed.TotalSeconds -gt 660) { throw "Unexpected stalled-download timeout duration: $($watch.Elapsed.TotalSeconds)s" }
    $null = Wait-Button 'Update now'
    $null = Wait-Button 'Check for updates'
    $null = Wait-Button 'Renew sign-in'
    $null = Wait-Button 'Sign out'
    Assert-SignedInStopped $ExpectedVersion
    if ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ne $newExeHash) { throw 'Stalled download changed installed candidate.' }
    Add-Result 'candidate-stalled-download-timeout' @{ elapsedSeconds = [math]::Round($watch.Elapsed.TotalSeconds, 2); visibleError = $text; candidateExeUnchanged = $true; controlsUsable = $true }
    Set-FeedMode 'valid'
    Invoke-Check
    $null = Wait-UiText ('You are up to date on version ' + [regex]::Escape($ExpectedVersion))
    Assert-SignedInStopped $ExpectedVersion
    Stop-App
    Invoke-Fixture 'check-final'
    Add-Result 'post-timeout-recovery' @{ realCheckSucceeded = $true; statePreserved = $true; stopped = $true }
    $evidence.status = 'passed'
} catch {
    $evidence.status = 'failed'
    $evidence.failure = $_.Exception.Message
    try { $evidence.failureVisibleUi = Get-UiText } catch { $evidence.failureVisibleUi = 'UI Automation unavailable' }
    throw
} finally {
    $cleanup = @()
    # A failed installer must not restart the app after hosts isolation is removed.
    $installersStopped = $true
    try {
        $fixtureInstallers = @(Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith(($root + '\'), [StringComparison]::OrdinalIgnoreCase) -and $_.Path -ne $exe })
        foreach ($process in $fixtureInstallers) {
            & taskkill.exe /PID $process.Id /T /F | Out-Null
            if ($LASTEXITCODE -ne 0 -and (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) { throw 'Could not stop fixture installer process tree.' }
        }
    } catch { $installersStopped = $false; $cleanup += "Stop installer: $($_.Exception.Message)" }
    try { Stop-App -AllFixtureProcesses } catch { $cleanup += "Stop app: $($_.Exception.Message)" }
    if ($null -ne $feed) {
        try {
            $feed.Refresh()
            if (-not $feed.HasExited) {
                & taskkill.exe /PID $feed.Id /T /F | Out-Null
                if ($LASTEXITCODE -ne 0) { throw 'Could not terminate feed process tree.' }
                $feed.WaitForExit()
            }
        } catch { $cleanup += "Stop feed: $($_.Exception.Message)" }
    }
    # Only sanitized request metadata leaves the disposable fixture directory.
    try { $evidence.localRequests = @(Get-FeedRecords) } catch { $cleanup += "Read sanitized request evidence: $($_.Exception.Message)" }
    foreach ($name in @('access.jsonl', 'feed.stdout', 'feed.stderr')) {
        $path = Join-Path $root $name
        if (Test-Path -LiteralPath $path) {
            try { Copy-Item -LiteralPath $path -Destination (Join-Path $evidenceDir $name) } catch { $cleanup += "Copy $name evidence: $($_.Exception.Message)" }
        }
    }
    if ($installStarted -and (Test-Path -LiteralPath $installDir)) {
        try {
            $uninstallers = @(Get-ChildItem -LiteralPath $installDir -Filter '*uninstall*.exe' -File)
            if ($uninstallers.Count -ne 1) { throw 'Expected one NSIS uninstaller to clean registry and shortcuts.' }
            $uninstall = Start-Process -FilePath $uninstallers[0].FullName -ArgumentList "/S _?=$installDir" -Wait -PassThru
            if ($uninstall.ExitCode -ne 0) { throw "Uninstaller failed: $($uninstall.ExitCode)" }
        } catch { $cleanup += "Uninstall: $($_.Exception.Message)" }
    }
    if ($credentialCreated) {
        try { foreach ($target in @($credentialTarget, $oldCredentialTarget)) { [AcceptanceCredential]::Delete($target) } } catch { $cleanup += "Delete fixture credential: $($_.Exception.Message)" }
    }
    $appsStopped = $installersStopped -and @(Get-Process -Name 'worktrack-agent' -ErrorAction SilentlyContinue).Count -eq 0
    if ($identityCreated -and (Test-Path -LiteralPath $dataDir)) {
        try {
            if (-not $appsStopped) { throw 'Refusing to remove fixture SQLite while an app process remains alive.' }
            Remove-Item -LiteralPath $dataDir -Recurse -Force
        } catch { $cleanup += "Delete fixture SQLite: $($_.Exception.Message)" }
    }
    if ($hostsChanged) {
        try {
            # Never release network isolation while any fixture binary could retry.
            if (-not $appsStopped) { throw 'Hosts isolation retained until disposable runner teardown because an app process is still alive.' }
            [IO.File]::WriteAllBytes($hostsPath, $hostsOriginal)
            Clear-DnsClientCache
        } catch { $cleanup += "Restore hosts: $($_.Exception.Message)" }
    }
    if ($null -ne $cert) {
        foreach ($store in @('LocalMachine\Root', 'CurrentUser\My')) {
            try {
                $path = "Cert:\$store\$($cert.Thumbprint)"
                if (Test-Path $path) {
                    if ($store -eq 'CurrentUser\My') { Remove-Item $path -DeleteKey -Force }
                    else { Remove-Item $path -Force }
                }
                if (Test-Path $path) { throw 'Disposable certificate remained after exact-thumbprint removal.' }
            } catch { $cleanup += "Remove $store fixture certificate: $($_.Exception.Message)" }
        }
    }
    [Environment]::SetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', $oldWebViewArgs, 'Process')
    [Net.ServicePointManager]::SecurityProtocol = $oldTlsProtocol
    [Net.WebRequest]::DefaultWebProxy = $oldWebProxy
    $env:TEMP = $oldTemp
    $env:TMP = $oldTmp
    foreach ($name in $oldProxy.Keys) { [Environment]::SetEnvironmentVariable($name, $oldProxy[$name], 'Process') }
    if (Test-Path -LiteralPath $root) {
        try { Remove-Item -LiteralPath $root -Recurse -Force } catch { $cleanup += "Delete scratch and private PEM: $($_.Exception.Message)" }
    }
    $evidence.cleanupErrors = $cleanup
    if ($cleanup.Count -ne 0) { $evidence.status = 'failed' }
    Save-Evidence
    Write-Host "Evidence: $(Join-Path $evidenceDir 'upgrade-evidence.json')"
    Write-Host 'LIMITS: No real server login, real geolocation, active tracking, screenshots, or production requests.'
    if ($cleanup.Count -ne 0) { throw "Acceptance cleanup failed: $($cleanup -join ' | ')" }
}
