import { useEffect, useState } from 'react'
import { api, ApiError } from './api'
import type { Org, Worker } from './api'

const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Unable to connect. Please try again.'

/** Owner page: put each person in an organisation. Managers see only their org. */
export default function Organisations({ orgs, onChange }: { orgs: Org[]; onChange: () => void }) {
  const [people, setPeople] = useState<Worker[]>([])
  const [error, setError] = useState('')
  const [saving, setSaving] = useState('')
  const [filter, setFilter] = useState<'all' | 'unassigned'>('all')

  async function load() {
    try {
      setPeople(await api<Worker[]>('/team'))
      setError('')
    } catch (e) {
      setError(message(e))
    }
  }
  useEffect(() => { void load() }, [])

  async function assign(person: Worker, org: string) {
    setSaving(person.id)
    setError('')
    try {
      await api(`/users/${encodeURIComponent(person.id)}/org`, { method: 'PUT', body: JSON.stringify({ org_id: org || null }) })
      setPeople(list => list.map(p => (p.id === person.id ? { ...p, org_id: org || null } : p)))
      onChange()
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? 'That person or organisation no longer exists.' : message(e))
    } finally {
      setSaving('')
    }
  }

  const shown = people
    .filter(p => p.role !== 'owner' && (filter === 'all' || !p.org_id))
    .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email))
  const count = (org: string | null) => people.filter(p => p.role !== 'owner' && (p.org_id ?? null) === org).length

  return (
    <section className="settings-view" aria-labelledby="orgs-heading">
      <div className="page-heading">
        <div>
          <h1 id="orgs-heading">Organisations</h1>
          <p className="muted">
            Managers see only the people and devices in their own organisation. Unassigned people are visible to owners only.
          </p>
        </div>
      </div>
      <p className="muted">
        {orgs.map(o => `${o.name}: ${count(o.id)}`).join(' · ')} · Unassigned: {count(null)}
      </p>
      <label className="member-chooser">Show
        <select value={filter} onChange={e => setFilter(e.target.value as 'all' | 'unassigned')}>
          <option value="all">Everyone</option>
          <option value="unassigned">Unassigned only</option>
        </select>
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="table-scroll">
        <table className="text-table">
          <caption className="sr-only">Organisation for each person</caption>
          <thead>
            <tr><th scope="col">Person</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Organisation</th></tr>
          </thead>
          <tbody>
            {shown.map(p => (
              <tr key={p.id}>
                <td>{p.name || '—'}{p.disabled ? ' (disabled)' : ''}</td>
                <td>{p.email}</td>
                <td>{p.role}</td>
                <td>
                  <select
                    aria-label={`Organisation for ${p.name || p.email}`}
                    value={p.org_id ?? ''}
                    disabled={saving === p.id}
                    onChange={e => void assign(p, e.target.value)}
                  >
                    <option value="">Unassigned</option>
                    {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!shown.length && <p className="empty">{filter === 'unassigned' ? 'Everyone is assigned.' : 'No people yet.'}</p>}
    </section>
  )
}
