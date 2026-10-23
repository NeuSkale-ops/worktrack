import assert from 'node:assert/strict'
import test from 'node:test'
import { activity, applicationTotals, blockDuration, duration, isTimeOnly, localDate, locationText, ribbon, screenshotPlaceholder, utcDate, weekRange } from './utils.ts'

test('time-only policy preserves screenshot evidence including legacy location', () => {
  assert.equal(isTimeOnly({ screenshot_url: null, screenshot_status: 'not_captured' }), true)
  assert.equal(isTimeOnly({ screenshot_url: null }), true)
  for (const screenshot_status of ['available', 'deleted', 'unavailable'] as const) {
    assert.equal(isTimeOnly({ screenshot_url: null, screenshot_status }), false)
  }
  assert.equal(isTimeOnly({ screenshot_url: 'image', screenshot_status: 'not_captured' }), false)
  assert.equal(isTimeOnly({ screenshot_url: null, location: { status: 'disabled', captured_at: '' } }), false)
})
test('block duration preserves seconds without changing payroll rounding', () => {
  for (const [seconds, text] of [[0, '0s'], [30, '30s'], [60, '1m'], [90, '1m 30s'], [3659, '1h 59s'], [3661, '1h 1m 1s']] as const) assert.equal(blockDuration(seconds), text)
  assert.equal(duration(30), '0h 00m')
})

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
test('location qualifies system estimates without inferring provenance', () => {
  const location = { status: 'available' as const, captured_at: '', latitude: 0, longitude: 0, accuracy_m: 1000 }
  const legacy = locationText(location)!
  assert.match(legacy, /system estimate/)
  assert.match(legacy, /Source: not reported\. Remote source: not reported\./)
  assert.match(legacy, /Not verified true location/)
  assert.doesNotMatch(legacy, /Coarse estimate/)
  assert.match(locationText({ ...location, accuracy_m: 1000.1 })!, /Coarse estimate/)
  for (const position_source of ['cellular', 'satellite', 'wifi', 'ip_address', 'default', 'obfuscated', 'unknown'] as const) {
    for (const is_remote_source of [true, false, null]) {
      const text = locationText({ ...location, position_source, is_remote_source })!
      assert.ok(text.includes(`Source: ${position_source}.`))
      assert.ok(text.includes(`Remote source: ${is_remote_source == null ? 'not reported' : is_remote_source ? 'yes' : 'no'}.`))
    }
  }
  assert.match(locationText({ ...location, position_source: null, is_remote_source: null })!, /Source: not reported\. Remote source: not reported\./)
  assert.equal(locationText({ ...location, status: 'unavailable', position_source: 'wifi', is_remote_source: true }), 'Screenshot location: unavailable.')
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
test('ribbon merges short gaps and clips blocks to the local day', () => {
  const blocks = [
    { start_at: '2026-10-21T09:00:00Z', end_at: '2026-10-21T09:00:30Z' },
    { start_at: '2026-10-21T09:00:30Z', end_at: '2026-10-21T09:01:00Z' },
    { start_at: '2026-10-21T12:00:00Z', end_at: '2026-10-21T12:10:00Z' },
    { start_at: '2026-10-20T23:55:00Z', end_at: '2026-10-21T00:05:00Z' },
  ]
  const segments = ribbon(blocks, '2026-10-21', 'UTC')
  assert.equal(segments.length, 3)
  assert.equal(segments[0].left, 0)
  assert.ok(Math.abs(segments[1].left - (540 / 1440) * 100) < 0.01)
  assert.ok(Math.abs(segments[2].width - (10 / 1440) * 100) < 0.01)
  // 18:25 UTC is 23:55 in India, so the same block lands at the end of the IST day.
  const ist = ribbon([{ start_at: '2026-10-21T18:25:00Z', end_at: '2026-10-21T18:35:00Z' }], '2026-10-21', 'Asia/Kolkata')
  assert.ok(Math.abs(ist[0].left - (1435 / 1440) * 100) < 0.01)
  assert.ok(Math.abs(ist[0].left + ist[0].width - 100) < 0.01)
})
