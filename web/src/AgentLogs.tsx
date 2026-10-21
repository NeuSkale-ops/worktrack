import { useState } from 'react'
import { api } from './api'
import type { AgentLog } from './api'

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
    <section className="reports diagnostic-logs" aria-labelledby="agent-logs-heading">
      <details>
        <summary id="agent-logs-heading">Desktop diagnostic logs (owner only)</summary>
        <p className="muted">
          Newest 100 events from the last seven days. Workers must enable
          diagnostic uploads in the desktop app. Messages use fixed error codes,
          not raw error text or screenshots.
        </p>
        <button onClick={() => void load()} disabled={busy}>
          {busy ? 'Loading logs…' : 'Load recent logs'}
        </button>
        {error && <p className="error" role="alert">{error}</p>}
        {loaded && !busy && !error && !logs.length && (
          <p role="status">No diagnostic logs received in the last seven days.</p>
        )}
        {logs.length > 0 && (
          <div className="table-scroll" aria-busy={busy}>
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
                  <td>{log.level}: {log.code}</td>
                  <td>{log.message}{log.status ? ` HTTP ${log.status}.` : ''}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </details>
    </section>
  )
}
