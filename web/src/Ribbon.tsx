import type { CSSProperties } from 'react'
import { zoomTo } from './utils'
import type { Segment } from './utils'

/** A window of the day in minutes, with the spacing of its hour labels. */
export interface Win { from: number; to: number; step: number }
export const fullDay: Win = { from: 0, to: 1440, step: 180 }
export const workday: Win = { from: 360, to: 1320, step: 120 }

const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

/**
 * One day as a horizontal bar. Recorded time is drawn stronger where input
 * activity was higher. Decorative: the caller supplies the accessible label.
 */
export function Track({ segments, win, now, laptop = false }: { segments: Segment[]; win: Win; now: number | null; laptop?: boolean }) {
  const nowAt = now !== null && now >= win.from && now <= win.to ? ((now - win.from) / (win.to - win.from)) * 100 : null
  return (
    <span className="track" aria-hidden="true" style={{ '--hrs': (win.to - win.from) / 60 } as CSSProperties}>
      {zoomTo(segments, win.from, win.to).map((segment, index) => (
        <i className={laptop ? 'seg dev' : 'seg'} key={index}
          style={{ left: `${segment.left}%`, width: `${segment.width}%`, opacity: laptop ? undefined : 0.45 + segment.activity * 0.55 }} />
      ))}
      {nowAt !== null && <i className="nowline" style={{ left: `${nowAt}%` }} />}
    </span>
  )
}

export function Scale({ win }: { win: Win }) {
  const marks: number[] = []
  for (let minute = win.from; minute <= win.to; minute += win.step) marks.push(minute)
  return (
    <span className="scale" aria-hidden="true">
      {marks.map((minute) => <span key={minute} style={{ left: `${((minute - win.from) / (win.to - win.from)) * 100}%` }}>{clock(minute)}</span>)}
    </span>
  )
}
