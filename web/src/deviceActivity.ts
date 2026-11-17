export interface DeviceConfig {
  foreground_apps: boolean
  idle_time: boolean
  session_events: boolean
  screenshots: boolean
  location: boolean
  screenshot_interval_secs: number
  excluded_apps: string[]
}

export interface Device {
  id: string
  /** The person this laptop is assigned to, or null. */
  user_id: string | null
  upn: string
  hostname: string
  name: string | null
  enabled: boolean
  paused: boolean
  uninstall: boolean
  agent_version: string
  config_version: number
  config?: Partial<DeviceConfig>
  last_checkin_at: string | null
  last_sync_at: string | null
  buffer_depth: number
  dropped_events: number
  acked_seq: number
}

// A device is healthy if it checked in within the last 15 minutes. A longer
// silence is the only signal that the agent was stopped. It is never hidden.
export function health(d: Pick<Device, 'last_checkin_at' | 'uninstall' | 'paused' | 'enabled'>, now = Date.now()): { label: string; tone: 'ok' | 'warn' | 'bad' } {
  if (!d.last_checkin_at) return { label: 'awaiting first check-in', tone: 'warn' }
  if (now - new Date(d.last_checkin_at).getTime() > 15 * 60 * 1000) return { label: 'stale (possible tamper)', tone: 'bad' }
  if (d.uninstall) return { label: 'uninstalling', tone: 'warn' }
  if (d.paused) return { label: 'paused', tone: 'warn' }
  if (!d.enabled) return { label: 'disabled', tone: 'warn' }
  return { label: 'active', tone: 'ok' }
}

export interface DeviceEvent {
  event_id: string
  kind: 'activity' | 'screenshot' | 'session' | 'acknowledged' | string
  occurred_at: string
  payload: {
    user?: string
    active_secs?: number
    idle_secs?: number
    locked_secs?: number
    apps?: Record<string, number>
    app?: string | null
    event?: string
    capture_failed?: boolean
    location?: { status: string; latitude?: number; longitude?: number; accuracy_m?: number }
  }
  screenshot_url?: string
}

export const defaultConfig: DeviceConfig = {
  foreground_apps: true,
  idle_time: true,
  session_events: true,
  screenshots: false,
  location: false,
  screenshot_interval_secs: 600,
  excluded_apps: [],
}

// Mirrors agent/managed/src/config.rs validation so the owner sees the error
// here instead of the agent silently keeping its previous config.
export function configError(c: DeviceConfig): string {
  if (c.screenshots && (c.screenshot_interval_secs < 60 || c.screenshot_interval_secs > 3600)) {
    return 'Screenshot interval must be 1 to 60 minutes.'
  }
  if (c.location && !c.screenshots) return 'Location requires screenshots.'
  if (c.excluded_apps.length > 256) return 'At most 256 excluded apps.'
  return ''
}

// Saved device config merged over defaults. The server keeps exactly what the
// owner saved, which is {} for a device that was never configured.
export function savedConfig(saved: Partial<DeviceConfig> | null | undefined): DeviceConfig {
  const { version: _v, ...rest } = (saved ?? {}) as Partial<DeviceConfig> & { version?: number }
  return { ...defaultConfig, ...rest }
}

export function parseExcluded(text: string): string[] {
  return [...new Set(text.split(/[\n,]/).map(s => s.trim().toLowerCase()).filter(Boolean))]
}

export interface ActivitySummary {
  activeSecs: number
  idleSecs: number
  lockedSecs: number
  apps: [string, number][]
}

export function summarize(events: DeviceEvent[]): ActivitySummary {
  const apps = new Map<string, number>()
  let activeSecs = 0, idleSecs = 0, lockedSecs = 0
  for (const e of events) {
    if (e.kind !== 'activity') continue
    activeSecs += e.payload.active_secs ?? 0
    idleSecs += e.payload.idle_secs ?? 0
    lockedSecs += e.payload.locked_secs ?? 0
    for (const [app, secs] of Object.entries(e.payload.apps ?? {})) apps.set(app, (apps.get(app) ?? 0) + secs)
  }
  return { activeSecs, idleSecs, lockedSecs, apps: [...apps].sort((a, b) => b[1] - a[1]) }
}

export const hm = (secs: number) => {
  const m = Math.round(secs / 60)
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}
