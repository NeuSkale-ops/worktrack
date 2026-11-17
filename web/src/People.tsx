import { useState } from 'react'
import { api, ApiError } from './api'
import type { Org, User, Worker } from './api'
import { canManage, InviteForm, MemberAdmin } from './Admin'
import Modal from './Modal'
import { initials } from './utils'

const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Unable to connect. Please try again.'
const label = (person: Worker) => person.name || person.email
const roleName = { owner: 'Owner', manager: 'Manager', worker: 'Worker' } as const

/**
 * Everyone the caller may see, with role, organisation and access in one
 * table. Owners set roles and organisations. Managers see only their own
 * organisation and manage its workers. Unassigned people are visible to
 * owners only.
 */
export default function People({ user, team, orgs, org, onOrg, loading, onChange }: {
  user: User
  /** People visible to the caller, already narrowed to `org` when one is chosen. */
  team: Worker[]
  orgs: Org[]
  org: string
  onOrg: (org: string) => void
  loading: boolean
  onChange: () => Promise<void>
}) {
  const owner = user.role === 'owner'
  const [error, setError] = useState('')
  const [saving, setSaving] = useState('')
  const [unassignedOnly, setUnassignedOnly] = useState(false)
  const [inviting, setInviting] = useState(false)
  const [managing, setManaging] = useState('')
  const managed = team.find(p => p.id === managing)

  async function save(person: Worker, path: 'org' | 'role', body: unknown, notFound: string) {
    setSaving(person.id)
    setError('')
    try {
      await api(`/users/${encodeURIComponent(person.id)}/${path}`, { method: 'PUT', body: JSON.stringify(body) })
      await onChange()
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? notFound : message(e))
    } finally {
      setSaving('')
    }
  }
  function setRole(person: Worker, role: 'worker' | 'manager') {
    if (!confirm(role === 'manager'
      ? `Make ${label(person)} a manager? They will see every person, report and device in their organisation.`
      : `Make ${label(person)} a worker? They will see only their own time.`)) return
    void save(person, 'role', { role }, 'That person no longer exists.')
  }

  const shown = team
    .filter(p => !unassignedOnly || (p.role !== 'owner' && !p.org_id))
    .sort((a, b) => label(a).localeCompare(label(b)))
  const count = (id: string | null) => team.filter(p => p.role !== 'owner' && (p.org_id ?? null) === id).length
  const orgName = (person: Worker) => person.role === 'owner' ? 'All organisations' : orgs.find(o => o.id === person.org_id)?.name ?? 'Unassigned'
  const pick = (id: string, unassigned = false) => { onOrg(id); setUnassignedOnly(unassigned) }

  return (
    <section className="settings-view" aria-labelledby="people-heading">
      <div className="page-heading">
        <div>
          <h1 id="people-heading">People</h1>
          <p className="muted">
            {owner
              ? 'Set each person\'s role and organisation, and manage their access. Managers see only the people and devices in their own organisation.'
              : 'Invite workers and manage their access.'}
          </p>
        </div>
        <div className="actions">
          <button className="primary" onClick={() => setInviting(true)}>{owner ? 'Invite a person' : 'Invite a worker'}</button>
        </div>
      </div>
      {owner && (
        <div className="chips" role="group" aria-label="Show">
          <button aria-pressed={!org && !unassignedOnly} onClick={() => pick('')}>Everyone</button>
          {orgs.map(o => <button key={o.id} aria-pressed={org === o.id} onClick={() => pick(o.id)}>{o.name}{org ? '' : ` ${count(o.id)}`}</button>)}
          <button aria-pressed={unassignedOnly} onClick={() => pick('', true)}>Unassigned{org ? '' : ` ${count(null)}`}</button>
          <span className="muted">Unassigned people are visible to owners only.</span>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="panel table-scroll" aria-busy={loading}>
        <table>
          <caption className="sr-only">Role, organisation and status for each person</caption>
          <thead>
            <tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col">Organisation</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Access</span></th></tr>
          </thead>
          <tbody>
            {shown.map(p => (
              <tr key={p.id}>
                <th scope="row">
                  <span className="who">
                    <span className={`avatar ${p.working ? 'on' : ''}`} aria-hidden="true">{initials(p)}</span>
                    <span><b>{p.name || 'No name yet'}</b><small>{p.email}</small></span>
                  </span>
                </th>
                <td>
                  {owner && p.role !== 'owner' ? (
                    <select aria-label={`Role for ${label(p)}`} value={p.role} disabled={saving === p.id}
                      onChange={e => setRole(p, e.target.value as 'worker' | 'manager')}>
                      <option value="worker">Worker</option>
                      <option value="manager">Manager</option>
                    </select>
                  ) : roleName[p.role]}
                </td>
                <td>
                  {owner && p.role !== 'owner' ? (
                    <select aria-label={`Organisation for ${label(p)}`} value={p.org_id ?? ''} disabled={saving === p.id}
                      onChange={e => void save(p, 'org', { org_id: e.target.value || null }, 'That person or organisation no longer exists.')}>
                      <option value="">Unassigned</option>
                      {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </select>
                  ) : orgName(p)}
                </td>
                <td><span className={`pill ${p.disabled ? 'bad' : p.working ? 'ok' : ''}`}>{p.disabled ? 'Disabled' : p.working ? 'Working now' : 'Not tracking'}</span></td>
                <td className="r">
                  {p.id === user.id ? <span className="muted">You</span>
                    : canManage(user, p) ? <button onClick={() => setManaging(p.id)} aria-label={`Manage access for ${label(p)}`}>Manage</button> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && !shown.length && <p className="empty">{unassignedOnly ? 'Everyone is assigned.' : 'No people yet. Invite someone to get started.'}</p>}
      {inviting && (
        <Modal title={owner ? 'Invite a person' : 'Invite a worker'} onClose={() => setInviting(false)}>
          <InviteForm user={user} orgs={orgs} org={org} />
        </Modal>
      )}
      {managed && (
        <Modal drawer title={label(managed)} onClose={() => setManaging('')}>
          <p className="muted">{managed.email}. {roleName[managed.role]}, {orgName(managed)}.</p>
          <MemberAdmin key={managed.id} person={managed} onChange={() => void onChange()} />
        </Modal>
      )}
    </section>
  )
}
