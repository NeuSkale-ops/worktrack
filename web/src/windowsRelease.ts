export const releaseFeed = '/updates/windows/x86_64/latest.json'

export type WindowsRelease = { version: string; url: string; checksums: string }

export function windowsRelease(value: unknown, origin: string): WindowsRelease {
  const manifest = value as { version?: unknown; platforms?: { 'windows-x86_64'?: { url?: unknown } } } | null
  const version = manifest?.version
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('Invalid stable release version')
  }
  const path = `/updates/windows/x86_64/releases/${version}/worktrack-setup.exe`
  const url = manifest?.platforms?.['windows-x86_64']?.url
  // Compare raw strings too: URL parsing normalizes traversal and encoded paths.
  if (url !== path && url !== `${origin}${path}`) throw new Error('Invalid installer URL')
  return { version, url: path, checksums: path.replace('worktrack-setup.exe', 'SHA256SUMS') }
}

export async function fetchWindowsRelease(origin: string, signal: AbortSignal): Promise<WindowsRelease> {
  const response = await fetch(releaseFeed, { cache: 'no-store', redirect: 'error', signal })
  if (!response.ok) throw new Error('Windows release unavailable')
  return windowsRelease(await response.json(), origin)
}
