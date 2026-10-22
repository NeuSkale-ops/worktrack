<#
.SYNOPSIS
Locally inspect one Windows location fix without changing WorkTrack.
.DESCRIPTION
Run with Windows PowerShell 5.1: powershell.exe -NoProfile -File .\scripts\location_diagnostics.ps1 -Run
Coordinates are sensitive. Output stays in this console unless you redirect or share it.
This script does not upload data, write logs, change settings, or access WorkTrack
queues or credentials. Windows location services may use their own network providers.
This is an OS location test in PowerShell's process context, not a WorkTrack fix
or proof of the source of a historical screenshot. Existing OS permission is required.
No permission request or default-position access is performed.
#>
[CmdletBinding()]
param([switch]$Run)

$ErrorActionPreference = 'Stop'
if (-not $Run) {
    Write-Output 'Not run. Use -Run in Windows PowerShell 5.1 to display sensitive location coordinates locally.'
    return
}
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This diagnostic requires Windows PowerShell 5.1 on Windows.'
}
if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -lt 1) {
    throw 'Use Windows PowerShell 5.1 (powershell.exe), not PowerShell Core.'
}

Write-Warning 'Sensitive coordinates will appear locally. This tests the current OS provider, not a WorkTrack fix or historical source.'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Devices.Geolocation.Geolocator, Windows.Devices.Geolocation, ContentType = WindowsRuntime]
$positionType = [Windows.Devices.Geolocation.Geoposition, Windows.Devices.Geolocation, ContentType = WindowsRuntime]

# Select AsTask<TResult>(IAsyncOperation<TResult>), not a progress/action overload.
$bridges = @([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and
    $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})
if ($bridges.Count -ne 1) {
    throw 'Could not resolve the WinRT IAsyncOperation AsTask bridge.'
}

# Match the app: a new default-configured locator, zero max age, five-second timeout.
$locator = New-Object Windows.Devices.Geolocation.Geolocator
$requestedAt = [DateTimeOffset]::UtcNow
$operation = $null
try {
    $operation = $locator.GetGeopositionAsync([TimeSpan]::Zero, [TimeSpan]::FromSeconds(5))
    $task = $bridges[0].MakeGenericMethod($positionType).Invoke($null, @($operation))
    if (-not $task.Wait(7000)) {
        throw 'Windows location did not finish within the seven-second outer wait.'
    }
    $position = $task.GetAwaiter().GetResult()
    $coordinate = $position.Coordinate
    $receivedAt = [DateTimeOffset]::UtcNow
    $remote = 'unsupported or unavailable'
    try {
        # Some Windows versions do not expose this optional property.
        $remoteProperty = $coordinate.PSObject.Properties['IsRemoteSource']
        if ($null -ne $remoteProperty) { $remote = $remoteProperty.Value }
    } catch {
        $remote = 'unsupported or unavailable'
    }
    [PSCustomObject]@{
        RequestedAtUtc = $requestedAt.ToString('o')
        ReceivedAtUtc = $receivedAt.ToString('o')
        ObservedAtUtc = $coordinate.Timestamp.ToUniversalTime().ToString('o')
        Latitude = $coordinate.Latitude
        Longitude = $coordinate.Longitude
        AccuracyMeters = $coordinate.Accuracy
        PositionSource = [string]$coordinate.PositionSource
        IsRemoteSource = $remote
        WindowsVersion = [Environment]::OSVersion.VersionString
        PowerShellVersion = $PSVersionTable.PSVersion.ToString()
    } | Format-List
} finally {
    if ($null -ne $operation) {
        # Cancel also on timeout/error. Cancellation after completion is harmless.
        try { $operation.Cancel() } catch { }
    }
}
