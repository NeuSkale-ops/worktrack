import { useState } from 'react'
import { api } from './api'
import { configError, savedConfig, parseExcluded } from './deviceActivity'
import type { DeviceConfig } from './deviceActivity'

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

