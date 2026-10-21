import type { Block, ScreenshotLocation } from './api.ts'

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
  return `Screenshot location: ${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)} (accuracy ±${Math.ceil(location.accuracy_m)} m). Fix: ${location.observed_at || 'unknown'}.`
}

export function utcDate(date = new Date()): string {
  return date.toISOString().slice(0, 10)
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
