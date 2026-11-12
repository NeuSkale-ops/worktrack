// The managed agent zip ships inside the dashboard image next to this manifest
// (see the Deploy workflow), so a manifest that parses means the file exists.
export const managedAgentFeed = '/managed-agent/latest.json'

export type ManagedAgentRelease = { version: string; url: string; sha256: string }

export function managedAgentRelease(value: unknown): ManagedAgentRelease {
  const manifest = value as { version?: unknown; sha256?: unknown } | null
  const version = manifest?.version
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('Invalid managed agent version')
  }
  const sha256 = manifest?.sha256
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid SHA-256 checksum')
  return { version, url: `/managed-agent/worktrack-managed-agent-${version}.zip`, sha256 }
}

export async function fetchManagedAgentRelease(signal?: AbortSignal): Promise<ManagedAgentRelease> {
  const response = await fetch(managedAgentFeed, { cache: 'no-store', redirect: 'error', signal })
  if (!response.ok) throw new Error('Managed agent release unavailable')
  // A missing manifest is answered with the dashboard HTML, which fails here.
  return managedAgentRelease(await response.json())
}
