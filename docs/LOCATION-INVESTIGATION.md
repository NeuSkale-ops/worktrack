# Screenshot location discrepancy investigation

Observed October 22, 2026, 05:25–05:28 UTC.

## Report and actual observations

The owner reported a screenshot located in South America although the Windows machine is physically in India. This is a correctness report, not evidence of employee movement.

A read-only production query found four `available` screenshot locations, all with the same negative latitude and negative longitude, claimed accuracy of 500 metres, and fix timestamps from two seconds before to one second after capture. Two other screenshot locations were `unavailable`. Exact coordinates and worker identifiers are intentionally omitted here.

A narrow probe compared all four existing locations with the actual public authenticated `GET /api/timeline` response. Latitude, longitude, accuracy, captured time and observed time matched the database exactly for every row. Its exact five-minute labelled temporary credential was deleted and absence confirmed. No screenshots, blocks, tracking sessions or location values were changed. No screenshot images or signed URLs were downloaded or logged.

This rules out a coordinate swap, sign change or accuracy change between the stored record and the current API response. The current React formatter prints latitude followed by longitude without transformation. The collection code reads Windows `Latitude()`, `Longitude()` and `Accuracy()` directly into those same fields. Source inspection does not independently prove what the affected Windows provider returned during those historical captures.

Existing Go monitoring validation and all twelve frontend API/utility tests passed. Those tests check format, freshness and presentation, not physical location.

## Unresolved physical correctness

The application accepts a finite, geographically valid, fresh Windows position. It does not record Windows `PositionSource` or whether the source was redirected remotely. Consequently the existing rows cannot establish whether the estimate came from satellite, Wi-Fi, IP address, a manually configured default, or remote redirection. Fresh timestamps and a 500-metre accuracy claim do not establish that a fix is physically correct.

Windows location services can use GPS, Wi-Fi/router data, cellular, IP address or a default location. WorkTrack implements no separate IP-geolocation service, but that does not mean the underlying Windows service never uses IP information. Windows also exposes a remote-source flag on supported Windows 11 versions.

Official references:

- https://support.microsoft.com/en-us/windows/privacy/windows-location-service-and-privacy
- https://learn.microsoft.com/en-us/uwp/api/windows.devices.geolocation.positionsource
- https://learn.microsoft.com/en-us/uwp/api/windows.devices.geolocation.geocoordinate.isremotesource

The next acceptance check must run against the affected, unlocked Windows machine using the same Windows geolocation API, including its source, accuracy, fix timestamp and remote-source flag. A hosted CI machine cannot stand in for this device's sensor/provider configuration. Do not hardcode India, fabricate replacement coordinates, silently rewrite historical records or label unverified locations as attendance proof.

The local diagnostic `scripts/location_diagnostics.ps1` requests one fresh Windows position without changing WorkTrack, Windows location settings or stored records. Run it on the affected PC using Windows PowerShell 5.1:

```powershell
powershell.exe -NoProfile -STA -File .\scripts\location_diagnostics.ps1 -Run
```

Its coordinates are sensitive local output. Do not paste exact coordinates into public issues. Compare the result with the machine's known physical location and inspect `PositionSource`, the reported accuracy and `IsRemoteSource` when available. An accurate diagnostic result today does not retroactively validate an older screenshot. A script parse check on macOS does not validate actual Windows sensor access or the result's physical correctness.

## Release state

Production publication workflow `39727480185` was cancelled before publication after this report. Independent candidate verification passed; the native upgrade and publication jobs were cancelled. GitHub v0.1.6 remains a draft. No application bytes or signing keys were changed during this investigation. Prior installed-updater acceptance remains valid for updater behavior, not location accuracy.

## Whole-result recheck, 05:31–05:32 UTC

- **Requested release availability:** production and staging manifests returned HTTP 404, and the canonical 0.1.6 installer returned HTTP 404. Publication is not delivered. GitHub reports `isDraft=true`, with cancellation now stated explicitly in its notes.
- **Candidate identity and packaging:** the original archive passed real local minisign/trusted-version/checksum/production-URL verification again. The draft installer asset digest equals the tested installer SHA-256, `9f5e382623d460415a100d45a8798d4a530146150fd02f28263230838bcbf176`; the draft contains the matching signature and checksum assets and targets the original signed source. This is draft packaging evidence, not a public download acceptance.
- **Existing distribution and service continuity:** the previous immutable v0.1.5 installer returned HTTP 200. The dashboard and public API health returned HTTP 200. No installer identity was overwritten and no historical location record was corrected or erased.
- **Affected location data path:** the actual public timeline/database comparison was rerun after all changes. All four incident location objects still matched exactly, and exact temporary credential cleanup passed again. This proves faithful data transport, not a true physical fix.
- **Changed diagnostic behavior:** official local PowerShell parsing passed; without `-Run`, a mocked `Add-Type` trap proved WinRT loading was not reached. With `-Run` on this macOS host, the diagnostic rejected the unsupported platform. The remote-source receiver was checked against the documented `Geocoordinate` property. Actual Windows PowerShell 5.1 sensor execution remains blocked by lack of the affected device.
- **Validation/presentation regression:** the Go monitoring validation test and all twelve frontend API/utility tests passed again. Freshness, numeric range and formatting checks do not establish location truth. The external acceptance condition remains a same-device position/source check against known physical location.
