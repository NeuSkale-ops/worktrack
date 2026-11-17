import { useState } from 'react'
import { api } from './api'
import type { AgentLog } from './api'

/** Owner-only desktop app diagnostics. Loads on request, never automatically. */
export default function AgentLogs() {
  const [logs, setLogs] = useState<AgentLog[]>([])
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  async function load() {
    setBusy(true)
    setError('')
    try {
      setLogs(await api<AgentLog[]>('/agent/logs'))
      setLoaded(true)
    } catch (error) {
      setLogs([])
      setError(error instanceof Error ? error.message : 'Unable to load diagnostic logs.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="diagnostic-logs stack" aria-label="Desktop diagnostic logs (owner only)">
      <p className="muted">
        Newest 100 events from the last seven days. Diagnostics are always
        on for signed-in desktop apps. Messages use fixed error codes, not raw
        error text or screenshots. Only owners can read them.
      </p>
      <div>
        <button onClick={() => void load()} disabled={busy}>
          {busy ? 'Loading logs…' : 'Load recent logs'}
        </button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {loaded && !busy && !error && !logs.length && (
        <p role="status">No diagnostic logs received in the last seven days.</p>
      )}
      {logs.length > 0 && (
        <div className="panel table-scroll" aria-busy={busy}>
          <table>
            <caption className="sr-only">Recent desktop diagnostic events</caption>
            <thead><tr>
              <th scope="col">Worker</th><th scope="col">Time (UTC)</th>
              <th scope="col">Version</th><th scope="col">Event</th>
              <th scope="col">Details</th>
            </tr></thead>
            <tbody>{logs.map(log => (
              <tr key={`${log.user_id}/${log.id}`}>
                <th scope="row">{log.name}</th>
                <td>{new Date(log.occurred_at).toLocaleString(undefined, { timeZone: 'UTC' })}</td>
                <td>{log.version}</td>
                <td><span className={`pill ${log.level === 'error' ? 'bad' : 'warn'}`}>{log.level}</span> {log.code}</td>
                <td>{log.message}{log.status ? ` HTTP ${log.status}.` : ''}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  )
}
