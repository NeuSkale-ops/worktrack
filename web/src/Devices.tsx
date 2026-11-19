import { useEffect, useState } from 'react'
import { api, post } from './api'
import type { Org, Worker } from './api'
import AgentLogs from './AgentLogs'
import DevicePage from './DevicePage'
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
 * Company laptops running the managed agent. An owner puts each laptop in an
 * organisation. Owners and managers assign it to the person who uses it, and
 * its activity then shows under that person.
 */
export default function Devices({ owner, devices, people, orgs, loading, open, onOpen, onChange }: {
  owner: boolean
  devices: Device[]
  /** People a laptop can be assigned to. */
  people: Worker[]
  orgs: Org[]
  loading: boolean
  /** Id of the laptop whose page is open, or '' for the list. */
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
      : `Unassign ${host(d)}? Its activity will not show under anyone.`)) return
    void run(async () => {
      await api(`/devices/${encodeURIComponent(d.id)}/user`, { method: 'PUT', body: JSON.stringify({ user_id: userId || null }) })
      await onChange()
    }, 'Unable to assign this laptop.')
  }

  const orgName = (d: Device) => orgs.find(o => o.id === d.org_id)?.name ?? 'No organisation'

  function setOrg(d: Device, orgId: string) {
    const target = orgs.find(o => o.id === orgId)
    const person = people.find(p => p.id === d.user_id)
    const leaves = Boolean(target && person && person.role !== 'owner' && person.org_id !== orgId)
    if (!confirm(target
      ? `Move ${host(d)} to ${target.name}? Its managers will see this laptop, but not its earlier activity.${leaves ? ` ${person!.name || person!.email} is not in ${target.name} and will be unassigned.` : ''}`
      : `Remove ${host(d)} from its organisation? Only owners will see this laptop.`)) return
    void run(async () => {
      await api(`/devices/${encodeURIComponent(d.id)}/org`, { method: 'PUT', body: JSON.stringify({ org_id: orgId || null }) })
      await onChange()
    }, 'Unable to change this laptop\'s organisation.')
  }

  const orgSelect = (d: Device) => (
    <select aria-label={`Organisation for ${host(d)}`} value={d.org_id ?? ''} disabled={busy} onChange={e => setOrg(d, e.target.value)}>
      <option value="">No organisation</option>
      {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
    </select>
  )

  // A laptop in an organisation goes to that organisation's people, or to an
  // owner. The current person stays listed so the selector shows the truth.
  const assignable = (d: Device) => people.filter(p => !d.org_id || p.role === 'owner' || p.org_id === d.org_id || p.id === d.user_id)

  // Managers cannot unassign.
  const assignSelect = (d: Device) => (
    <select aria-label={`Person assigned to ${host(d)}`} value={d.user_id ?? ''} disabled={busy} onChange={e => assign(d, e.target.value)}>
      {(owner || !d.user_id) && <option value="">Unassigned</option>}
      {assignable(d).map(p => <option key={p.id} value={p.id}>{p.name || p.email}</option>)}
    </select>
  )

  if (openDevice) {
    const off = busy || openDevice.uninstall
    return (
      <DevicePage key={openDevice.id} device={openDevice} owner={owner} error={error} onBack={() => onOpen('')} onSaved={() => void onChange()}
        organisation={owner ? orgSelect(openDevice) : <span>{orgName(openDevice)}</span>}
        assignee={assignSelect(openDevice)}
        actions={<>
          {openDevice.paused
            ? <button disabled={off} onClick={() => command(openDevice, 'resume', `Resume capture on ${host(openDevice)}?`)}>Resume</button>
            : <button disabled={off} onClick={() => command(openDevice, 'pause', `Pause capture on ${host(openDevice)}?`)}>Pause</button>}
          {openDevice.enabled
            ? <button disabled={off} onClick={() => command(openDevice, 'disable', `Disable monitoring on ${host(openDevice)}?`)}>Disable</button>
            : <button disabled={off} onClick={() => command(openDevice, 'enable', `Enable monitoring on ${host(openDevice)}?`)}>Enable</button>}
          <button className="delete" disabled={off}
            onClick={() => command(openDevice, 'uninstall', `Uninstall the agent from ${host(openDevice)}? This is irreversible from here and applied on next check-in.`)}>
            Uninstall agent
          </button>
        </>} />
    )
  }

  const count = (tone: string) => devices.filter(d => health(d).tone === tone).length
  const unassigned = devices.filter(d => !d.user_id).length
  const noOrg = devices.filter(d => !d.org_id).length

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
              <span className="pill off">{count('off')} offline</span>
              <span className="pill bad">{count('bad')} stale</span>
              <span className="pill warn">{count('warn')} need attention</span>
              <span className="pill warn">{unassigned} unassigned</span>
              {owner && <span className="pill warn">{noOrg} without organisation</span>}
            </p>
          )}
          {!loading && !devices.length && <p className="empty" role="status">No laptops enrolled yet.</p>}
          {devices.length > 0 && (
            <div className="panel table-scroll" aria-busy={loading || busy}>
              <table>
                <caption className="sr-only">Enrolled company laptops</caption>
                <thead><tr>
                  <th scope="col">Laptop</th>{owner && <th scope="col">Organisation</th>}<th scope="col">Assigned to</th><th scope="col">Enrolled as</th>
                  <th scope="col">Health</th><th scope="col">Last check-in</th><th scope="col">Agent</th>
                  <th scope="col" className="r">Unsent events</th><th scope="col"><span className="sr-only">Details</span></th>
                </tr></thead>
                <tbody>{devices.map(d => (
                  <tr key={d.id}>
                    <th scope="row">{host(d)}</th>
                    {owner && <td>{orgSelect(d)}</td>}
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
            A laptop silent for more than 15 minutes is shown as stale, unless the silence began at a sign-out, which is shown as offline. Unexplained silence is the only signal that the agent was stopped, and the agent is never hidden.
            Assigning a laptop shows its activity under that person in Team today, from the assignment onwards.
            {owner && ' A laptop\'s organisation decides which managers see it and who it can be assigned to. A laptop without an organisation is visible to owners only.'}
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
                  <li>The laptop appears here within a minute, with no organisation and no person. Choose its organisation, then assign it.</li>
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
    </section>
  )
}
