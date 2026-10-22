export const macReleaseFeed = '/downloads/macos/latest.json'

export type MacRelease = { version: string; url: string; checksums: string; sha256: string }

export function macRelease(value: unknown, origin: string): MacRelease {
  const manifest = value as { version?: unknown; architecture?: unknown; url?: unknown; sha256?: unknown; signing?: unknown; notarized?: unknown } | null
  const version = manifest?.version
  if (typeof version !== 'string' || version.trim() !== version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('Invalid stable release version')
  }
  const directory = `/downloads/macos/${version}`
  const path = `${directory}/WorkTrack_${version}_aarch64.dmg`
  // Compare raw strings too: URL parsing normalizes traversal and encoded paths.
  if (manifest?.url !== path && manifest?.url !== `${origin}${path}`) throw new Error('Invalid installer URL')
  if (manifest.architecture !== 'aarch64' || manifest.signing !== 'ad-hoc' || manifest.notarized !== false) {
    throw new Error('Invalid Mac preview metadata')
  }
  if (typeof manifest.sha256 !== 'string' || manifest.sha256.length !== 64 || !/^[a-fA-F0-9]{64}$/.test(manifest.sha256)) throw new Error('Invalid SHA-256 checksum')
  return { version, url: path, checksums: `${directory}/SHA256SUMS`, sha256: manifest.sha256 }
}

export async function fetchMacRelease(origin: string, signal: AbortSignal): Promise<MacRelease> {
  const response = await fetch(macReleaseFeed, { cache: 'no-store', redirect: 'error', signal })
  if (!response.ok) throw new Error('Mac release unavailable')
  return macRelease(await response.json(), origin)
}
