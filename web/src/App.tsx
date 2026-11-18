import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { api, ApiError, post, withOrg } from './api'
import type { Block, DaySpan, DeviceSpan, Hours, OpenSession, Org, User, Worker } from './api'
import { activity, applicationTotals, blockDuration, duration, initials, isTimeOnly, localDate, locationText, minuteOfDay, outside, ribbon, ribbonBy, screenshotPlaceholder, utcDate, weekRange, zone } from './utils'
import type { Segment } from './utils'
import { PasswordForm, ResetPassword } from './Admin'
import { health, hm } from './deviceActivity'
import type { Device } from './deviceActivity'
import Devices from './Devices'
import DownloadCard from './DownloadCard'
import Modal from './Modal'
import People from './People'
import { fullDay, Scale, Track, workday } from './Ribbon'
import Tabs from './Tabs'
import TeamBoard from './TeamBoard'

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
const roleName = { owner: 'Owner', manager: 'Manager', worker: 'Worker' } as const
const dayTabs = ['Screenshots', 'Activity details', 'Applications'] as const

// Illustration for the sign-in page: three made-up days, in minutes of the day.
const sampleDays: { day: string; runs: [number, number, number][] }[] = [
  { day: 'Mon', runs: [[540, 720, 0.8], [780, 1020, 0.7]] },
  { day: 'Tue', runs: [[510, 1000, 0.75]] },
  { day: 'Wed', runs: [[560, 700, 0.6], [760, 940, 0.85]] },
]
const sampleSegments = (runs: [number, number, number][]): Segment[] =>
  runs.map(([from, to, level]) => ({ left: (from / 1440) * 100, width: ((to - from) / 1440) * 100, activity: level }))

function Logo() {
  return <i className="logo" aria-hidden="true" />
}

