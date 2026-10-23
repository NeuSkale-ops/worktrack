import type { Block, ScreenshotLocation } from './api.ts'

export function isTimeOnly(block: Pick<Block, 'screenshot_url' | 'screenshot_status' | 'location'>): boolean {
  // Legacy blocks without screenshot evidence are time-only. Keep explicit image states as cards.
  return !block.screenshot_url && (block.screenshot_status === 'not_captured' || (!block.screenshot_status && !block.location))
}
export function blockDuration(seconds: number): string {
  const whole = Math.floor(Math.max(0, seconds))
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor(whole % 3600 / 60)
  return [hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', whole % 60 || !whole ? `${whole % 60}s` : ''].filter(Boolean).join(' ')
}

export function screenshotPlaceholder(block: Pick<Block, 'screenshot_status' | 'duration_seconds'>): string {
  switch (block.screenshot_status) {
    case 'not_captured': return `No screenshot captured (${block.duration_seconds}s time block).`
    case 'deleted': return 'Screenshot deleted.'
    case 'unavailable': return 'Screenshot temporarily unavailable.'
    default: return 'No screenshot attached to this time block.'
  }
}
export function applicationTotals(blocks: Pick<Block, 'application_usage'>[]) {
  const totals = new Map<string, number>()
  for (const block of blocks) for (const usage of block.application_usage || []) {
    totals.set(usage.app, (totals.get(usage.app) || 0) + usage.milliseconds)
  }
  return [...totals].map(([app, milliseconds]) => ({ app, milliseconds }))
    .sort((a, b) => b.milliseconds - a.milliseconds || a.app.localeCompare(b.app))
}
export function locationText(location?: ScreenshotLocation | null): string | null {
  if (!location) return null
  if (location.status === 'disabled') return 'Screenshot location: sharing off.'
  if (location.status !== 'available' || location.latitude == null || location.longitude == null || location.accuracy_m == null) return 'Screenshot location: unavailable.'
  const source = location.position_source ?? 'not reported'
  const remote = location.is_remote_source == null ? 'not reported' : location.is_remote_source ? 'yes' : 'no'
  const coarse = location.accuracy_m > 1000 ? ' Coarse estimate.' : ''
  return `Screenshot location: system estimate ${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)} (accuracy ±${Math.ceil(location.accuracy_m)} m).${coarse} Source: ${source}. Remote source: ${remote}. Observed: ${location.observed_at || 'unknown'}. Not verified true location.`
}

export function utcDate(date = new Date()): string {
  return date.toISOString().slice(0, 10)
}
/** Browser IANA zone, sent as `tz` so report days match the viewer's calendar. */
export const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
/** YYYY-MM-DD for `date` in time zone `tz`. */
export function localDate(date = new Date(), tz = zone): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}
export function weekRange(date: string): { from: string; to: string } {
  const day = new Date(`${date}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7))
  const from = utcDate(day)
  day.setUTCDate(day.getUTCDate() + 6)
  return { from, to: utcDate(day) }
}
export function duration(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60)
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}
export function activity(active: number, seconds: number): number {
  return seconds > 0
    ? Math.round(Math.min(1, Math.max(0, active / seconds)) * 100)
    : 0
}
/** Minutes since local midnight in `tz` for an instant. */
export function minuteOfDay(instant: string | Date, tz = zone): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant))
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0)
  return get('hour') * 60 + get('minute') + get('second') / 60
}
export interface Span { start_at: string; end_at: string }
/**
 * Merge consecutive blocks into ribbon segments as day percentages for `date` in `tz`.
 * Blocks separated by under two minutes join, so 30-second uploads read as one run.
 */
export function ribbon(spans: Span[], date: string, tz = zone): { left: number; width: number }[] {
  const out: { left: number; width: number }[] = []
  for (const span of [...spans].sort((a, b) => a.start_at.localeCompare(b.start_at))) {
    const startDay = localDate(new Date(span.start_at), tz)
    const endDay = localDate(new Date(new Date(span.end_at).getTime() - 1), tz)
    if (endDay < date || startDay > date) continue
    const start = startDay < date ? 0 : minuteOfDay(span.start_at, tz)
    const end = endDay > date ? 1440 : minuteOfDay(new Date(new Date(span.end_at).getTime() - 1), tz) + 1 / 60
    const last = out[out.length - 1]
    if (last && start - (last.left + last.width) <= 2) last.width = Math.max(last.width, end - last.left)
    else out.push({ left: start, width: end - start })
  }
  return out.map((segment) => ({ left: (segment.left / 1440) * 100, width: Math.max(0.2, (segment.width / 1440) * 100) }))
}
