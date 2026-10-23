# WorkTrack 0.1.8: location quality and source reporting

## Changes

- Windows now explicitly requests high-accuracy system positioning instead of the default 500-metre setting.
- Mac keeps the best fresh result within its five-second lookup window instead of stopping at the first coarse result. A result with a reported radius of 100 metres or better may finish early.
- Screenshot location records preserve optional system position source and remote-source metadata. Older records remain compatible and are not rewritten.
- The dashboard describes coordinates as system estimates, marks results above a 1,000-metre reported radius as coarse, and displays source and remote-source information when supplied. It never describes these estimates as verified whereabouts.

## Accuracy limitations

Requesting high accuracy cannot guarantee that the operating system returns the correct physical location. A recent timestamp and a small reported radius are not independent proof of geographic accuracy. macOS does not provide Windows-style source labels through this bridge, so its source remains unknown rather than invented.

Do not infer attendance or movement from an unverified estimate. Historical incorrect readings are unchanged. Run the local location diagnostic on the affected machine and compare its result with known physical location before asserting that this release resolves that machine's discrepancy.

## Installation

Stop tracking and allow queued data to sync before installing. Mac builds remain Apple Silicon previews for macOS 11 or later, ad-hoc signed and not notarized, with manual updates only. Windows publication requires the existing signature verification and real installed-upgrade recovery gates. No updater verification gates are relaxed for this release.

## Verification evidence

Release application source: `6637c75998acd9b73c0ca8a13b6eab915a777fd2`. Release workflow: `39995100603`.

- Native tests: 40 passed, with the physical-console test explicitly ignored. The SQLite queue regression preserves optional provenance and rejects invalid fixes without leaving metadata behind.
- macOS delegate checks exercised best-fix selection, the early-success threshold, deadline handling, cancellation and missing fixes without requesting location permission or collecting coordinates.
- API tests against PostgreSQL 17 exercised provenance ingestion, duplicate acknowledgment, persisted `false` remote-source values, role-scoped responses and validation. Web tests and production builds passed.
- Before API/dashboard deployment, an encrypted off-host backup restored successfully into isolated PostgreSQL 17. User/session/block counts matched at 2/8/150. Deployment left the production database container unchanged.
- Public HTTPS timeline checks matched all four existing location records against stored coordinates, accuracy and timestamps. Actual desktop and mobile screenshot dialogs described legacy records as system estimates with unreported provenance, without claiming verified location. Temporary acceptance credentials were removed and existing tracking records were not modified.
- The exact CI Apple Silicon DMG passed checksum, disk-image and code-signature verification. An isolated installation launched version 0.1.8 and quit normally without changing the original local queue. Public desktop/mobile download checks retrieved that same DMG and preserved the Windows download link.

Published Mac DMG SHA-256: `fed4342a34b229e679fac85ed1fc0460b4653d0de637f5d254b45ad956dfb996`.

Windows workflow `39995100603` completed successfully, including signed build, independent signature verification, installed-upgrade acceptance and protected production publication. All 14 recorded Windows scenarios passed with no cleanup errors. The real plugin upgraded 0.1.5 to 0.1.8 while preserving local identity and settings, rejected tampered and wrong-key installers, recovered from interrupted downloads, and recovered after a 603-second stalled download. The installed diagnostic exercised real native IPC and reported permission denied without collecting a position. These isolated, offline-seeded checks do not prove connected tracking or physical accuracy.

The upgrade evidence identifies the exact candidate archive SHA-256 as `d02a1eac3edab4470d3c8b2b254c72db0680467a8c027066c7be1a7419b4ba4c`, matching the downloaded archive. Public production acceptance retrieved Windows version 0.1.8, verified installer SHA-256 `91208f5bcc42fe1870e307f9e6fcd293462039e60af1e3923f116af69a1d739a`, checksum link, attachment/cache headers and missing/private path protections. Actual desktop/mobile Settings checks were rerun after Windows publication and retained both platform downloads.

No affected-machine physical location or successful sensor fix was verified. Mac remains ad-hoc signed, not notarized, and does not auto-update.

Release builds used clean committed archives. The unrelated existing local `server/reports.go` edits and untracked `velvet.yaml` were left untouched. Velvet logging was blocked by missing repository credentials.
