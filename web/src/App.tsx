import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { api, ApiError, post } from './api'
import type { Block, Hours, Invite, OpenSession, User, Worker } from './api'
import { activity, applicationTotals, duration, locationText, screenshotPlaceholder, utcDate, weekRange } from './utils'
import AgentLogs from './AgentLogs'

const time = (value: string) =>
  new Date(value).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  })
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'Unable to connect. Please try again.'

function Screenshot({ url, alt }: { url: string; alt: string }) {
  const [failed, setFailed] = useState(false)
  return failed ? (
    <span>Screenshot expired or unavailable. Refresh to retry.</span>
  ) : (
    <img src={url} alt={alt} loading="lazy" onError={() => setFailed(true)} />
  )
}

function Auth({ onLogin }: { onLogin: (user: User) => void }) {
  const token =
    new URLSearchParams(location.search).get('token') ||
    new URLSearchParams(location.search).get('invite')
  const [joining, setJoining] = useState(Boolean(token))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    const email = String(fields.get('email'))
    const password = String(fields.get('password'))
    setBusy(true)
    setError('')
    try {
      if (joining) {
        await post('/auth/accept-invite', {
          token,
          name: fields.get('name'),
          password,
        })
        history.replaceState(null, '', location.pathname)
        setJoining(false)
      }
      const result = await post<{ user: User }>('/auth/login', {
        email,
        password,
      })
      onLogin(result.user)
    } catch (error) {
      setError(message(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="auth-layout">
      <section className="auth-story">
        <a className="brand" href="/">
          ◷ WorkTrack
        </a>
        <div>
          <h1>
            A clear view of
            <br />
            the working day.
          </h1>
          <p>
            Time, activity, and screenshots.
            <br />
            One shared record for your team.
          </p>
        </div>
        <p className="privacy">
          Tracking belongs on the clock. Not in the background.
        </p>
      </section>
      <section className="auth-form">
        <form onSubmit={submit}>
          <h2>{joining ? 'Join your team' : 'Welcome back'}</h2>
          <p className="muted">
            {joining
              ? 'Create your account with your invitation.'
              : 'Sign in to your WorkTrack workspace.'}
          </p>
          {joining && (
            <label>
              Your name
              <input name="name" autoComplete="name" required maxLength={120} />
            </label>
          )}
          <label>
            Email address
            <input type="email" name="email" autoComplete="username" required />
          </label>
          <label>
            Password
            <input
              type="password"
              name="password"
              autoComplete={joining ? 'new-password' : 'current-password'}
              minLength={joining ? 12 : undefined}
              required
            />
          </label>
          {joining && <p className="muted">Use at least 12 characters.</p>}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy}>
            {busy
              ? 'Please wait…'
              : joining
                ? 'Create account and sign in'
                : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  )
}

function InviteForm() {
  const [invite, setInvite] = useState<Invite | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setInvite(null)
    setCopied(false)
    try {
      setInvite(
        await post<Invite>('/invites', {
          email: new FormData(event.currentTarget).get('email'),
          role: 'worker',
        }),
      )
    } catch (error) {
      setError(message(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <details className="invite">
      <summary>Invite a worker</summary>
      <form onSubmit={submit}>
        <label>
          Worker email
          <input
            name="email"
            type="email"
            required
            placeholder="name@company.com"
          />
        </label>
        <button className="primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create invite link'}
        </button>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {invite && (
        <div className="invite-result">
          <label>
            Share this private invitation
            <input
              readOnly
              value={invite.url}
              onFocus={(e) => e.currentTarget.select()}
            />
          </label>
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(invite.url)
                setCopied(true)
              } catch {
                setError('Copy the link from the field above.')
              }
            }}
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
          <p className="muted">
            Expires {new Date(invite.expires_at).toLocaleString()}. Send this
            link directly to the worker.
          </p>
        </div>
      )}
    </details>
  )
}

function Dashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const manager = user.role !== 'worker'
  const [team, setTeam] = useState<Worker[]>([])
  const [selected, setSelected] = useState(user.id)
  const [date, setDate] = useState(utcDate())
  const [blocks, setBlocks] = useState<Block[]>([])
  const [hours, setHours] = useState<Hours[]>([])
  const [openSession, setOpenSession] = useState<OpenSession | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)
  const [updated, setUpdated] = useState<Date | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [expanded, setExpanded] = useState<Block | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const generation = useRef(0)
  const range = weekRange(date)
  const applications = applicationTotals(blocks)
  const load = useCallback(async () => {
    const current = ++generation.current
    try {
      const [members, timeline, report, session] = await Promise.all([
        manager ? api<Worker[]>('/team') : Promise.resolve([]),
        api<Block[]>(
          `/timeline?${new URLSearchParams({ user: selected, date })}`,
        ),
        api<Hours[]>(`/reports/hours?${new URLSearchParams(weekRange(date))}`),
        api<OpenSession | null>('/sessions/current'),
      ])
      if (generation.current !== current) return
      setTeam(members || [])
      setBlocks(timeline || [])
      setHours(report || [])
      setOpenSession(session)
      setError('')
      setUpdated(new Date())
    } catch (error) {
      if (generation.current !== current) return
      if (error instanceof ApiError && error.status === 401) onLogout()
      else setError(message(error))
    } finally {
      if (generation.current === current) setBusy(false)
    }
  }, [manager, selected, date, onLogout])
  useEffect(() => {
    setBusy(true)
    setBlocks([])
    setHours([])
    void load()
    const timer = window.setInterval(() => {
      if (!document.hidden) void load()
    }, 30000)
    return () => {
      clearInterval(timer)
      generation.current++
    }
  }, [load])
  useEffect(() => {
    if (expanded) dialog.current?.showModal()
  }, [expanded])
  const selectedName =
    selected === user.id
      ? 'Your timeline'
      : `${team.find((person) => person.id === selected)?.name || 'Worker'}’s timeline`
  const daySeconds = hours
    .filter((row) => row.date.slice(0, 10) === date)
    .reduce((sum, row) => sum + row.seconds, 0)
  const weekSeconds = hours.reduce((sum, row) => sum + row.seconds, 0)
  const ownBlocks = blocks.reduce(
    (sum, block) => sum + block.duration_seconds,
    0,
  )
  async function logout() {
    setActionBusy(true)
    try {
      await post('/auth/logout', {})
      onLogout()
    } catch (error) {
      setError(message(error))
    } finally {
      setActionBusy(false)
    }
  }
  async function recoverSession() {
    if (
      !openSession ||
      !confirm(
        'Recover your unfinished session? Stop and sync the original computer first if it is available. Recovery closes the session at its last uploaded block. Unsynced records beyond that point may be rejected. Continue only if the original computer or its app data was lost.',
      )
    ) return
    setActionBusy(true)
    try {
      await post('/sessions/recover', { id: openSession.id })
      await load()
    } catch (error) {
      setError(message(error))
    } finally {
      setActionBusy(false)
    }
  }
  async function remove(block: Block, screenshotOnly = false) {
    if (
      !confirm(
        screenshotOnly
          ? 'Delete this screenshot permanently? Your tracked time will be kept.'
          : 'Delete this time block and its screenshot? This permanently deducts the block from your tracked hours.',
      )
    )
      return
    setActionBusy(true)
    try {
      await api(
        `/blocks/${encodeURIComponent(block.id)}${screenshotOnly ? '/screenshot' : ''}`,
        { method: 'DELETE' },
      )
      setExpanded(null)
      dialog.current?.close()
      await load()
    } catch (error) {
      setError(message(error))
    } finally {
      setActionBusy(false)
    }
  }
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="/">
          ◷ WorkTrack
        </a>
        <div className="account">
          <span>
            {user.name}
            <small>{user.role}</small>
          </span>
          <button onClick={logout} disabled={actionBusy}>
            Sign out
          </button>
        </div>
      </header>
      <main className="workspace">
        <div className="page-heading">
          <div>
            <h1>{manager ? 'Team overview' : 'Your working day'}</h1>
            <p className="muted">
              A transparent record of time and activity. All dates and times in
              UTC.
            </p>
          </div>
          <div className="sync">
            <span className={error ? 'status-dot' : 'live-dot'} />
            {updated
              ? `Updated ${updated.toLocaleTimeString()}`
              : 'Connecting…'}
            <button
              onClick={() => {
                setBusy(true)
                void load()
              }}
              disabled={busy}
            >
              Refresh
            </button>
          </div>
        </div>
        {error && (
          <div className="error" role="alert">
            {error} Existing data may be out of date.
          </div>
        )}
        {openSession && (
          <section className="download-card" aria-labelledby="recovery-heading">
            <div>
              <h2 id="recovery-heading">Tracking session recovery</h2>
              <p>
                Your open session started{' '}
                {new Date(openSession.started_at).toLocaleString()}. Stop and sync
                the original computer if possible. Only recover here if that
                computer or its app data was lost.
              </p>
              <p>
                {openSession.recoverable
                  ? 'No heartbeat received for at least two minutes. Recovery is available.'
                  : 'Stop tracking on all computers and wait two minutes before recovering.'}
              </p>
            </div>
            <button
              disabled={actionBusy || busy || !openSession.recoverable}
              onClick={() => void recoverSession()}
            >
              Recover my session
            </button>
          </section>
        )}
        <section className="download-card" aria-labelledby="download-heading">
          <div>
            <h2 id="download-heading">Get WorkTrack for Windows</h2>
            <p className="muted">Windows 64-bit · v0.1.5</p>
            <ol>
              <li>If upgrading, stop tracking and wait until queued records have synced. Do not uninstall or remove app data.</li>
              <li>Download and install WorkTrack.</li>
              <li>Sign in with your existing account.</li>
              <li>Select Start tracking.</li>
            </ol>
            <p className="muted">
              This installer is updater-enabled and supports signed updates.
              Future production updates require publishing the update feed and
              install only when you choose Update now.
            </p>
            <p className="muted">
              Windows may show a publisher warning during installation. This is
              separate from signed update verification.
            </p>
            <p className="muted">
              <a href="/downloads/0.1.5/SHA256SUMS">View SHA-256 checksums</a>
            </p>
          </div>
          <a
            className="button primary"
            href="/downloads/0.1.5/WorkTrack_0.1.5_x64-setup.exe"
            download
          >
            Download for Windows 64-bit (v0.1.5)
          </a>
        </section>
        <section className="overview" aria-label="Work summary">
          <div>
            <span>
              {manager ? 'Team hours on selected day' : 'Hours on selected day'}
            </span>
            <strong>{busy ? '…' : duration(daySeconds)}</strong>
            <small>{date}</small>
          </div>
          <div>
            <span>{manager ? 'Team hours this week' : 'Hours this week'}</span>
            <strong>{busy ? '…' : duration(weekSeconds)}</strong>
            <small>
              {range.from} to {range.to}
            </small>
          </div>
          {manager && (
            <div>
              <span>Working now</span>
              <strong>
                {team.filter((person) => person.working).length}
                <em> / {team.length}</em>
              </strong>
              <small>Status refreshes every 30 seconds</small>
            </div>
          )}
        </section>
        <div className={manager ? 'dashboard-grid' : ''}>
          {manager && (
            <aside className="team-panel">
              <div className="section-heading">
                <h2>People</h2>
                <span className="count">{team.length}</span>
              </div>
              <div className="people">
                {team.map((person) => (
                  <button
                    key={person.id}
                    className={`person ${selected === person.id ? 'selected' : ''}`}
                    onClick={() => setSelected(person.id)}
                    aria-pressed={selected === person.id}
                  >
                    <span className="avatar">
                      {(person.name || person.email).slice(0, 2).toUpperCase()}
                    </span>
                    <span>
                      <b>{person.name || person.email}</b>
                      <small>
                        <i
                          className={
                            person.working ? 'status-dot active' : 'status-dot'
                          }
                        />
                        {person.working ? 'Working now' : 'Not tracking'}
                      </small>
                      {person.last_seen_at && (
                        <small>
                          Seen {new Date(person.last_seen_at).toLocaleString()}
                        </small>
                      )}
                    </span>
                  </button>
                ))}
                {!busy && !team.length && (
                  <p className="empty">
                    No workers yet. Create an invite below to add your team.
                  </p>
                )}
              </div>
              <InviteForm />
            </aside>
          )}
          <section className="timeline-panel" aria-busy={busy}>
            <div className="section-heading timeline-heading">
              <div>
                <h2>{selectedName}</h2>
                <p className="muted">
                  {busy
                    ? 'Loading…'
                    : `${blocks.length} ${blocks.length === 1 ? 'block' : 'blocks'} · ${duration(ownBlocks)} tracked`}
                </p>
              </div>
              <label className="date-label">
                Date (UTC)
                <input
                  type="date"
                  value={date}
                  required
                  onChange={(e) => {
                    if (e.target.value) setDate(e.target.value)
                  }}
                />
              </label>
            </div>
            <p className="muted">Time uploads about every 30 seconds. Screenshots are taken every 10 running minutes, so most time blocks have no scheduled screenshot.</p>
            {!busy && !blocks.length ? (
              <div className="empty timeline-empty">
                <span className="empty-icon">◷</span>
                <h3>No time recorded</h3>
                <p>
                  There are no uploaded work blocks for this date.
                  <br />
                  Choose another day or wait for the desktop app to sync.
                </p>
              </div>
            ) : (
              <div className="gallery">
                {blocks.map((block) => (
                  <article className="block" key={block.id}>
                    <button
                      className="screenshot"
                      onClick={() => setExpanded(block)}
                      aria-label={`View work block at ${time(block.start_at)} UTC`}
                    >
                      {block.screenshot_url ? (
                        <Screenshot
                          key={block.screenshot_url}
                          url={block.screenshot_url}
                          alt={`Work screenshot at ${time(block.start_at)} UTC`}
                        />
                      ) : (
                        <span>{screenshotPlaceholder(block)}</span>
                      )}
                    </button>
                    <div className="block-info">
                      <b>
                        {time(block.start_at)} - {time(block.end_at)}
                      </b>
                      <span>{duration(block.duration_seconds)}</span>
                    </div>
                    <div className="activity">
                      <meter
                        min={0}
                        max={100}
                        value={activity(
                          block.active_seconds,
                          block.duration_seconds,
                        )}
                        aria-label="Activity percentage"
                      />
                      <span>
                        {activity(block.active_seconds, block.duration_seconds)}
                        % activity
                      </span>
                    </div>
                    {block.location && <p className="muted">{locationText(block.location)}</p>}
                    {selected === user.id && (
                      <div className="block-actions">
                        {block.screenshot_url && (
                          <button
                            className="delete"
                            onClick={() => void remove(block, true)}
                            disabled={actionBusy}
                          >
                            Delete screenshot
                          </button>
                        )}
                        <button
                          className="delete"
                          onClick={() => void remove(block)}
                          disabled={actionBusy}
                        >
                          Delete time block
                        </button>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
        <section className="reports" aria-labelledby="applications-heading">
          <h2 id="applications-heading">Applications on selected day</h2>
          <p className="muted">Selected worker, {date} UTC. Estimated foreground time from work blocks starting on this date, including idle time. Not proof of productivity.</p>
          {applications.length ? <div className="table-scroll"><table>
            <caption className="sr-only">Foreground application usage in minutes</caption>
            <thead><tr><th scope="col">Application</th><th scope="col">Minutes</th></tr></thead>
            <tbody>{applications.map(app => <tr key={app.app}><th scope="row">{app.app}</th><td>{(app.milliseconds / 60000).toFixed(2)}</td></tr>)}</tbody>
          </table></div> : <p className="muted">No application usage recorded. Install the latest desktop app and start tracking to collect it.</p>}
        </section>
        <section className="reports">
          <div className="section-heading">
            <div>
              <h2>Weekly timesheet</h2>
              <p className="muted">
                {range.from} to {range.to} · recorded time only
              </p>
            </div>
            <a
              className="button"
              href={`/api/reports/hours.csv?${new URLSearchParams(range)}`}
              download
            >
              Export CSV
            </a>
          </div>
          <div className="table-scroll">
            <table>
              <caption className="sr-only">
                Daily and weekly tracked hours per worker
              </caption>
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  {Array.from({ length: 7 }, (_, index) => {
                    const day = new Date(`${range.from}T00:00:00Z`)
                    day.setUTCDate(day.getUTCDate() + index)
                    return (
                      <th scope="col" key={index}>
                        {day.toLocaleDateString(undefined, {
                          weekday: 'short',
                          day: 'numeric',
                          timeZone: 'UTC',
                        })}
                      </th>
                    )
                  })}
                  <th scope="col">Total</th>
                </tr>
              </thead>
              <tbody>
                {(manager ? team : [user]).map((person) => (
                  <tr key={person.id}>
                    <th scope="row">{person.name || person.email}</th>
                    {Array.from({ length: 7 }, (_, index) => {
                      const day = new Date(`${range.from}T00:00:00Z`)
                      day.setUTCDate(day.getUTCDate() + index)
                      const seconds = hours
                        .filter(
                          (row) =>
                            row.user_id === person.id &&
                            row.date.slice(0, 10) === utcDate(day),
                        )
                        .reduce((sum, row) => sum + row.seconds, 0)
                      return (
                        <td key={index}>{busy ? '…' : duration(seconds)}</td>
                      )
                    })}
                    <td>
                      <b>
                        {busy
                          ? '…'
                          : duration(
                              hours
                                .filter((row) => row.user_id === person.id)
                                .reduce((sum, row) => sum + row.seconds, 0),
                            )}
                      </b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!busy && !hours.length && (
            <p className="empty">No recorded hours this week.</p>
          )}
        </section>
        {user.role === 'owner' && <AgentLogs />}
        <footer>
          WorkTrack · Screenshots and activity are recorded only while the
          desktop timer is running.
        </footer>
      </main>
      <dialog
        ref={dialog}
        onClose={() => setExpanded(null)}
        onClick={(event) => {
          if (event.target === dialog.current) dialog.current?.close()
        }}
      >
        <div className="dialog-heading">
          <h2>Work block {expanded && time(expanded.start_at)} UTC</h2>
          <button onClick={() => dialog.current?.close()} autoFocus>
            Close
          </button>
        </div>
        {expanded?.screenshot_url ? (
          <img
            className="full-screenshot"
            src={expanded.screenshot_url}
            alt="Full work screenshot"
          />
        ) : (
          <p className="empty">{expanded ? screenshotPlaceholder(expanded) : 'No time block selected.'}</p>
        )}
        {expanded?.location && <p>{locationText(expanded.location)}</p>}
        {expanded && (
          <p>
            {duration(expanded.duration_seconds)} tracked ·{' '}
            {activity(expanded.active_seconds, expanded.duration_seconds)}%
            activity
          </p>
        )}
      </dialog>
    </div>
  )
}

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const logout = useCallback(() => setUser(null), [])
  const restore = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setUser(await api<User>('/auth/me'))
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401))
        setError(message(error))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void restore()
  }, [restore])
  if (loading)
    return (
      <main className="loading" role="status">
        Opening WorkTrack…
      </main>
    )
  if (error)
    return (
      <main className="loading">
        <h1>Unable to connect</h1>
        <p role="alert">{error}</p>
        <button onClick={() => void restore()}>Try again</button>
      </main>
    )
  return user ? (
    <Dashboard user={user} onLogout={logout} />
  ) : (
    <Auth onLogin={setUser} />
  )
}
