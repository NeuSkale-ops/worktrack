import { Fragment } from 'react'
import type { Worker } from './api'
import { health, hm } from './deviceActivity'
import type { Device } from './deviceActivity'
import { Scale, Track } from './Ribbon'
import type { Win } from './Ribbon'
import { duration, initials } from './utils'
import type { Segment } from './utils'

/**
 * Everyone's day on one shared time axis. Each person's assigned company
 * laptops sit directly under them as thinner grey rows.
 */
export default function TeamBoard({ people, devices, win, now, busy, segments, laptopSegments, seconds, input, laptopSeconds, status, onPerson, onDevice }: {
  people: Worker[]
  devices: Device[]
  win: Win
  now: number | null
  busy: boolean
  segments: Map<string, Segment[]>
  laptopSegments: Map<string, Segment[]>
  seconds: (userId: string) => number
  /** Input activity percent for the day, or null when unknown. */
  input: (userId: string) => number | null
  laptopSeconds: (deviceId: string) => number
  status: (person: Worker) => string
  onPerson: (userId: string) => void
  onDevice: (deviceId: string) => void
}) {
  return (
    <section className="panel board" aria-label="Recorded time per person">
      <div className="board-row top" aria-hidden="true">
        <span>Person</span><Scale win={win} /><span className="r">Recorded</span><span className="r">Input</span>
      </div>
      {people.map((person) => {
        const name = person.name || person.email
        const recorded = seconds(person.id)
        const percent = input(person.id)
        return (
          <Fragment key={person.id}>
            <button className={`board-row person ${recorded ? '' : 'off'}`} onClick={() => onPerson(person.id)}
              aria-label={`${name}, ${status(person)}, ${duration(recorded)} recorded. Open their day.`}>
              <span className="who">
                <span className={`avatar ${person.working ? 'on' : ''}`} aria-hidden="true">{initials(person)}</span>
                <span><b>{name}</b><small>{status(person)}</small></span>
              </span>
              <Track segments={segments.get(person.id) ?? []} win={win} now={now} />
              <span className="num">{busy ? '…' : duration(recorded)}</span>
              <span className="pct">{busy || percent === null ? '' : `${percent}%`}</span>
            </button>
            {devices.filter((device) => device.user_id === person.id).map((device) => {
              const host = device.hostname || 'Laptop'
              const active = laptopSeconds(device.id)
              return (
                <button className="board-row sub" key={device.id} onClick={() => onDevice(device.id)}
                  aria-label={`${host}, company laptop assigned to ${name}, ${health(device).label}, ${hm(active)} active. Open laptop.`}>
                  <span className="who"><span><b>{host}</b><small>Company laptop, {health(device).label}</small></span></span>
                  <Track segments={laptopSegments.get(device.id) ?? []} win={win} now={now} laptop />
                  <span className="num">{busy ? '…' : hm(active)}</span>
                  <span className="pct">active</span>
                </button>
              )
            })}
          </Fragment>
        )
      })}
      {!busy && !people.length && <p className="empty">No team members yet. Invite people from the People page.</p>}
    </section>
  )
}
