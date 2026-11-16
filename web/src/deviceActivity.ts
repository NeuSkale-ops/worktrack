export interface DeviceConfig {
  foreground_apps: boolean
  idle_time: boolean
  session_events: boolean
  screenshots: boolean
  location: boolean
  screenshot_interval_secs: number
  excluded_apps: string[]
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
