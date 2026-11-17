import { useEffect, useState } from 'react'
import { api, post } from './api'
import type { Worker } from './api'
import AgentLogs from './AgentLogs'
import { DeviceActivity, DeviceConfigForm } from './DeviceDetail'
import { health } from './deviceActivity'
import type { Device } from './deviceActivity'
import { fetchManagedAgentRelease } from './managedAgentRelease'
import type { ManagedAgentRelease } from './managedAgentRelease'
import Modal from './Modal'
import Tabs from './Tabs'

const since = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'Never')
const host = (d: Device) => d.hostname || '(unknown)'
const pageTabs = ['Laptops', 'Desktop app diagnostics'] as const

/**
 * Company laptops running the managed agent. Owners and managers assign each
 * laptop to the person who uses it. Its activity then shows under that person.
 */
export default function Devices({ owner, devices, people, loading, open, onOpen, onChange }: {
  owner: boolean
  devices: Device[]
  /** People a laptop can be assigned to. */
  people: Worker[]
  loading: boolean
  /** Id of the laptop shown in the drawer, or ''. */
  open: string
  onOpen: (id: string) => void
  onChange: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [secret, setSecret] = useState('')
  const [release, setRelease] = useState<ManagedAgentRelease | null>(null)
  const [checking, setChecking] = useState(owner)
  const [tab, setTab] = useState<typeof pageTabs[number]>('Laptops')
  const openDevice = devices.find(d => d.id === open)

  useEffect(() => {
    if (!owner) return
    const controller = new AbortController()
    fetchManagedAgentRelease(controller.signal)
      .then(setRelease)
      // No link is offered when the release is missing from this deployment.
      .catch(() => {})
      .finally(() => { if (!controller.signal.aborted) setChecking(false) })
    return () => controller.abort()
  }, [owner])

  async function run(action: () => Promise<unknown>, failure: string) {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (e) {
      setError(e instanceof Error ? e.message : failure)
    } finally {
      setBusy(false)
    }
  }

  const addDevice = () => run(async () => {
    setSecret((await post<{ secret: string }>('/devices/enrollments', {})).secret)
  }, 'Unable to create enrollment secret.')

  function revokeSecrets() {
    if (!confirm('Revoke every outstanding enrollment secret? Enrolled devices keep working.')) return
    void run(async () => {
      await post('/devices/enrollments/revoke', {})
      setSecret('')
    }, 'Unable to revoke enrollment secrets.')
  }

  function command(d: Device, cmd: string, confirmText: string) {
    if (!confirm(confirmText)) return
    void run(async () => {
      await post(`/devices/${encodeURIComponent(d.id)}/command`, { command: cmd })
      await onChange()
    }, 'Command failed.')
  }

  function assign(d: Device, userId: string) {
    const person = people.find(p => p.id === userId)
    if (!confirm(person
      ? `Assign ${host(d)} to ${person.name || person.email}? Its activity from now on shows under them. Earlier activity is not moved.`
      : `Unassign ${host(d)}? Its activity will not show under anyone, and only owners will see this laptop.`)) return
    void run(async () => {
      await api(`/devices/${encodeURIComponent(d.id)}/user`, { method: 'PUT', body: JSON.stringify({ user_id: userId || null }) })
      await onChange()
    }, 'Unable to assign this laptop.')
  }

  // Managers cannot unassign: an unassigned laptop is visible to owners only.
  const assignSelect = (d: Device) => (
    <select aria-label={`Person assigned to ${host(d)}`} value={d.user_id ?? ''} disabled={busy} onChange={e => assign(d, e.target.value)}>
      {(owner || !d.user_id) && <option value="">Unassigned</option>}
      {people.map(p => <option key={p.id} value={p.id}>{p.name || p.email}</option>)}
    </select>
  )

  const count = (tone: string) => devices.filter(d => health(d).tone === tone).length
  const unassigned = devices.filter(d => !d.user_id).length

  return (
    <section className="settings-view" aria-labelledby="devices-page-heading">
      <div className="page-heading">
        <div>
          <h1 id="devices-page-heading">Devices</h1>
          <p className="muted">Company laptops running the managed agent. Monitoring is always disclosed to the employee on the laptop.</p>
        </div>
        {owner && (
          <div className="actions">
            <button className="delete" onClick={revokeSecrets} disabled={busy}>Revoke enrollment secrets</button>
            <button className="primary" onClick={() => void addDevice()} disabled={busy}>Add laptop</button>
          </div>
        )}
      </div>
      {owner && <Tabs id="devices" label="Devices" items={pageTabs} value={tab} onChange={setTab} />}
      {error && <p className="error" role="alert">{error}</p>}
      {owner && tab !== 'Laptops' ? (
        <div id="devices-panel" role="tabpanel"><AgentLogs /></div>
      ) : (
        <div id="devices-panel" role={owner ? 'tabpanel' : undefined} className="stack">
          {devices.length > 0 && (
            <p className="chips">
              <span className="pill ok">{count('ok')} active</span>
              <span className="pill bad">{count('bad')} stale</span>
              <span className="pill warn">{count('warn')} need attention</span>
              {owner && <span className="pill warn">{unassigned} unassigned</span>}
            </p>
          )}
          {!loading && !devices.length && <p className="empty" role="status">No laptops enrolled yet.</p>}
          {devices.length > 0 && (
            <div className="panel table-scroll" aria-busy={loading || busy}>
              <table>
                <caption className="sr-only">Enrolled company laptops</caption>
                <thead><tr>
                  <th scope="col">Laptop</th><th scope="col">Assigned to</th><th scope="col">Enrolled as</th>
                  <th scope="col">Health</th><th scope="col">Last check-in</th><th scope="col">Agent</th>
                  <th scope="col" className="r">Unsent events</th><th scope="col"><span className="sr-only">Details</span></th>
                </tr></thead>
                <tbody>{devices.map(d => (
                  <tr key={d.id}>
                    <th scope="row">{host(d)}</th>
                    <td>{assignSelect(d)}</td>
                    <td>{d.upn}</td>
                    <td><span className={`pill ${health(d).tone}`}>{health(d).label}</span></td>
                    <td>{since(d.last_checkin_at)}</td>
                    <td>{d.agent_version || 'Not reported'}</td>
                    <td className="r num">{d.buffer_depth}</td>
                    <td className="r"><button onClick={() => onOpen(d.id)} aria-label={`Open ${host(d)}`}>Open</button></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          <p className="muted">
            A laptop silent for more than 15 minutes is shown as stale. Silence is the only signal that the agent was stopped, and the agent is never hidden.
            Assigning a laptop shows its activity under that person in Team today, from the assignment onwards.
          </p>
          {owner && (
            <section className="card download" aria-labelledby="managed-agent-heading" aria-busy={checking}>
              <div>
                <h2 id="managed-agent-heading">WorkTrack managed agent for Windows</h2>
                <p className="muted" role="status">{checking ? 'Checking managed agent release…' : release ? `Version ${release.version}, 64-bit, unsigned test build` : 'Managed agent download is not available in this deployment.'}</p>
                <p className="muted">For company-owned laptops, installed by IT.</p>
              </div>
              {release && <a className="button" href={release.url} download>Download (.zip)</a>}
              <details>
                <summary>Install steps</summary>
                <ol>
                  <li>Select Add laptop and copy the enrollment secret.</li>
                  <li>Extract the zip on the laptop and open PowerShell as administrator in that folder.</li>
                  <li>Run <code>powershell.exe -ExecutionPolicy Bypass -File install.ps1 -EnrollSecret "SECRET" -Upn "user@company.com"</code>. Windows may show a publisher warning.</li>
                  <li>The laptop appears here within a minute, assigned to the person with that email if there is one.</li>
                </ol>
                <p className="muted">After install the service checks in within a minute. Each signed-in user sees a one-time monitoring notice and a tray icon. Capture defaults to time, program names and session events. Turn on screenshots per laptop under its capture settings. Remove it with Uninstall agent or <code>uninstall.ps1</code>.</p>
                {release && <p className="muted">SHA-256 of the zip: <code>{release.sha256}</code></p>}
              </details>
            </section>
          )}
        </div>
      )}
      {secret && (
        <Modal title="Add laptop" onClose={() => setSecret('')}>
          <label>Enrollment secret
            <input readOnly value={secret} onFocus={e => e.currentTarget.select()} />
          </label>
          <p className="muted" role="status">
            Valid 7 days. It enrolls every laptop in the Intune assignment, so revoke it when the rollout is done.
            Pass it to <code>install.ps1 -EnrollSecret</code>. It is not shown again after you close this.
          </p>
        </Modal>
      )}
      {openDevice && (
        <Modal drawer title={host(openDevice)} onClose={() => onOpen('')}>
          <p><span className={`pill ${health(openDevice).tone}`}>{health(openDevice).label}</span> <span className="muted">Enrolled as {openDevice.upn}</span></p>
          <label>Assigned to
            {assignSelect(openDevice)}
            <span className="muted">This laptop's activity shows under this person in Team today and on their day.</span>
          </label>
          <dl className="facts small">
            <div><dt>Last check-in</dt><dd>{since(openDevice.last_checkin_at)}</dd></div>
            <div><dt>Last sync</dt><dd>{since(openDevice.last_sync_at)}</dd></div>
            <div><dt>Agent</dt><dd>{openDevice.agent_version || 'Not reported'} (settings v{openDevice.config_version})</dd></div>
            <div><dt>Unsent events</dt><dd>{openDevice.buffer_depth}</dd></div>
            <div><dt>Dropped events</dt><dd>{String(openDevice.dropped_events)}</dd></div>
          </dl>
          <div className="block-actions">
            {openDevice.paused
              ? <button disabled={busy || openDevice.uninstall} onClick={() => command(openDevice, 'resume', `Resume capture on ${host(openDevice)}?`)}>Resume</button>
              : <button disabled={busy || openDevice.uninstall} onClick={() => command(openDevice, 'pause', `Pause capture on ${host(openDevice)}?`)}>Pause</button>}
            {openDevice.enabled
              ? <button disabled={busy || openDevice.uninstall} onClick={() => command(openDevice, 'disable', `Disable monitoring on ${host(openDevice)}?`)}>Disable</button>
              : <button disabled={busy || openDevice.uninstall} onClick={() => command(openDevice, 'enable', `Enable monitoring on ${host(openDevice)}?`)}>Enable</button>}
            <button className="delete" disabled={busy || openDevice.uninstall}
              onClick={() => command(openDevice, 'uninstall', `Uninstall the agent from ${host(openDevice)}? This is irreversible from here and applied on next check-in.`)}>
              Uninstall agent
            </button>
          </div>
          {error && <p className="error" role="alert">{error}</p>}
          <DeviceActivity key={`a-${openDevice.id}`} deviceId={openDevice.id} hostname={host(openDevice)} sinceAssigned={!owner} />
          <DeviceConfigForm key={`c-${openDevice.id}`} deviceId={openDevice.id} saved={openDevice.config} onSaved={() => void onChange()} />
        </Modal>
      )}
    </section>
  )
}
