import assert from 'node:assert/strict'
import test from 'node:test'
import { activity, applicationTotals, duration, localDate, locationText, screenshotPlaceholder, utcDate, weekRange } from './utils.ts'

test('time-only and deleted blocks are not mislabeled as unavailable screenshots', () => {
  assert.equal(screenshotPlaceholder({ screenshot_status: 'not_captured', duration_seconds: 30 }), 'No screenshot captured (30s time block).')
  assert.equal(screenshotPlaceholder({ screenshot_status: 'deleted', duration_seconds: 30 }), 'Screenshot deleted.')
  assert.equal(screenshotPlaceholder({ screenshot_status: 'unavailable', duration_seconds: 30 }), 'Screenshot temporarily unavailable.')
  assert.equal(screenshotPlaceholder({ duration_seconds: 30 }), 'No screenshot attached to this time block.')
})
test('foreground milliseconds aggregate by app without inventing older-client data', () => {
  assert.deepEqual(applicationTotals([{}, { application_usage: [{ app: 'chrome.exe', milliseconds: 60000 }] }, { application_usage: [{ app: 'chrome.exe', milliseconds: 30000 }, { app: 'code.exe', milliseconds: 10000 }] }]), [{ app: 'chrome.exe', milliseconds: 90000 }, { app: 'code.exe', milliseconds: 10000 }])
})
test('location renders zero coordinates, accuracy and honest missing states', () => {
  assert.equal(locationText(null), null)
  assert.match(locationText({ status: 'disabled', captured_at: '' })!, /sharing off/)
  assert.match(locationText({ status: 'unavailable', captured_at: '' })!, /unavailable/)
  assert.match(locationText({ status: 'available', captured_at: '', latitude: 0, longitude: 0, accuracy_m: 25 })!, /0.00000, 0.00000.*±25 m/)
})
test('weeks run Monday to Sunday across month and year boundaries', () => {
  assert.deepEqual(weekRange('2027-01-01'), {
    from: '2026-12-28',
    to: '2027-01-03',
  })
  assert.deepEqual(weekRange('2026-10-25'), {
    from: '2026-10-19',
    to: '2026-10-25',
  })
  assert.deepEqual(weekRange('2026-10-26'), {
    from: '2026-10-26',
    to: '2026-11-01',
  })
})
test('dates are UTC regardless of browser locale', () => {
  assert.equal(utcDate(new Date('2026-10-21T01:00:00+05:30')), '2026-10-20')
})
test('duration keeps exact whole minutes without rounding up payroll time', () => {
  assert.equal(duration(0), '0h 00m')
  assert.equal(duration(600), '0h 10m')
  assert.equal(duration(3659), '1h 00m')
  assert.equal(duration(90000), '25h 00m')
})
test('activity handles empty and partial blocks safely', () => {
  assert.equal(activity(0, 0), 0)
  assert.equal(activity(45, 60), 75)
  assert.equal(activity(120, 60), 100)
  assert.equal(activity(-1, 60), 0)
})
test('local dates follow the requested zone, not UTC', () => {
  // 20:00 UTC is already the next day in India and still the same day in New York.
  const instant = new Date('2026-10-21T20:00:00Z')
  assert.equal(localDate(instant, 'Asia/Kolkata'), '2026-10-22')
  assert.equal(localDate(instant, 'America/New_York'), '2026-10-21')
  assert.equal(localDate(instant, 'UTC'), '2026-10-21')
})
