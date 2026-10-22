import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { api, ApiError, post } from './api'
import type { Block, DaySpan, Hours, Invite, OpenSession, User, Worker } from './api'
import { activity, applicationTotals, duration, localDate, locationText, minuteOfDay, ribbon, screenshotPlaceholder, utcDate, weekRange, zone } from './utils'
import AgentLogs from './AgentLogs'
import DownloadCard from './DownloadCard'
import { canManage, MemberAdmin, PasswordForm, ResetPassword } from './Admin'

const time = (value: string) =>
  new Date(value).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: zone,
  })
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'Unable to connect. Please try again.'

const initials = (person: Pick<User, 'name' | 'email'>) =>
  (person.name || person.email).split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()
const minuteNow = () => minuteOfDay(new Date())

function Logo() {
  return <i className="logo" aria-hidden="true" />
}

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
  const [joining, setJoining] = useState(Boolean(token) && location.pathname !== '/reset')
  const [resetting, setResetting] = useState(Boolean(token) && location.pathname === '/reset')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
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
          <Logo /> WorkTrack
        </a>
        <div className="auth-copy">
          <h1>Time on the clock, and nothing off it.</h1>
          <p>
            Workers press Start. Time, activity, a screenshot every ten
            minutes and its location are recorded until they press Stop.
          </p>
        </div>
        <div className="sample-card" aria-hidden="true">
          {[['Mon', [[8, 30], [44, 38]]], ['Tue', [[12, 72]]], ['Wed', [[6, 28], [40, 20]]]].map(([day, segments]) => (
            <div className="sample-line" key={day as string}>
              <span>{day as string}</span>
              <div className="track">
                {(segments as number[][]).map(([left, width]) => <i className="seg" key={left} style={{ left: `${left}%`, width: `${width}%` }} />)}
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="auth-form">
        {resetting && token ? (
          <ResetPassword
            token={token}
            onDone={() => {
              setResetting(false)
              setNotice('Password updated. Sign in with your new password.')
            }}
          />
        ) : (
        <form onSubmit={submit}>
          <h2>{joining ? 'Join your team' : 'Sign in'}</h2>
          {notice && <p role="status" className="muted">{notice}</p>}
          <p className="muted">
            {joining
              ? 'Create your account with your invitation.'
              : 'Use the email your invitation was sent to.'}
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
          {!joining && <p className="muted">Forgot your password? Ask your manager for a reset link.</p>}
        </form>
        )}
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
  const [date, setDate] = useState(localDate())
  const [blocks, setBlocks] = useState<Block[]>([])
  const [hours, setHours] = useState<Hours[]>([])
  const [spans, setSpans] = useState<DaySpan[]>([])
  const [workingFirst, setWorkingFirst] = useState(true)
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
      const [members, timeline, report, session, day] = await Promise.all([
        manager ? api<Worker[]>('/team') : Promise.resolve([]),
        api<Block[]>(
          `/timeline?${new URLSearchParams({ user: selected, date, tz: zone })}`,
        ),
        api<Hours[]>(`/reports/hours?${new URLSearchParams({ ...weekRange(date), tz: zone })}`),
        api<OpenSession | null>('/sessions/current'),
        manager ? api<DaySpan[]>(`/reports/day?${new URLSearchParams({ date, tz: zone })}`) : Promise.resolve([]),
      ])
      if (generation.current !== current) return
      setTeam(members || [])
      setBlocks(timeline || [])
      setHours(report || [])
      setSpans(day || [])
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
  const selectedPerson = team.find((person) => person.id === selected)
  const selectedLabel = selected === user.id ? (manager ? `${user.name || 'You'}` : 'Your day') : selectedPerson?.name || selectedPerson?.email || 'Worker'
  const blockActive = blocks.reduce((sum, block) => sum + block.active_seconds, 0)
  const dayLabel = new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
  const shiftDate = (days: number) => {
    const day = new Date(`${date}T12:00:00Z`)
    day.setUTCDate(day.getUTCDate() + days)
    setDate(utcDate(day))
  }
  const isToday = date === localDate()
  const nowPercent = isToday ? (minuteNow() / 1440) * 100 : null
  const people = manager
    ? [...team].sort((a, b) => (workingFirst ? Number(b.working) - Number(a.working) : 0) || (a.name || a.email).localeCompare(b.name || b.email))
    : [user as Worker]
  const personSeconds = (id: string) => hours.filter((row) => row.user_id === id && row.date.slice(0, 10) === date).reduce((sum, row) => sum + row.seconds, 0)
  const statusLine = (person: Worker) => {
    if (person.disabled) return 'Account disabled'
    if (person.working) return 'Working now'
    return personSeconds(person.id) > 0 ? 'Not tracking now' : 'No time this day'
  }
  const hourGroups = blocks.reduce<{ hour: string; items: Block[] }[]>((groups, block) => {
    const hour = `${time(block.start_at).slice(0, 2)}:00`
    const group = groups[groups.length - 1]
    if (group?.hour === hour) group.items.push(block)
    else groups.push({ hour, items: [block] })
    return groups
  }, [])
  const appMax = applications[0]?.milliseconds || 1
  const weekDays = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(`${range.from}T00:00:00Z`)
    day.setUTCDate(day.getUTCDate() + index)
    return utcDate(day)
  })
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="/">
          <Logo /> WorkTrack
        </a>
        <div className="account">
          <span>
            {user.name}
            <small>{user.role}</small>
          </span>
          <span className="avatar" aria-hidden="true">{initials(user)}</span>
          <button onClick={logout} disabled={actionBusy}>
            Sign out
          </button>
        </div>
      </header>
      <main className="workspace">
        <div className="page-heading">
          <div>
            <h1>{manager ? (isToday ? 'Team today' : 'Team on this day') : isToday ? 'Your day' : 'Your day on this date'}</h1>
            <p className="muted">{dayLabel}, times in {zone}</p>
          </div>
          <div className="datenav">
            <span className="sync">
              <span className={error ? 'status-dot' : 'live-dot'} />
              {updated ? `Updated ${updated.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : 'Connecting…'}
            </span>
            <button onClick={() => { setBusy(true); void load() }} disabled={busy}>Refresh</button>
            <button aria-label="Previous day" onClick={() => shiftDate(-1)}>‹</button>
            <label className="date-label">
              <span className="sr-only">Date ({zone})</span>
              <input type="date" value={date} required onChange={(e) => { if (e.target.value) setDate(e.target.value) }} />
            </label>
            <button aria-label="Next day" onClick={() => shiftDate(1)} disabled={isToday}>›</button>
          </div>
        </div>
        {error && (
          <div className="error" role="alert">
            {error} Existing data may be out of date.
          </div>
        )}
        {openSession && (
          <section className="card notice-card" aria-labelledby="recovery-heading">
            <div>
              <h2 id="recovery-heading">Tracking session recovery</h2>
              <p>
                Your open session started{' '}
                {new Date(openSession.started_at).toLocaleString()}. Stop and sync
                the original computer if possible. Only recover here if that
                computer or its app data was lost.
              </p>
              <p className="muted">
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
        <section className="totals" aria-label="Work summary">
          <div>
            <strong>{busy ? '…' : duration(daySeconds)}</strong>
            <span>{manager ? 'Team hours this day' : 'Hours this day'}</span>
          </div>
          <div>
            <strong>{busy ? '…' : duration(weekSeconds)}</strong>
            <span>{manager ? 'Team hours this week' : 'Hours this week'}</span>
          </div>
          {manager && (
            <div>
              <strong>
                {team.filter((person) => person.working).length}
                <em> of {team.length}</em>
              </strong>
              <span>Working now</span>
            </div>
          )}
        </section>
        {manager && (
          <section className="card" aria-labelledby="ribbon-heading">
            <div className="card-h">
              <h2 id="ribbon-heading">Who worked when</h2>
              <p className="muted">Violet is tracked time, green is running now. Ticks mark screenshots.</p>
              <label className="inline-check">
                <input type="checkbox" checked={workingFirst} onChange={(e) => setWorkingFirst(e.target.checked)} />
                Working now first
              </label>
            </div>
            <div className="ribbons" role="list">
              <div className="hours" aria-hidden="true">
                <span />
                <div className="scale">{['00', '03', '06', '09', '12', '15', '18', '21', '24'].map((h) => <span key={h}>{h}</span>)}</div>
                <span>Total</span>
              </div>
              {people.map((person) => {
                const own = spans.filter((span) => span.user_id === person.id)
                const segments = ribbon(own, date)
                return (
                  <button
                    key={person.id}
                    role="listitem"
                    className={`rrow ${selected === person.id ? 'sel' : ''}`}
                    aria-pressed={selected === person.id}
                    aria-label={`${person.name || person.email}, ${statusLine(person)}, ${duration(personSeconds(person.id))} tracked. Show their day.`}
                    onClick={() => setSelected(person.id)}
                  >
                    <span className="who">
                      <span className={`avatar ${person.working ? 'on' : ''}`} aria-hidden="true">{initials(person)}</span>
                      <span>
                        <b>{person.name || person.email}</b>
                        <small>{statusLine(person)}</small>
                      </span>
                    </span>
                    <span className="track" aria-hidden="true">
                      {segments.map((segment, index) => {
                        const live = person.working && isToday && index === segments.length - 1 && nowPercent !== null && segment.left + segment.width >= nowPercent - 1
                        return <i key={index} className={`seg ${live ? 'now' : ''}`} style={{ left: `${segment.left}%`, width: `${segment.width}%` }} />
                      })}
                      {ribbon(own.filter((span) => span.screenshot).map((span) => ({ start_at: span.end_at, end_at: span.end_at })), date).map((tick, index) => (
                        <i key={`s${index}`} className="shot" style={{ left: `${tick.left}%` }} />
                      ))}
                      {nowPercent !== null && <i className="nowline" style={{ left: `${nowPercent}%` }} />}
                    </span>
                    <span className={`tot ${personSeconds(person.id) ? '' : 'zero'}`}>{busy ? '…' : duration(personSeconds(person.id))}</span>
                  </button>
                )
              })}
              {!busy && !team.length && <p className="empty">No workers yet. Create an invite below to add your team.</p>}
            </div>
          </section>
        )}
        <div className="split">
          <section className="card" aria-busy={busy} aria-labelledby="day-heading">
            <div className="card-h">
              <h2 id="day-heading">{manager ? `${selectedLabel}, ${date}` : 'Screenshots and time'}</h2>
              <p className="muted">
                {busy ? 'Loading…' : `${duration(ownBlocks)} tracked, ${activity(blockActive, ownBlocks)}% input activity`}
              </p>
            </div>
            <p className="muted pad">Time uploads about every 30 seconds. Screenshots are taken every 10 running minutes, so most time blocks have no scheduled screenshot.</p>
            {!busy && !blocks.length ? (
              <div className="empty timeline-empty">
                <h3>No time recorded</h3>
                <p>There are no uploaded work blocks for this date. Choose another day or wait for the desktop app to sync.</p>
              </div>
            ) : (
              hourGroups.map((group) => (
                <div className="hourgrp" key={group.hour}>
                  <h3>{group.hour}</h3>
                  <div className="shots">
                    {group.items.map((block) => {
                      const pct = activity(block.active_seconds, block.duration_seconds)
                      return (
                        <article className="tile" key={block.id}>
                          <button
                            className={`screenshot ${block.screenshot_url ? '' : 'none'}`}
                            onClick={() => setExpanded(block)}
                            aria-label={`View work block at ${time(block.start_at)}`}
                          >
                            {block.screenshot_url ? (
                              <Screenshot key={block.screenshot_url} url={block.screenshot_url} alt={`Work screenshot at ${time(block.start_at)}`} />
                            ) : (
                              <span>{screenshotPlaceholder(block)}</span>
                            )}
                          </button>
                          <div className="meta">
                            <b>{time(block.start_at)}</b>
                            <span className="act">
                              <span className="bar" aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>
                              <span>{pct}%<span className="sr-only"> input activity</span></span>
                            </span>
                          </div>
                          <p className="sub">{duration(block.duration_seconds)} to {time(block.end_at)}</p>
                          {block.location && <p className="sub">{locationText(block.location)}</p>}
                          {selected === user.id && (
                            <div className="block-actions">
                              {block.screenshot_url && (
                                <button className="delete" onClick={() => void remove(block, true)} disabled={actionBusy}>
                                  Delete screenshot
                                </button>
                              )}
                              <button className="delete" onClick={() => void remove(block)} disabled={actionBusy}>
                                Delete time block
                              </button>
                            </div>
                          )}
                        </article>
                      )
                    })}
                  </div>
                </div>
              ))
            )}
          </section>
          <div className="side">
            <section className="card" aria-labelledby="applications-heading">
              <div className="card-h">
                <h2 id="applications-heading">Applications</h2>
                <p className="muted">Estimated foreground time</p>
              </div>
              {applications.length ? (
                <ul className="apps">
                  {applications.map((app) => (
                    <li className="app-row" key={app.app}>
                      <span>{app.app}</span>
                      <span>{(app.milliseconds / 60000).toFixed(2)} min</span>
                      <span className="fill" aria-hidden="true"><i style={{ width: `${(app.milliseconds / appMax) * 100}%` }} /></span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted pad">No application usage recorded. Install the latest desktop app and start tracking to collect it.</p>
              )}
              <p className="muted pad">Selected person, {date} ({zone}). Includes idle time. Input activity is not proof of productivity.</p>
            </section>
            <DownloadCard />
            {manager && (
              <section className="card manage">
                <InviteForm />
                {selectedPerson && canManage(user, selectedPerson) && (
                  <MemberAdmin key={selectedPerson.id} person={selectedPerson} onChange={() => void load()} />
                )}
              </section>
            )}
          </div>
        </div>
        <section className="card" aria-labelledby="week-heading">
          <div className="card-h">
            <h2 id="week-heading">This week</h2>
            <p className="muted">{range.from} to {range.to}, recorded time only</p>
            <a className="button" href={`/api/reports/hours.csv?${new URLSearchParams({ ...range, tz: zone })}`} download>Export CSV</a>
          </div>
          <div className="table-scroll">
            <table>
              <caption className="sr-only">Daily and weekly tracked hours per worker</caption>
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  {weekDays.map((day) => (
                    <th scope="col" key={day} className={day === date ? 'cell-sel' : ''}>
                      {new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', timeZone: 'UTC' })}
                    </th>
                  ))}
                  <th scope="col">Total</th>
                </tr>
              </thead>
              <tbody>
                {(manager ? team : [user]).map((person) => (
                  <tr key={person.id}>
                    <th scope="row">{person.name || person.email}</th>
                    {weekDays.map((day) => {
                      const seconds = hours.filter((row) => row.user_id === person.id && row.date.slice(0, 10) === day).reduce((sum, row) => sum + row.seconds, 0)
                      return <td key={day} className={`${day === date ? 'cell-sel' : ''} ${seconds ? '' : 'zero'}`}>{busy ? '…' : duration(seconds)}</td>
                    })}
                    <td className="total">{busy ? '…' : duration(hours.filter((row) => row.user_id === person.id).reduce((sum, row) => sum + row.seconds, 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!busy && !hours.length && <p className="empty">No recorded hours this week.</p>}
        </section>
        {user.role === 'owner' && <AgentLogs />}
        <section className="card account-card">
          <PasswordForm />
        </section>
        <footer>
          Screenshots, activity and location are recorded only while the
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
          <h2>Work block {expanded && time(expanded.start_at)}</h2>
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
            {duration(expanded.duration_seconds)} tracked,{' '}
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
