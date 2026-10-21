import assert from 'node:assert/strict'
import test from 'node:test'
import { activity, duration, utcDate, weekRange } from './utils.ts'

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
