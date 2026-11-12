import { useState } from 'react'
import { api, post } from './api'

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

export default function Devices() {
  const [devices, setDevices] = useState<Device[]>([])
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [secret, setSecret] = useState('')

  async function load() {
    setBusy(true)
    setError('')
    try {
      setDevices(await api<Device[]>('/devices'))
      setLoaded(true)
    } catch (e) {
      setDevices([])
      setError(e instanceof Error ? e.message : 'Unable to load devices.')
    } finally {
      setBusy(false)
    }
  }

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
    <section className="card devices" aria-labelledby="devices-heading">
      <details>
        <summary id="devices-heading">Managed devices (owner only)</summary>
        <p className="muted">
          Company-owned Windows laptops running the disclosed monitoring agent.
          Capture is admin-controlled here and visible to the employee on the
          device. A stale check-in is the tamper signal; the agent is never
          hidden.
        </p>
        <p className="muted">
          <a className="button" href="/downloads/managed-agent/worktrack-managed-agent.zip" download>
            Download Windows agent (.zip)
          </a>{' '}
          Unsigned build for IT. Deploy via Intune with the enrollment secret
          below. See <code>deploy/managed-agent/README.md</code>.
        </p>
        <div className="block-actions">
          <button onClick={() => void load()} disabled={busy}>
            {busy ? 'Loading…' : 'Load devices'}
          </button>
          <button onClick={() => void addDevice()} disabled={busy}>
            Add device (enrollment secret)
          </button>
          <button className="delete" onClick={() => void revokeSecrets()} disabled={busy}>
            Revoke enrollment secrets
          </button>
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
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </details>
    </section>
  )
}