function Meter({ percent }: { percent: number }) {
  return <span className="meter" aria-hidden="true"><i style={{ width: `${percent}%` }} /></span>
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
          {sampleDays.map(({ day, runs }) => (
            <div className="sample-line" key={day}>
              <span>{day}</span>
              <Track segments={sampleSegments(runs)} win={workday} now={null} />
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

type View = 'team' | 'day' | 'week' | 'people' | 'devices' | 'settings'
// Navigation by role. Workers see only their recorded hours and their account.
// Screenshots, applications and deleting are for managers and owners, and the
// API refuses them to workers.
const navigation = (user: User): { label: string; items: [View, string][] }[] =>
  user.role === 'worker'
    ? [{ label: 'Time', items: [['week', 'My hours']] }, { label: 'Account', items: [['settings', 'Settings']] }]
    : [
        { label: 'Time', items: [['team', 'Team today'], ['week', 'Week']] },
        { label: 'Organisation', items: [['people', 'People'], ['devices', 'Devices']] },
        { label: 'Account', items: [['settings', 'Settings']] },
      ]

function Dashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const manager = user.role !== 'worker'
  const [team, setTeam] = useState<Worker[]>([])
  const [selected, setSelected] = useState(user.id)
  const [date, setDate] = useState(localDate())
  const [blocks, setBlocks] = useState<Block[]>([])
  const [hours, setHours] = useState<Hours[]>([])
  const [spans, setSpans] = useState<DaySpan[]>([])
  const [devices, setDevices] = useState<Device[]>([])
  const [deviceSpans, setDeviceSpans] = useState<DeviceSpan[]>([])
  const [laptopError, setLaptopError] = useState(false)
  const [openDevice, setOpenDevice] = useState('')
  const [zoom, setZoom] = useState(true)
  const [view, setView] = useState<View>(manager ? 'team' : 'week')
  const [orgs, setOrgs] = useState<Org[]>([])
  // Owner-only narrowing to one org. Empty means every org. Kept in the URL.
  const [org, setOrgState] = useState(() => new URLSearchParams(location.search).get('org') ?? '')
  const setOrg = (value: string) => {
    const url = new URL(location.href)
    if (value) url.searchParams.set('org', value)
    else url.searchParams.delete('org')
    history.replaceState(null, '', url)
    setOrgState(value)
  }
  const [tab, setTab] = useState<typeof dayTabs[number]>('Screenshots')
  const [openSession, setOpenSession] = useState<OpenSession | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)
  const [updated, setUpdated] = useState<Date | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [expanded, setExpanded] = useState<Block | null>(null)
  const generation = useRef(0)
  const range = weekRange(date)
  const applications = applicationTotals(blocks)
  const load = useCallback(async () => {
    const current = ++generation.current
    try {
      const day = new URLSearchParams({ date, tz: zone })
      const [members, timeline, report, session, daySpans, fleet, laptopSpans] = await Promise.all([
        manager ? api<Worker[]>(withOrg('/team', org)) : Promise.resolve([]),
        manager ? api<Block[]>(
          `/timeline?${new URLSearchParams({ user: selected, date, tz: zone })}`,
        ) : Promise.resolve([]),
        api<Hours[]>(withOrg(`/reports/hours?${new URLSearchParams({ ...weekRange(date), tz: zone })}`, org)),
        api<OpenSession | null>('/sessions/current'),
        manager ? api<DaySpan[]>(withOrg(`/reports/day?${day}`, org)) : Promise.resolve([]),
        // Laptops add to the time views. If they fail, recorded time still loads
        // and the pages that show laptops say so.
        manager ? api<Device[]>(withOrg('/devices', org)).catch(() => null) : Promise.resolve([]),
        manager ? api<DeviceSpan[]>(withOrg(`/reports/device-day?${day}`, org)).catch(() => null) : Promise.resolve([]),
      ])
      if (generation.current !== current) return
      setTeam(members || [])
      setBlocks(timeline || [])
      setHours(report || [])
      setSpans(daySpans || [])
      if (fleet) setDevices(fleet)
      setDeviceSpans(laptopSpans || [])
      setLaptopError(!fleet || !laptopSpans)
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
  }, [manager, selected, date, org, onLogout])
  useEffect(() => {
    if (manager) api<Org[]>('/orgs').then(setOrgs).catch(() => {})
  }, [manager])
  useEffect(() => {
    setBusy(true)
    setBlocks([])
    setHours([])
    setSpans([])
    setDeviceSpans([])
    setExpanded(null)
    void load()
    const timer = window.setInterval(() => {
      if (!document.hidden) void load()
    }, 30000)
    return () => {
      clearInterval(timer)
      generation.current++
    }
  }, [load])
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
      await load()
    } catch (error) {
      setError(message(error))
    } finally {
      setActionBusy(false)
    }
  }
  const go = (next: View) => {
    setView(next)
    window.scrollTo(0, 0)
  }
  const openPerson = (id: string) => {
    // Clear the previous person's day in the same render, so their screenshots
    // never show under the new name while the new day loads.
    if (id !== selected) {
      setBusy(true)
      setBlocks([])
      setSelected(id)
    }
    setTab('Screenshots')
    go('day')
  }
  const today = localDate()
  const isToday = date === today
  const now = isToday ? minuteOfDay(new Date()) : null
  const selectedPerson = team.find((person) => person.id === selected)
  const selectedLabel = selected === user.id ? (user.name || user.email) : selectedPerson?.name || selectedPerson?.email || 'Worker'
  const blockActive = blocks.reduce((sum, block) => sum + block.active_seconds, 0)
  const dayLabel = new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
  const shiftDate = (days: number) => {
    const day = new Date(`${date}T12:00:00Z`)
    day.setUTCDate(day.getUTCDate() + days)
    const next = utcDate(day)
    setDate(days > 0 && next > today ? today : next)
  }
  const people = manager
    ? [...team].sort((a, b) => Number(b.working) - Number(a.working) || (a.name || a.email).localeCompare(b.name || b.email))
    : [user as Worker]
  const personSeconds = (id: string) => hours.filter((row) => row.user_id === id && row.date.slice(0, 10) === date).reduce((sum, row) => sum + row.seconds, 0)
  const statusLine = (person: Worker) => {
    if (person.disabled) return 'Account disabled'
    if (person.working) return 'Working now'
    return personSeconds(person.id) > 0 ? 'Not tracking now' : 'No time this day'
  }
  const byHour = (list: Block[]) => list.reduce<{ hour: string; items: Block[] }[]>((groups, block) => {
    const hour = new Date(block.start_at).toLocaleTimeString(undefined, { hour: '2-digit', timeZone: zone })
    const group = groups[groups.length - 1]
    if (group?.hour === hour) group.items.push(block)
    else groups.push({ hour, items: [block] })
    return groups
  }, [])
  // One ribbon per person. Managers get everyone from the day report, workers their own blocks.
  const personSegments = useMemo(
    () => manager ? ribbonBy(spans, span => span.user_id, date) : new Map([[user.id, ribbon(blocks, date)]]),
    [manager, spans, blocks, date, user.id],
  )
  const laptopSegments = useMemo(() => ribbonBy(deviceSpans, span => span.device_id, date), [deviceSpans, date])
  // Zooming to the working day must never hide recorded time, so it is
  // switched off for any day with time outside 06:00 to 22:00.
  const hidden = useMemo(
    () => [...personSegments.values(), ...laptopSegments.values()].some(list => outside(list, workday.from, workday.to)),
    [personSegments, laptopSegments],
  )
  const win = zoom && !hidden ? workday : fullDay
  const inputBy = useMemo(() => {
    const totals = new Map<string, { active: number; seconds: number; known: boolean }>()
    for (const span of spans) {
      const total = totals.get(span.user_id) ?? { active: 0, seconds: 0, known: true }
      total.seconds += (Date.parse(span.end_at) - Date.parse(span.start_at)) / 1000
      if (span.active_seconds == null) total.known = false
      else total.active += span.active_seconds
      totals.set(span.user_id, total)
    }
    return totals
  }, [spans])
  const personInput = (id: string) => {
    const total = inputBy.get(id)
    return total && total.known && total.seconds > 0 ? activity(total.active, total.seconds) : null
  }
  const laptopSeconds = (id: string) => deviceSpans.filter(span => span.device_id === id).reduce((sum, span) => sum + span.active_seconds, 0)
  const selectedSegments = personSegments.get(selected) ?? []
  const selectedLaptops = manager ? devices.filter(device => device.user_id === selected) : []
  const unassignedLaptops = devices.filter(device => !device.user_id).length
  const screenshots = blocks.filter(block => !isTimeOnly(block))
  const screenshotCount = screenshots.filter(block => block.screenshot_url).length
  const firstBlock = blocks[0]
  const lastBlock = blocks[blocks.length - 1]
  const dateControls = (step: 1 | 7) => (
    <div className="datenav">
      <button aria-label={step === 1 ? 'Previous day' : 'Previous week'} onClick={() => shiftDate(-step)}>‹</button>
      <label className="date-label">
        <span className="sr-only">Date ({zone})</span>
        <input type="date" value={date} required onChange={event => { if (event.target.value) setDate(event.target.value) }} />
      </label>
      <button aria-label={step === 1 ? 'Next day' : 'Next week'} onClick={() => shiftDate(step)} disabled={step === 1 ? isToday : range.to >= today}>›</button>
      {!isToday && <button onClick={() => setDate(today)}>Today</button>}
    </div>
  )
  const zoomControl = (
    <div className="board-notes">
      <label className="check">
        <input type="checkbox" checked={zoom && !hidden} disabled={hidden} onChange={event => setZoom(event.target.checked)} />
        Show 06:00 to 22:00 only
      </label>
      {hidden && <span className="muted">Showing the full day because time was recorded outside 06:00 to 22:00.</span>}
    </div>
  )
  const appMax = applications[0]?.milliseconds || 1
  const weekDays = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(`${range.from}T00:00:00Z`)
    day.setUTCDate(day.getUTCDate() + index)
    return utcDate(day)
  })
  const weekRows = manager ? team : [user]
  const cellSeconds = (id: string, day: string) => hours.filter((row) => row.user_id === id && row.date.slice(0, 10) === day).reduce((sum, row) => sum + row.seconds, 0)
  const shortDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', timeZone: 'UTC' })
  const currentNav = view === 'day' && manager ? 'team' : view
  const workingCount = team.filter(person => person.working).length
  const teamSeconds = team.reduce((sum, person) => sum + personSeconds(person.id), 0)
  return (
    <div className="shell">
      <aside className="side">
        <a className="brand" href="/">
          <Logo /> WorkTrack
        </a>
        {user.role === 'owner' && orgs.length > 0 && (
          <label className="org-switch">
            <span className="sr-only">Organisation</span>
            <select value={org} onChange={e => setOrg(e.target.value)}>
              <option value="">All organisations</option>
              {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
        )}
        <nav className="global-nav" aria-label="Main navigation">
          {navigation(user).map(group => (
            <div key={group.label} role="group" aria-label={group.label}>
              <p aria-hidden="true">{group.label}</p>
              {group.items.map(([id, label]) => (
                <button key={id} aria-current={currentNav === id ? 'page' : undefined} onClick={() => go(id)}>{label}</button>
              ))}
            </div>
          ))}
        </nav>
        <div className="account">
          <span className="avatar" aria-hidden="true">{initials(user)}</span>
          <span>
            <b>{user.name || user.email}</b>
            <small>{roleName[user.role]}{user.role !== 'owner' && orgs.length === 1 ? `, ${orgs[0].name}` : ''}</small>
          </span>
          <button onClick={logout} disabled={actionBusy}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="workspace">
        <div className="workspace-status">
          <span className="sync" role="status">
            <span className={error ? 'status-dot' : 'live-dot'} aria-hidden="true" />
            {busy ? 'Loading…' : updated ? `Updated ${updated.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : 'Connecting…'}
          </span>
          <button onClick={() => { setBusy(true); void load() }} disabled={busy}>Refresh</button>
        </div>
        {error && (
          <div className="error" role="alert">
            {error} Existing data may be out of date.
          </div>
        )}
        {openSession && (
          <section className="notice-card" aria-labelledby="recovery-heading">
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
        {view === 'team' && manager && (
          <section className="team-view" aria-busy={busy} aria-labelledby="team-heading">
            <div className="page-heading">
              <div>
                <h1 id="team-heading">{isToday ? 'Team today' : 'Team'}</h1>
                <p className="muted">
                  {isToday ? `${workingCount} of ${team.length} people working now. ` : `${dayLabel}. `}
                  {busy ? 'Loading recorded time…' : `${duration(teamSeconds)} recorded${isToday ? ' so far' : ''}.`}
                </p>
              </div>
              {dateControls(1)}
            </div>
            <TeamBoard people={people} devices={devices} win={win} now={now} busy={busy}
              segments={personSegments} laptopSegments={laptopSegments}
              seconds={personSeconds} input={personInput} laptopSeconds={laptopSeconds} status={statusLine}
              onPerson={openPerson}
              onDevice={id => { setOpenDevice(id); go('devices') }} />
            {laptopError && <p className="muted" role="status">Company laptop activity could not be loaded. Recorded time is unaffected.</p>}
            {unassignedLaptops > 0 && (
              <p className="muted">
                {unassignedLaptops === 1 ? '1 laptop is' : `${unassignedLaptops} laptops are`} not assigned to anyone, so {unassignedLaptops === 1 ? 'its' : 'their'} activity is not shown here.{' '}
                <button className="link" onClick={() => go('devices')}>Assign in Devices</button>
              </p>
            )}
            <p className="muted">
              Green is time recorded by the desktop timer, stronger where input activity was higher.
              Grey is active time on the person's assigned company laptop.
              {isToday ? ' The amber line is now.' : ''} Times in {zone}.
            </p>
            {zoomControl}
          </section>
        )}
        {view === 'day' && manager && (
          <section className="day-workspace" aria-busy={busy} aria-labelledby="day-heading">
            <p><button className="link" onClick={() => go('team')}>‹ {isToday ? 'Team today' : 'Team'}</button></p>
            <div className="page-heading">
              <div className="who">
                <span className={`avatar ${selectedPerson?.working ? 'on' : ''}`} aria-hidden="true">{initials(selectedPerson ?? user)}</span>
                <div>
                  <h1 id="day-heading">{selectedLabel}</h1>
                  <p className="muted">{selectedPerson ? `${statusLine(selectedPerson)}. ` : ''}{dayLabel}</p>
                </div>
              </div>
              {dateControls(1)}
            </div>
            <div className="panel">
              <div className="stats">
                <div><b>{busy ? '…' : duration(ownBlocks)}</b><span>Recorded</span></div>
                <div><b>{busy ? '…' : `${activity(blockActive, ownBlocks)}%`}</b><span>Input activity</span></div>
                <div><b>{busy ? '…' : screenshotCount}</b><span>{screenshotCount === 1 ? 'Screenshot' : 'Screenshots'}</span></div>
                <div>
                  <b>{busy ? '…' : firstBlock && lastBlock ? `${time(firstBlock.start_at)} to ${isToday && selectedPerson?.working ? 'now' : time(lastBlock.end_at)}` : 'None'}</b>
                  <span>First start to last stop</span>
                </div>
              </div>
              <div className="day-timeline" role="img" aria-label={`${selectedLabel}'s recorded time across the day`}>
                <Track segments={selectedSegments} win={win} now={now} />
                <Scale win={win} />
              </div>
              {selectedLaptops.map(device => (
                <div className="devline" key={device.id}>
                  <p className="muted">
                    <b>{device.hostname || 'Laptop'}</b>, assigned company laptop. {busy ? 'Loading…' : `${hm(laptopSeconds(device.id))} active.`} Health: {health(device).label}.{' '}
                    <button className="link" onClick={() => { setOpenDevice(device.id); go('devices') }}>Open laptop</button>
                  </p>
                  <Track segments={laptopSegments.get(device.id) ?? []} win={win} now={now} laptop />
                </div>
              ))}
            </div>
            <div className="day-notes">
              <p className="muted">Stronger green means more input activity.{isToday ? ' The amber line is now.' : ''} Times in {zone}.</p>
              {zoomControl}
            </div>
            <Tabs id="day" label="Day review" items={dayTabs} value={tab} onChange={setTab} />
            <div id="day-panel" className="task-panel" role="tabpanel" aria-labelledby={`day-tab-${dayTabs.indexOf(tab)}`}>
              {busy ? <p className="empty" role="status">Loading {selectedLabel}'s day…</p> : (
                <>
                  {!blocks.length && <div className="empty no-time"><h2>No time recorded</h2><p>Choose another day or wait for the desktop app to sync.</p></div>}
                  {tab === 'Screenshots' && (
                    <>
                      <p className="muted section-intro">{screenshotCount} {screenshotCount === 1 ? 'screenshot' : 'screenshots'} available. Screenshots are taken every 10 minutes while tracking.</p>
                      {screenshots.length ? byHour(screenshots).map((group, index) => (
                        <section className="hour" key={`${group.hour}-${index}`}>
                          <h3>{group.hour}</h3>
                          <div className="shots">
                            {group.items.map(block => (
                              <article className={`tile ${block.screenshot_url ? '' : 'status-tile'}`} key={block.id}>
                                {block.screenshot_url ? (
                                  <button className="screenshot" onClick={() => setExpanded(block)} aria-label={`View work block at ${time(block.start_at)}`}>
                                    <Screenshot key={block.screenshot_url} url={block.screenshot_url} alt={`Work screenshot at ${time(block.start_at)}`} />
                                  </button>
                                ) : <p className="screenshot-status">{screenshotPlaceholder(block)}</p>}
                                <div className="meta">
                                  <time dateTime={block.start_at}>{time(block.start_at)}</time>
                                  {block.screenshot_url
                                    ? <span className="muted"><Meter percent={activity(block.active_seconds, block.duration_seconds)} />{activity(block.active_seconds, block.duration_seconds)}%<span className="sr-only"> input activity</span></span>
                                    : <button className="link" onClick={() => setExpanded(block)} aria-label={`View details at ${time(block.start_at)}`}>View details</button>}
                                </div>
                              </article>
                            ))}
                          </div>
                        </section>
                      )) : <div className="empty screenshot-empty"><h3>No screenshots for this day</h3><p>{blocks.length ? 'Recorded activity is available in Activity details. Screenshots appear after 10 running minutes.' : 'Screenshots will appear here when the desktop app uploads them.'}</p></div>}
                    </>
                  )}
                  {tab === 'Activity details' && (
                    <>
                      <p className="muted section-intro">Exact uploaded intervals. Input activity is not proof of productivity.</p>
                      {byHour(blocks).map((group, index) => <section className="hourgrp" key={`${group.hour}-${index}`}>
                        <h3>{group.hour}</h3>
                        <ul className="activity-list">{group.items.map(block => <li className="time-row" key={block.id}>
                          <span className="time-range"><time dateTime={block.start_at}>{blockTime(block.start_at)}</time> to <time dateTime={block.end_at}>{blockTime(block.end_at)}</time></span>
                          <span className="record-duration">{blockDuration(block.duration_seconds)} <small>{block.duration_seconds} seconds</small></span>
                          <span><Meter percent={activity(block.active_seconds, block.duration_seconds)} />{activity(block.active_seconds, block.duration_seconds)}% input activity</span>
                          <button onClick={() => setExpanded(block)} aria-label={`View work block at ${blockTime(block.start_at)}`}>View details</button>
                        </li>)}</ul>
                      </section>)}
                    </>
                  )}
                  {tab === 'Applications' && (
                    <>
                      <p className="muted section-intro">Estimated foreground time by program name. Includes idle time. Window titles, files and sites are never recorded.</p>
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
        )}
        {view === 'week' && (
        <section className="report-view" aria-busy={busy} aria-labelledby="week-heading">
          <div className="page-heading">
            <div>
              <h1 id="week-heading">{manager ? 'Week' : 'My hours'}</h1>
              <p className="muted">{range.from} to {range.to}. {busy ? 'Loading…' : `${duration(weekSeconds)} ${manager ? 'team' : 'total'} recorded.`}</p>
            </div>
            <div className="actions">
              <a className="button" href={`/api/reports/hours.csv?${new URLSearchParams({ ...range, tz: zone })}`} download>Export CSV</a>
              {dateControls(7)}
            </div>
          </div>
          <div className="panel table-scroll">
            <table className="week">
              <caption className="sr-only">Daily and weekly recorded hours per person</caption>
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  {weekDays.map((day) => (
                    <th scope="col" key={day} className={day === date ? 'cell-sel' : ''}>{shortDay(day)}</th>
                  ))}
                  <th scope="col">Total</th>
                </tr>
              </thead>
              <tbody>
                {weekRows.map((person) => (
                  <tr key={person.id}>
                    <th scope="row">{person.name || person.email}</th>
                    {weekDays.map((day) => {
                      const seconds = cellSeconds(person.id, day)
                      return (
                        <td key={day} className={`${day === date ? 'cell-sel' : ''} ${seconds ? '' : 'zero'}`}>
                          {busy ? '…' : duration(seconds)}
                          <span className="bar" aria-hidden="true"><i style={{ width: `${Math.min(100, (seconds / 28800) * 100)}%` }} /></span>
                        </td>
                      )
                    })}
                    <td className="total">{busy ? '…' : duration(hours.filter((row) => row.user_id === person.id).reduce((sum, row) => sum + row.seconds, 0))}</td>
                  </tr>
                ))}
              </tbody>
              {manager && weekRows.length > 1 && (
                <tfoot>
                  <tr>
                    <th scope="row">Team</th>
                    {weekDays.map((day) => {
                      const seconds = weekRows.reduce((sum, person) => sum + cellSeconds(person.id, day), 0)
                      return <td key={day} className={day === date ? 'cell-sel' : ''}>{busy ? '…' : duration(seconds)}</td>
                    })}
                    <td className="total">{busy ? '…' : duration(weekSeconds)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <p className="muted">Times in {zone}. Totals include recorded time only. Bars fill at 8 hours.</p>
          {!busy && !hours.length && <p className="empty">No recorded hours this week.</p>}
        </section>
        )}
        {view === 'people' && manager && (
          <People user={user} team={team} orgs={orgs} org={org} onOrg={setOrg} loading={busy} onChange={load} />
        )}
        {view === 'devices' && manager && (
          <>
            {laptopError && <p className="error" role="alert">Laptops could not be loaded. Select Refresh to try again.</p>}
            <Devices key={org} owner={user.role === 'owner'} devices={devices} people={team} orgs={orgs} loading={busy} open={openDevice} onOpen={setOpenDevice} onChange={load} />
          </>
        )}
        {view === 'settings' && (
          <section className="settings-view" aria-labelledby="settings-heading">
            <div className="page-heading"><div><h1 id="settings-heading">Settings</h1><p className="muted">Desktop app and your account.</p></div></div>
            <div className="split">
              <div className="stack">
                <DownloadCard />
                <section className="panel pad" aria-labelledby="records-heading">
                  <h2 id="records-heading">What the desktop app records</h2>
                  <p className="muted">Only while your desktop timer is running:</p>
                  <ul className="two">
                    <li>Start and stop times</li>
                    <li>Whether the keyboard or mouse was used recently, as an activity level</li>
                    <li>A screenshot of the main display every 10 minutes</li>
                    <li>One location fix with each screenshot</li>
                    <li>Program names and estimated time in each</li>
                  </ul>
                  <p className="muted">Never recorded:</p>
                  <ul className="two">
                    <li>What you type</li>
                    <li>Window titles, sites or documents</li>
                    <li>Full file paths</li>
                    <li>Continuous location</li>
                    <li>Screenshots, activity or location while the timer is stopped</li>
                  </ul>
                  <p className="muted">
                    While you are signed in, the desktop app also sends diagnostic error codes, its version and timestamps, even when the timer is stopped.
                    Only owners can read them, and they are kept for seven days.
                  </p>
                  <p className="muted">
                    Company laptops with the managed agent are separate. They show a monitoring notice and a tray icon, and record what your administrator has turned on.
                  </p>
                </section>
              </div>
              <section className="panel pad" aria-labelledby="password-heading">
                <h2 id="password-heading">Change password</h2>
                <PasswordForm />
              </section>
            </div>
          </section>
        )}
        <footer>
          Screenshots, activity and location are recorded only while the
          desktop timer is running.
        </footer>
      </main>
      {expanded && (
        <Modal title={`Work block ${time(expanded.start_at)}`} onClose={() => setExpanded(null)}>
          {expanded.screenshot_url ? (
            <div className="full-screenshot"><Screenshot key={expanded.screenshot_url} url={expanded.screenshot_url} alt="Full work screenshot" /></div>
          ) : (
            <p className="empty">{screenshotPlaceholder(expanded)}</p>
          )}
          <div className="facts">
            <div><b>{blockTime(expanded.start_at)} to {blockTime(expanded.end_at)}</b><span>{blockDuration(expanded.duration_seconds)} recorded ({expanded.duration_seconds} seconds)</span></div>
            <div><b>{activity(expanded.active_seconds, expanded.duration_seconds)}%</b><span>Input activity</span></div>
          </div>
          {expanded.location && <p>{locationText(expanded.location)}</p>}
          {expanded.user_id === user.id ? (
            <>
              <div className="block-actions">
                {expanded.screenshot_url && <button className="delete" onClick={() => void remove(expanded, true)} disabled={actionBusy}>Delete screenshot</button>}
                <button className="delete" onClick={() => void remove(expanded)} disabled={actionBusy}>Delete time block</button>
              </div>
              <p className="muted">Deleting a screenshot keeps the time. Deleting a time block permanently deducts it from your recorded hours.</p>
            </>
          ) : selectedPerson?.role === 'worker' ? (
            <p className="muted">A worker's recorded time and screenshots cannot be deleted.</p>
          ) : (
            <p className="muted">Only {selectedLabel} can delete this screenshot or time block.</p>
          )}
        </Modal>
      )}
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
