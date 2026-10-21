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
