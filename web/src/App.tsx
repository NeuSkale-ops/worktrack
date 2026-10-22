import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { api, ApiError, post } from './api'
import type { Block, DaySpan, Hours, Invite, OpenSession, User, Worker } from './api'
import { activity, applicationTotals, blockDuration, duration, isTimeOnly, localDate, locationText, minuteOfDay, ribbon, screenshotPlaceholder, utcDate, weekRange, zone } from './utils'
import AgentLogs from './AgentLogs'
import DownloadCard from './DownloadCard'
import { canManage, MemberAdmin, PasswordForm, ResetPassword } from './Admin'

const time = (value: string) =>
  new Date(value).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: zone,
  })
const blockTime = (value: string) => new Date(value).toLocaleTimeString(undefined, {
  hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: zone,
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
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading')
  useEffect(() => {
    const timeout = window.setTimeout(() => setState(current => current === 'loading' ? 'failed' : current), 15000)
    return () => window.clearTimeout(timeout)
  }, [url])
  return (
    <span className={`image-preview ${state}`}>
      {state === 'loading' && <span role="status">Loading screenshot…</span>}
      {state === 'failed' && <span role="status">Screenshot expired or unavailable. Refresh to retry.</span>}
      <img src={url} alt={alt} onLoad={() => setState('loaded')} onError={() => setState('failed')} />
    </span>
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
  const [view, setView] = useState<'Day view' | 'Weekly report' | 'Settings'>('Day view')
  const [tab, setTab] = useState<'Screenshots' | 'Activity details' | 'Applications'>('Screenshots')
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
    setSpans([])
    setExpanded(null)
    dialog.current?.close()
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
  const selectedLabel = selected === user.id ? (user.name || user.email) : selectedPerson?.name || selectedPerson?.email || 'Worker'
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
    const hour = new Date(block.start_at).toLocaleTimeString(undefined, { hour: '2-digit', timeZone: zone })
    const group = groups[groups.length - 1]
    if (group?.hour === hour) group.items.push(block)
    else groups.push({ hour, items: [block] })
    return groups
  }, [])
  const selectedSpans = manager ? spans.filter(span => span.user_id === selected) : blocks
  const segments = ribbon(selectedSpans, date)
  const screenshots = blocks.filter(block => !isTimeOnly(block))
  const screenshotCount = screenshots.filter(block => block.screenshot_url).length
  const dateControls = (
    <div className="datenav">
      <button aria-label="Previous day" onClick={() => shiftDate(-1)}>‹</button>
      <label className="date-label">
        <span className="sr-only">Date ({zone})</span>
        <input type="date" value={date} required onChange={event => { if (event.target.value) setDate(event.target.value) }} />
      </label>
      <button aria-label="Next day" onClick={() => shiftDate(1)} disabled={isToday}>›</button>
      {!isToday && <button onClick={() => setDate(localDate())}>Today</button>}
    </div>
  )
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
        <nav className="global-nav" aria-label="Main navigation">
          {(['Day view', 'Weekly report', 'Settings'] as const).map(item => (
            <button key={item} aria-current={view === item ? 'page' : undefined} onClick={() => setView(item)}>{item}</button>
          ))}
        </nav>
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
        <div className="workspace-status">
          <span className="sync" role="status">
            <span className={error ? 'status-dot' : 'live-dot'} aria-hidden="true" />
            {busy ? 'Loading day…' : updated ? `Updated ${updated.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : 'Connecting…'}
          </span>
          <button onClick={() => { setBusy(true); void load() }} disabled={busy}>Refresh</button>
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
        {view === 'Day view' && (
          <div className={`day-layout ${manager ? '' : 'personal'}`}>
            {manager && (
              <aside className="people-rail" aria-labelledby="people-heading">
                <div className="rail-heading"><h2 id="people-heading">People</h2><span className="muted">{team.length}</span></div>
                <label className="inline-check desktop-people">
                  <input type="checkbox" checked={workingFirst} onChange={event => setWorkingFirst(event.target.checked)} />Working now first
                </label>
                <label className="mobile-person">Person
                  <select value={selected} onChange={event => setSelected(event.target.value)}>
                    {!people.some(person => person.id === user.id) && <option value={user.id}>{user.name || user.email}</option>}
                    {people.map(person => <option key={person.id} value={person.id}>{person.name || person.email} · {statusLine(person)} · {duration(personSeconds(person.id))}</option>)}
                  </select>
                </label>
                <div className="people-list desktop-people">
                  {people.map(person => (
                    <button className={`rrow ${selected === person.id ? 'sel' : ''}`} key={person.id}
                      aria-pressed={selected === person.id}
                      aria-label={`${person.name || person.email}, ${statusLine(person)}, ${duration(personSeconds(person.id))} tracked. Show their day.`}
                      onClick={() => setSelected(person.id)}>
                      <span className="who">
                        <span className={`avatar ${person.working ? 'on' : ''}`} aria-hidden="true">{initials(person)}</span>
                        <span><b>{person.name || person.email}</b><small>{statusLine(person)}</small></span>
                      </span>
                      <span className="tot">{busy ? '…' : duration(personSeconds(person.id))}</span>
                    </button>
                  ))}
                  {!busy && !team.length && <p className="empty">No team members yet. Invite a worker in Settings.</p>}
                </div>
              </aside>
            )}
            <section className="day-workspace" aria-busy={busy} aria-labelledby="day-heading">
              <div className="page-heading">
                <div><h1 id="day-heading">{selectedLabel}</h1><p className="muted">{dayLabel}</p></div>
                {dateControls}
              </div>
              <div className="day-summary">
                <p><strong>{busy ? '…' : duration(ownBlocks)}</strong> tracked <span className="summary-divider">/</span> <strong>{busy ? '…' : `${activity(blockActive, ownBlocks)}%`}</strong> input activity</p>
                <span className="muted">Times in {zone}</span>
              </div>
              <div className="day-timeline" aria-label={`${selectedLabel}'s recorded time across 24 hours`}>
                <div className="track" aria-hidden="true">
                  {segments.map((segment, index) => <i className="seg" key={index} style={{ left: `${segment.left}%`, width: `${segment.width}%` }} />)}
                  {nowPercent !== null && <i className="nowline" style={{ left: `${nowPercent}%` }} />}
                </div>
                <div className="scale" aria-hidden="true">{['00:00', '06:00', '12:00', '18:00', '24:00'].map(hour => <span key={hour}>{hour}</span>)}</div>
                <p className="muted">Blue marks recorded time.{isToday ? ' The marker shows now.' : ''}</p>
              </div>
              <div className="task-tabs" role="tablist" aria-label="Day review">
                {(['Screenshots', 'Activity details', 'Applications'] as const).map((item, index) => (
                  <button key={item} role="tab" id={`day-tab-${index}`} aria-selected={tab === item} aria-controls="day-panel"
                    tabIndex={tab === item ? 0 : -1} onClick={() => setTab(item)}
                    onKeyDown={event => {
                      const tabs = ['Screenshots', 'Activity details', 'Applications'] as const
                      const next = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : null
                      if (next !== null) {
                        event.preventDefault()
                        setTab(tabs[next])
                        document.getElementById(`day-tab-${next}`)?.focus()
                      }
                    }}>{item}</button>
                ))}
              </div>
              <div id="day-panel" className="task-panel" role="tabpanel" aria-labelledby={`day-tab-${['Screenshots', 'Activity details', 'Applications'].indexOf(tab)}`}>
                {busy ? <p className="empty" role="status">Loading {selectedLabel}'s day…</p> : (
                  <>
                    {!blocks.length && <div className="empty no-time"><h2>No time recorded</h2><p>Choose another day or wait for the desktop app to sync.</p></div>}
                    {tab === 'Screenshots' && (
                      <>
                        <div className="section-intro screenshot-intro"><p className="muted">{screenshotCount} {screenshotCount === 1 ? 'screenshot' : 'screenshots'} available. Screenshots are taken every 10 minutes while tracking.</p></div>
                        {screenshots.length ? <div className="shots">
                          {screenshots.map(block => (
                            <article className={`tile ${block.screenshot_url ? '' : 'status-tile'}`} key={block.id}>
                              {block.screenshot_url ? (
                                <button className="screenshot" onClick={() => setExpanded(block)} aria-label={`View work block at ${time(block.start_at)}`}>
                                  <Screenshot key={block.screenshot_url} url={block.screenshot_url} alt={`Work screenshot at ${time(block.start_at)}`} />
                                </button>
                              ) : <p className="screenshot-status">{screenshotPlaceholder(block)}</p>}
                              <div className="meta"><time dateTime={block.start_at}>{time(block.start_at)}</time><button onClick={() => setExpanded(block)} aria-label={`View details at ${time(block.start_at)}`}>View details</button></div>
                            </article>
                          ))}
                        </div> : <div className="empty screenshot-empty"><h3>No screenshots for this day</h3><p>{blocks.length ? 'Recorded activity is available in Activity details. Screenshots appear after 10 running minutes.' : 'Screenshots will appear here when the desktop app uploads them.'}</p></div>}
                      </>
                    )}
                    {tab === 'Activity details' && (
                      <>
                        <div className="section-intro"><h2>Recorded activity</h2><p className="muted">Exact uploaded intervals. Input activity is not proof of productivity.</p></div>
                        {hourGroups.map((group, index) => <section className="hourgrp" key={`${group.hour}-${index}`}>
                          <h3>{group.hour}</h3>
                          <ul className="activity-list">{group.items.map(block => <li className="time-row" key={block.id}>
                            <span className="time-range"><time dateTime={block.start_at}>{blockTime(block.start_at)}</time> to <time dateTime={block.end_at}>{blockTime(block.end_at)}</time></span>
                            <span className="record-duration">{blockDuration(block.duration_seconds)} <small>{block.duration_seconds} seconds</small></span>
                            <span>{activity(block.active_seconds, block.duration_seconds)}% input activity</span>
                            <button onClick={() => setExpanded(block)} aria-label={`View work block at ${blockTime(block.start_at)}`}>View details</button>
                          </li>)}</ul>
                        </section>)}
                      </>
                    )}
                    {tab === 'Applications' && (
                      <>
                        <div className="section-intro"><h2 id="applications-heading">Applications</h2><p className="muted">Estimated foreground time. Includes idle time.</p></div>
                        {applications.length ? <ul className="apps">{applications.map(app => <li className="app-row" key={app.app}>
                          <span>{app.app}</span><span>{(app.milliseconds / 60000).toFixed(2)} min</span>
                          <span className="fill" aria-hidden="true"><i style={{ width: `${(app.milliseconds / appMax) * 100}%` }} /></span>
                        </li>)}</ul> : <p className="empty">No application usage recorded. Install the latest desktop app and start tracking to collect it.</p>}
                      </>
                    )}
                  </>
                )}
              </div>
            </section>
          </div>
        )}
        {view === 'Weekly report' && (
        <section className="report-view" aria-labelledby="week-heading">
          <div className="page-heading">
            <div><h1 id="week-heading">Weekly report</h1><p className="muted">{range.from} to {range.to} · {duration(weekSeconds)} {manager ? 'team' : 'total'} tracked</p></div>
            {dateControls}
          </div>
          <div className="report-actions"><p className="muted">Times in {zone}. Totals include recorded time only.</p><a className="button" href={`/api/reports/hours.csv?${new URLSearchParams({ ...range, tz: zone })}`} download>Export CSV</a></div>
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
        )}
        {view === 'Settings' && (
          <section className="settings-view" aria-labelledby="settings-heading">
            <div className="page-heading"><div><h1 id="settings-heading">Settings</h1><p className="muted">Desktop app, team access and your account.</p></div></div>
            <DownloadCard />
            {manager && <section className="settings-section" aria-labelledby="team-settings-heading">
              <h2 id="team-settings-heading">Team members</h2>
              <label className="member-chooser">Person
                <select value={selected} onChange={event => setSelected(event.target.value)}>
                  {!people.some(person => person.id === user.id) && <option value={user.id}>{user.name || user.email}</option>}
                  {people.map(person => <option key={person.id} value={person.id}>{person.name || person.email}{person.disabled ? ' (disabled)' : ''}</option>)}
                </select>
              </label>
              {selectedPerson && canManage(user, selectedPerson) ? <MemberAdmin key={selectedPerson.id} person={selectedPerson} onChange={() => void load()} /> : <p className="muted">{selected === user.id ? 'Manage your own password below. Choose another member to manage their access.' : 'You do not have permission to manage this member.'}</p>}
              <InviteForm />
            </section>}
            <section className="settings-section"><h2>Your account</h2><PasswordForm /></section>
            {user.role === 'owner' && <AgentLogs />}
          </section>
        )}
        <footer>
          Screenshots, activity and location are recorded only while the
          desktop timer is running.
        </footer>
      </main>
      <dialog
        ref={dialog}
        aria-labelledby="block-dialog-heading"
        onClose={() => setExpanded(null)}
        onClick={(event) => {
          if (event.target === dialog.current) dialog.current?.close()
        }}
      >
        <div className="dialog-heading">
          <h2 id="block-dialog-heading">Work block {expanded && time(expanded.start_at)}</h2>
          <button onClick={() => dialog.current?.close()} autoFocus>
            Close
          </button>
        </div>
        {expanded?.screenshot_url ? (
          <div className="full-screenshot"><Screenshot key={expanded.screenshot_url} url={expanded.screenshot_url} alt="Full work screenshot" /></div>
        ) : (
          <p className="empty">{expanded ? screenshotPlaceholder(expanded) : 'No time block selected.'}</p>
        )}
        {expanded?.location && <p>{locationText(expanded.location)}</p>}
        {expanded && (
          <p>
            {blockDuration(expanded.duration_seconds)} tracked ({expanded.duration_seconds} seconds),{' '}
            {activity(expanded.active_seconds, expanded.duration_seconds)}%
            input activity. {blockTime(expanded.start_at)} to {blockTime(expanded.end_at)}.
          </p>
        )}
        {expanded && expanded.user_id === user.id && (
          <div className="block-actions">
            {expanded.screenshot_url && <button className="delete" onClick={() => void remove(expanded, true)} disabled={actionBusy}>Delete screenshot</button>}
            <button className="delete" onClick={() => void remove(expanded)} disabled={actionBusy}>Delete time block</button>
          </div>
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
