import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from './api'
import { DeviceConfigForm } from './DeviceDetail'
import { activitySpans, health, hm, summarize } from './deviceActivity'
import type { Device, DeviceEvent } from './deviceActivity'
import Modal from './Modal'
import { fullDay, Scale, Track, workday } from './Ribbon'
import { Screenshot } from './Screenshot'
import Tabs from './Tabs'
import { activity, localDate, minuteOfDay, outside, ribbon, zone } from './utils'

const tabs = ['Screenshots', 'Applications', 'Session events', 'Capture settings'] as const
const sessionLabel: Record<string, string> = { logon: 'Signed in', logoff: 'Signed out', lock: 'Locked', unlock: 'Unlocked' }
const clock = (iso: string, seconds = false) => new Date(iso).toLocaleTimeString(undefined, {
  hour: '2-digit', minute: '2-digit', second: seconds ? '2-digit' : undefined, timeZone: zone,
})
const since = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'Never')

function locationLine(e: DeviceEvent): string | null {
  const l = e.payload.location
  if (!l) return null
  if (l.status !== 'available' || l.latitude == null || l.longitude == null) return 'Screenshot location: unavailable.'
  return `Screenshot location: ${l.latitude.toFixed(3)}, ${l.longitude.toFixed(3)} (accuracy ±${Math.round(l.accuracy_m ?? 0)} m).`
}

/**
 * One laptop's day, laid out like a person's day: totals, a ribbon of active
 * time, then screenshots by hour. The organisation and person selectors and
 * the command buttons come from the Devices page, which owns those actions.
 */
