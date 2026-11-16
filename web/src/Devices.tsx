import { useEffect, useState } from 'react'
import { api, post, withOrg } from './api'
import { DeviceActivity, DeviceConfigForm } from './DeviceDetail'
import { fetchManagedAgentRelease } from './managedAgentRelease'
import type { ManagedAgentRelease } from './managedAgentRelease'
import type { DeviceConfig } from './deviceActivity'

interface Device {
  id: string
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

const since = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never')

// A device is "healthy" if it checked in within the last 15 minutes. A longer
// silence is the only signal that the agent was stopped; it is never hidden.
function health(d: Device): string {
  if (!d.last_checkin_at) return 'awaiting first check-in'
  const age = Date.now() - new Date(d.last_checkin_at).getTime()
  if (age > 15 * 60 * 1000) return 'stale (possible tamper)'
  if (d.uninstall) return 'uninstalling'
  if (d.paused) return 'paused'
  if (!d.enabled) return 'disabled'
  return 'active'
}

export default function Devices({ owner, org }: { owner: boolean; org: string }) {
  const [devices, setDevices] = useState<Device[]>([])
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [secret, setSecret] = useState('')
  const [release, setRelease] = useState<ManagedAgentRelease | null>(null)
  const [checking, setChecking] = useState(true)
  const [open, setOpen] = useState('')
  const openDevice = devices.find(d => d.id === open)

  useEffect(() => {
    const controller = new AbortController()
    fetchManagedAgentRelease(controller.signal)
      .then(setRelease)
      // No link is offered when the release is missing from this deployment.
      .catch(() => {})
      .finally(() => { if (!controller.signal.aborted) setChecking(false) })
    return () => controller.abort()
  }, [])

  async function load() {
    setBusy(true)
    setError('')
    try {
      setDevices(await api<Device[]>(withOrg('/devices', org)))
      setLoaded(true)
    } catch (e) {
      setDevices([])
      setError(e instanceof Error ? e.message : 'Unable to load devices.')
    } finally {
      setBusy(false)
    }
  }

  // Devices is its own page now, so load on open.
  useEffect(() => { void load() }, [])

  // Health is derived from check-in age, so a stale table shows a false
  // "possible tamper". Refresh quietly every minute once loaded.
  useEffect(() => {
    if (!loaded) return
    const t = setInterval(() => {
      api<Device[]>(withOrg('/devices', org)).then(setDevices).catch(() => {})
    }, 60_000)
    return () => clearInterval(t)
  }, [loaded])

  async function addDevice() {
    setBusy(true)
    setError('')
    try {
      const r = await post<{ secret: string }>('/devices/enrollments', {})
      setSecret(r.secret)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to create enrollment secret.')
    } finally {
      setBusy(false)
    }
  }

  async function revokeSecrets() {
    if (!confirm('Revoke every outstanding enrollment secret? Enrolled devices keep working.')) return
    setBusy(true)
    setError('')
    try {
      await post('/devices/enrollments/revoke', {})
      setSecret('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to revoke enrollment secrets.')
    } finally {
      setBusy(false)
    }
  }

  async function command(d: Device, cmd: string, confirmText: string) {
    if (!confirm(confirmText)) return
    setBusy(true)
    setError('')
    try {
      await post(`/devices/${encodeURIComponent(d.id)}/command`, { command: cmd })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Command failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
    {owner && <section className="card download" aria-labelledby="managed-agent-heading" aria-busy={checking}>
      <div>
        <h2 id="managed-agent-heading">WorkTrack managed agent for Windows</h2>
        <p className="muted" role="status">{checking ? 'Checking managed agent release…' : release ? `Version ${release.version}, 64-bit, unsigned test build` : 'Managed agent download is not available in this deployment.'}</p>
        <p className="muted">For company-owned laptops, installed by IT.</p>
      </div>
      {release && <a className="button" href={release.url} download>Download (.zip)</a>}
      <details>
        <summary>Install steps</summary>
        <ol>
          <li>Below, select Add device and copy the enrollment secret.</li>
          <li>Extract the zip on the laptop and open PowerShell as administrator in that folder.</li>
          <li>Run <code>powershell.exe -ExecutionPolicy Bypass -File install.ps1 -EnrollSecret "SECRET" -Upn "user@company.com"</code>. Windows may show a publisher warning.</li>
          <li>The laptop appears below within a minute.</li>
        </ol>
        <p className="muted">After install the service checks in within a minute. Each signed-in user sees a one-time monitoring notice and a tray icon. Capture defaults to time, program names and session events. Turn on screenshots per device under Settings. Remove it with Uninstall below or <code>uninstall.ps1</code>.</p>
        {release && <p className="muted">SHA-256 of the zip: <code style={{ overflowWrap: 'anywhere' }}>{release.sha256}</code></p>}
      </details>
    </section>}
    <section className="card devices" aria-labelledby="devices-heading">
      <details open>
        <summary id="devices-heading">Managed devices</summary>
        <p className="muted">
          Company-owned Windows laptops running the disclosed monitoring agent.
          Capture is admin-controlled here and visible to the employee on the
          device. A stale check-in is the tamper signal; the agent is never
          hidden.
        </p>
        <div className="block-actions">
          <button onClick={() => void load()} disabled={busy}>
            {busy ? 'Loading…' : 'Refresh'}
          </button>
          {owner && <button onClick={() => void addDevice()} disabled={busy}>
            Add device (enrollment secret)
          </button>}
          {owner && <button className="delete" onClick={() => void revokeSecrets()} disabled={busy}>
            Revoke enrollment secrets
          </button>}
        </div>
        {secret && (
          <p role="status" className="enroll-secret">
            Enrollment secret (valid 7 days, enrolls every laptop in the
            Intune assignment, revoke when the rollout is done). Pass to
            Intune install:
            <code>{secret}</code>
          </p>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        {loaded && !busy && !error && !devices.length && (
          <p role="status">No devices enrolled yet.</p>
        )}
        {devices.length > 0 && (
          <div className="table-scroll" aria-busy={busy}>
            <table>
              <caption className="sr-only">Enrolled managed devices</caption>
              <thead><tr>
                <th scope="col">Host</th><th scope="col">User</th>
                <th scope="col">Health</th><th scope="col">Version</th>
                <th scope="col">Last check-in</th><th scope="col">Last sync</th>
                <th scope="col">Buffer</th><th scope="col">Dropped</th>
                <th scope="col">Controls</th>
                <th scope="col">Details</th>
              </tr></thead>
              <tbody>{devices.map(d => (
                <tr key={d.id}>
                  <th scope="row">{d.hostname || '(unknown)'}</th>
                  <td>{d.name || d.upn}</td>
                  <td>{health(d)}</td>
                  <td>{d.agent_version || '—'} (cfg v{d.config_version})</td>
                  <td>{since(d.last_checkin_at)}</td>
                  <td>{since(d.last_sync_at)}</td>
                  <td>{d.buffer_depth}</td>
                  <td>{String(d.dropped_events)}</td>
                  <td className="block-actions">
                    {d.paused
                      ? <button disabled={busy || d.uninstall} onClick={() => void command(d, 'resume', `Resume capture on ${d.hostname}?`)}>Resume</button>
                      : <button disabled={busy || d.uninstall} onClick={() => void command(d, 'pause', `Pause capture on ${d.hostname}?`)}>Pause</button>}
                    {d.enabled
                      ? <button disabled={busy || d.uninstall} onClick={() => void command(d, 'disable', `Disable monitoring on ${d.hostname}?`)}>Disable</button>
                      : <button disabled={busy || d.uninstall} onClick={() => void command(d, 'enable', `Enable monitoring on ${d.hostname}?`)}>Enable</button>}
                    <button className="delete" disabled={busy || d.uninstall}
                      onClick={() => void command(d, 'uninstall', `Uninstall the agent from ${d.hostname}? This is irreversible from here and applied on next check-in.`)}>
                      Uninstall
                    </button>
                  </td>
                  <td>
                    <button aria-expanded={open === d.id} onClick={() => setOpen(open === d.id ? '' : d.id)}>
                      {open === d.id ? 'Hide' : 'Activity and settings'}
                    </button>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {openDevice && (
          <div className="device-detail">
            <h3>{openDevice.hostname || '(unknown)'}: {openDevice.name || openDevice.upn}</h3>
            <DeviceActivity key={`a-${openDevice.id}`} deviceId={openDevice.id} hostname={openDevice.hostname} />
            <details>
              <summary>Settings (current: config v{openDevice.config_version})</summary>
              <DeviceConfigForm key={`c-${openDevice.id}`} deviceId={openDevice.id} saved={openDevice.config} onSaved={() => void load()} />
            </details>
          </div>
        )}
      </details>
    </section>
    </>
  )
}
