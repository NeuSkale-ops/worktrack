import { useEffect, useState } from 'react'
import { api } from './api'
import { configError, hm, savedConfig, parseExcluded, summarize } from './deviceActivity'
import type { DeviceConfig, DeviceEvent } from './deviceActivity'

const localDay = () => new Date().toLocaleDateString('en-CA')

export function DeviceConfigForm({ deviceId, saved, onSaved }: { deviceId: string; saved?: Partial<DeviceConfig>; onSaved: () => void }) {
  const [cfg, setCfg] = useState<DeviceConfig>(() => savedConfig(saved))
  const [excluded, setExcluded] = useState(() => savedConfig(saved).excluded_apps.join('\n'))
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const next = { ...cfg, excluded_apps: parseExcluded(excluded) }
  const invalid = configError(next)
  const set = (patch: Partial<DeviceConfig>) => setCfg({ ...cfg, ...patch })

  async function save() {
    if (invalid) return
    if (!confirm('Replace this device\'s capture settings? The employee\'s tray icon and notice already disclose what is captured.')) return
    setBusy(true)
    setStatus('')
    try {
      await api(`/devices/${encodeURIComponent(deviceId)}/config`, { method: 'PUT', body: JSON.stringify(next) })
      setStatus('Saved. The device applies it at its next check-in, within a minute.')
      onSaved()
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Could not save settings.')
    } finally {
      setBusy(false)
    }
  }

  const box = (key: keyof DeviceConfig, label: string, disabled = false) => (
    <label className="check"><input type="checkbox" checked={Boolean(cfg[key])} disabled={disabled}
      onChange={e => set({ [key]: e.target.checked } as Partial<DeviceConfig>)} />{label}</label>
  )

  return (
    <fieldset className="device-config" disabled={busy}>
      <legend>Capture settings</legend>
      <p className="muted">Saving replaces all settings for this device. Defaults are the least data: time, apps and session events, no screenshots.</p>
      {box('idle_time', 'Active and idle time')}
      {box('foreground_apps', 'Program names (never titles, files or sites)')}
      {box('session_events', 'Logon, logoff, lock and unlock')}
      {box('screenshots', 'Screenshots of the main display')}
      {box('location', 'Approximate location with each screenshot', !cfg.screenshots)}
      <label>Minutes between screenshots
        <input type="number" min={1} max={60} value={cfg.screenshot_interval_secs / 60} disabled={!cfg.screenshots}
          onChange={e => set({ screenshot_interval_secs: Math.round(Number(e.target.value) * 60) })} />
      </label>
      <label>Never record these programs by name (one per line, like keepass.exe)
        <textarea rows={3} value={excluded} onChange={e => setExcluded(e.target.value)} />
      </label>
      {invalid && <p className="error" role="alert">{invalid}</p>}
      <div><button className="primary" onClick={() => void save()} disabled={busy || Boolean(invalid)}>Save settings</button></div>
      {status && <p role="status" className="muted">{status}</p>}
    </fieldset>
  )
}

/** One laptop's recorded day. `sinceAssigned` tells managers why earlier days can be empty. */
export function DeviceActivity({ deviceId, hostname, sinceAssigned }: { deviceId: string; hostname: string; sinceAssigned: boolean }) {
  const [date, setDate] = useState(localDay())
  const [events, setEvents] = useState<DeviceEvent[] | null>(null)
  const [error, setError] = useState('')
  // Loads on open, so it starts busy and never shows an empty frame first.
  const [busy, setBusy] = useState(true)

  async function load(day = date) {
    setBusy(true)
    setError('')
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      setEvents(await api<DeviceEvent[]>(`/devices/${encodeURIComponent(deviceId)}/activity?date=${day}&tz=${encodeURIComponent(tz)}`))
    } catch (e) {
      setEvents(null)
      setError(e instanceof Error ? e.message : 'Could not load activity.')
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => { void load() }, [])

  const summary = events ? summarize(events) : null
  const shots = events?.filter(e => e.kind === 'screenshot') ?? []
  const sessions = events?.filter(e => e.kind === 'session' || e.kind === 'acknowledged') ?? []
  const appMax = summary?.apps[0]?.[1] || 1

  return (
    <section className="device-activity" aria-label={`Activity on ${hostname}`} aria-busy={busy}>
      <div className="option">
        <label>Day <input type="date" value={date} max={localDay()} required onChange={e => { if (e.target.value) { setDate(e.target.value); void load(e.target.value) } }} /></label>
        <button onClick={() => void load()} disabled={busy}>{busy ? 'Loading…' : 'Refresh activity'}</button>
      </div>
      {sinceAssigned && <p className="muted">Shows activity recorded since this laptop was last assigned.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {events && !events.length && <p role="status" className="muted">No activity recorded on this day.</p>}
      {summary && events && events.length > 0 && (
        <>
          <div className="facts">
            <div><b>{hm(summary.activeSecs)}</b><span>Active</span></div>
            <div><b>{hm(summary.idleSecs)}</b><span>Idle</span></div>
            <div><b>{hm(summary.lockedSecs)}</b><span>Locked</span></div>
          </div>
          {summary.apps.length > 0 && (
            <ul className="apps" aria-label="Time per program">
              {summary.apps.slice(0, 15).map(([app, secs]) => (
                <li className="app-row" key={app}>
                  <span>{app}</span><span>{hm(secs)}</span>
                  <span className="fill" aria-hidden="true"><i style={{ width: `${(secs / appMax) * 100}%` }} /></span>
                </li>
              ))}
            </ul>
          )}
          {sessions.length > 0 && (
            <details>
              <summary>Session events ({sessions.length})</summary>
              <ul>{sessions.map(e => (
                <li key={e.event_id}>
                  {new Date(e.occurred_at).toLocaleTimeString()} {e.kind === 'acknowledged' ? 'monitoring notice acknowledged' : e.payload.event}
                  {e.payload.user ? ` (${e.payload.user})` : ''}
                </li>
              ))}</ul>
            </details>
          )}
          {shots.length > 0 && (
            <div className="device-shots">
              {shots.map(e => (
                <figure key={e.event_id}>
                  {e.screenshot_url
                    ? <a href={e.screenshot_url} target="_blank" rel="noreferrer"><img src={e.screenshot_url} loading="lazy" alt={`Screenshot at ${new Date(e.occurred_at).toLocaleTimeString()}`} /></a>
                    : <p className="muted">Screenshot unavailable</p>}
                  <figcaption>
                    {new Date(e.occurred_at).toLocaleTimeString()} {e.payload.app ?? ''}
                    {e.payload.location?.status === 'available' && e.payload.location.latitude !== undefined &&
                      `, ${e.payload.location.latitude.toFixed(3)}, ${e.payload.location.longitude?.toFixed(3)} (±${Math.round(e.payload.location.accuracy_m ?? 0)} m)`}
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  )
}