export default function DevicePage({ device, owner, organisation, assignee, actions, error, onBack, onSaved }: {
  device: Device
  owner: boolean
  organisation: ReactNode
  assignee: ReactNode
  actions: ReactNode
  error: string
  onBack: () => void
  onSaved: () => void
}) {
  const today = localDate()
  const [date, setDate] = useState(today)
  const [events, setEvents] = useState<DeviceEvent[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [tab, setTab] = useState<typeof tabs[number]>('Screenshots')
  const [zoom, setZoom] = useState(true)
  const [expanded, setExpanded] = useState<DeviceEvent | null>(null)
  const name = device.hostname || '(unknown)'
  const isToday = date === today

  // A new day starts empty, so the previous day never shows under the new date.
  useEffect(() => { setEvents(null) }, [date])
  // Reloads when the laptop syncs, which the Devices list refreshes every 30 seconds.
  useEffect(() => {
    let current = true
    api<DeviceEvent[]>(`/devices/${encodeURIComponent(device.id)}/activity?${new URLSearchParams({ date, tz: zone })}`)
      .then(list => { if (current) { setEvents([...list].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))); setLoadError('') } })
      .catch(e => { if (current) { setEvents(found => found ?? []); setLoadError(e instanceof Error ? e.message : 'Could not load activity.') } })
    return () => { current = false }
  }, [device.id, date, device.last_sync_at])

  const busy = events === null
  const list = events ?? []
  const summary = useMemo(() => summarize(list), [events])
  const segments = useMemo(() => ribbon(activitySpans(list), date), [events, date])
  const shots = list.filter(e => e.kind === 'screenshot')
  const sessions = list.filter(e => e.kind === 'session' || e.kind === 'acknowledged')
  const minutes = list.filter(e => e.kind === 'activity')
  const hidden = outside(segments, workday.from, workday.to)
  const win = zoom && !hidden ? workday : fullDay
  const appMax = summary.apps[0]?.[1] || 1
  const byHour = shots.reduce<{ hour: string; items: DeviceEvent[] }[]>((groups, e) => {
    const hour = new Date(e.occurred_at).toLocaleTimeString(undefined, { hour: '2-digit', timeZone: zone })
    const group = groups[groups.length - 1]
    if (group?.hour === hour) group.items.push(e)
    else groups.push({ hour, items: [e] })
    return groups
  }, [])
  const shift = (days: number) => {
    const day = new Date(`${date}T00:00:00Z`)
    day.setUTCDate(day.getUTCDate() + days)
    setDate(day.toISOString().slice(0, 10))
  }

  return (
    <section className="day-workspace" aria-busy={busy} aria-labelledby="device-heading">
      <p><button className="link" onClick={onBack}>‹ Devices</button></p>
      <div className="page-heading">
        <div>
          <h1 id="device-heading">{name}</h1>
          <p className="muted"><span className={`pill ${health(device).tone}`}>{health(device).label}</span> Company laptop, enrolled as {device.upn}.</p>
        </div>
        <div className="datenav">
          <button aria-label="Previous day" onClick={() => shift(-1)}>‹</button>
          <label className="date-label">
            <span className="sr-only">Date ({zone})</span>
            <input type="date" value={date} max={today} required onChange={e => { if (e.target.value) setDate(e.target.value) }} />
          </label>
          <button aria-label="Next day" onClick={() => shift(1)} disabled={isToday}>›</button>
          {!isToday && <button onClick={() => setDate(today)}>Today</button>}
        </div>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {loadError && <p className="error" role="alert">{loadError}</p>}
      <div className="panel">
        <div className="stats">
          <div><b>{busy ? '…' : hm(summary.activeSecs)}</b><span>Active</span></div>
          <div><b>{busy ? '…' : `${activity(summary.activeSecs, summary.activeSecs + summary.idleSecs)}%`}</b><span>Input activity</span></div>
          <div><b>{busy ? '…' : shots.length}</b><span>{shots.length === 1 ? 'Screenshot' : 'Screenshots'}</span></div>
          <div>
            <b>{busy ? '…' : minutes.length ? `${clock(new Date(Date.parse(minutes[0].occurred_at) - 60000).toISOString())} to ${clock(minutes[minutes.length - 1].occurred_at)}` : 'None'}</b>
            <span>First to last activity</span>
          </div>
        </div>
        <div className="day-timeline" role="img" aria-label={`Active time on ${name} across the day`}>
          <Track segments={segments} win={win} now={isToday ? minuteOfDay(new Date()) : null} />
          <Scale win={win} />
        </div>
      </div>
      <div className="day-notes">
        <p className="muted">
          {busy ? 'Loading…' : `Idle ${hm(summary.idleSecs)}, locked ${hm(summary.lockedSecs)}. `}
          Stronger green means more input activity.{isToday ? ' The amber line is now.' : ''} Times in {zone}.
          {!owner && ' Shows activity recorded since this laptop was last assigned.'}
        </p>
        <div className="board-notes">
          <label className="check">
            <input type="checkbox" checked={zoom && !hidden} disabled={hidden} onChange={e => setZoom(e.target.checked)} />
            Show 06:00 to 22:00 only
          </label>
          {hidden && <span className="muted">Showing the full day because activity was recorded outside 06:00 to 22:00.</span>}
        </div>
      </div>
      <section className="panel device-card" aria-label="Laptop details">
        <div className="pair">
          <label>Organisation
            {organisation}
            {owner && <span className="muted">Managers of this organisation see this laptop.</span>}
          </label>
          <label>Assigned to
            {assignee}
            <span className="muted">This laptop's activity shows under this person in Team today and on their day.</span>
          </label>
        </div>
        <dl className="facts small">
          <div><dt>Last check-in</dt><dd>{since(device.last_checkin_at)}</dd></div>
          <div><dt>Last sync</dt><dd>{since(device.last_sync_at)}</dd></div>
          <div><dt>Agent</dt><dd>{device.agent_version || 'Not reported'} (settings v{device.config_version})</dd></div>
          <div><dt>Unsent events</dt><dd>{device.buffer_depth}</dd></div>
          <div><dt>Dropped events</dt><dd>{String(device.dropped_events)}</dd></div>
        </dl>
        <div className="block-actions">{actions}</div>
      </section>
      <Tabs id="device" label="Laptop review" items={tabs} value={tab} onChange={setTab} />
      <div id="device-panel" className="task-panel" role="tabpanel" aria-labelledby={`device-tab-${tabs.indexOf(tab)}`}>
        {tab === 'Capture settings'
          ? <DeviceConfigForm key={device.id} deviceId={device.id} saved={device.config} onSaved={onSaved} />
          : busy ? <p className="empty" role="status">Loading {name}'s day…</p> : (
            <>
              {!list.length && <div className="empty no-time"><h2>No activity recorded</h2><p>Choose another day, or wait for the laptop to come online and sync.</p></div>}
              {tab === 'Screenshots' && (
                <>
                  <p className="muted section-intro">{shots.length} {shots.length === 1 ? 'screenshot' : 'screenshots'}. Taken at the interval in Capture settings while someone is signed in.</p>
                  {byHour.length ? byHour.map((group, index) => (
                    <section className="hour" key={`${group.hour}-${index}`}>
                      <h3>{group.hour}</h3>
                      <div className="shots">
                        {group.items.map(e => (
                          <article className={`tile ${e.screenshot_url ? '' : 'status-tile'}`} key={e.event_id}>
                            {e.screenshot_url ? (
                              <button className="screenshot" onClick={() => setExpanded(e)} aria-label={`View screenshot at ${clock(e.occurred_at)}`}>
                                <Screenshot url={e.screenshot_url} alt={`Laptop screenshot at ${clock(e.occurred_at)}`} />
                              </button>
                            ) : <p className="screenshot-status">{e.payload.capture_failed ? 'Screenshot could not be captured.' : 'Screenshot unavailable.'}</p>}
                            <div className="meta">
                              <time dateTime={e.occurred_at}>{clock(e.occurred_at)}</time>
                              <span className="muted">{e.payload.app ?? ''}</span>
                            </div>
                          </article>
                        ))}
                      </div>
                    </section>
                  )) : list.length > 0 && <div className="empty screenshot-empty"><h3>No screenshots for this day</h3><p>Screenshots are off by default. Turn them on for this laptop in Capture settings.</p></div>}
                </>
              )}
              {tab === 'Applications' && (
                <>
                  <p className="muted section-intro">Foreground time by program name. Includes idle time. Window titles, files and sites are never recorded.</p>
                  {summary.apps.length ? <ul className="apps">{summary.apps.map(([app, secs]) => (
                    <li className="app-row" key={app}>
                      <span>{app}</span><span>{hm(secs)}</span>
                      <span className="fill" aria-hidden="true"><i style={{ width: `${(secs / appMax) * 100}%` }} /></span>
                    </li>
                  ))}</ul> : <p className="empty">No program usage recorded on this day.</p>}
                </>
              )}
              {tab === 'Session events' && (
                <>
                  <p className="muted section-intro">Sign-in, sign-out, lock and unlock on this laptop.</p>
                  {sessions.length ? <ul className="activity-list">{sessions.map(e => (
                    <li className="session-row" key={e.event_id}>
                      <time dateTime={e.occurred_at}>{clock(e.occurred_at, true)}</time>
                      <span>{e.kind === 'acknowledged' ? 'Monitoring notice acknowledged' : sessionLabel[e.payload.event ?? ''] ?? e.payload.event}</span>
                      <span className="muted">{e.payload.user ?? ''}</span>
                    </li>
                  ))}</ul> : <p className="empty">No session events on this day.</p>}
                </>
              )}
            </>
          )}
      </div>
      {expanded && (
        <Modal title={`Screenshot ${clock(expanded.occurred_at, true)}`} onClose={() => setExpanded(null)}>
          {expanded.screenshot_url && <div className="full-screenshot"><Screenshot url={expanded.screenshot_url} alt="Full laptop screenshot" /></div>}
          <div className="facts">
            <div><b>{clock(expanded.occurred_at, true)}</b><span>Captured</span></div>
            <div><b>{expanded.payload.app || 'Not recorded'}</b><span>Program in front</span></div>
          </div>
          {locationLine(expanded) && <p>{locationLine(expanded)}</p>}
          {expanded.payload.user && <p className="muted">Signed in as {expanded.payload.user}.</p>}
        </Modal>
      )}
    </section>
  )
}
