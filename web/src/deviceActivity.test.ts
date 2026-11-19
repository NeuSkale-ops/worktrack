import assert from 'node:assert/strict'
import { test } from 'node:test'
import { configError, defaultConfig, health, parseExcluded, savedConfig, summarize } from './deviceActivity.ts'

test('config validation mirrors the agent', () => {
  assert.equal(configError(defaultConfig), '')
  assert.match(configError({ ...defaultConfig, location: true }), /requires screenshots/)
  assert.match(configError({ ...defaultConfig, screenshots: true, screenshot_interval_secs: 30 }), /interval/)
  assert.equal(configError({ ...defaultConfig, screenshots: true, location: true }), '')
})

test('excluded apps are trimmed, lowercased and deduplicated', () => {
  assert.deepEqual(parseExcluded('KeePass.exe\n, keepass.exe,1password.exe\n\n'), ['keepass.exe', '1password.exe'])
})

test('activity summary adds minutes and ranks programs', () => {
  const s = summarize([
    { event_id: '1', kind: 'activity', occurred_at: '', payload: { active_secs: 50, idle_secs: 10, apps: { 'a.exe': 40, 'b.exe': 20 } } },
    { event_id: '2', kind: 'activity', occurred_at: '', payload: { active_secs: 30, locked_secs: 30, apps: { 'b.exe': 30 } } },
    { event_id: '3', kind: 'screenshot', occurred_at: '', payload: { active_secs: 999 } },
  ])
  assert.equal(s.activeSecs, 80)
  assert.equal(s.idleSecs, 10)
  assert.equal(s.lockedSecs, 30)
  assert.deepEqual(s.apps, [['b.exe', 50], ['a.exe', 40]])
})

test('saved device config fills the form over defaults', () => {
  assert.deepEqual(savedConfig({}), defaultConfig)
  assert.deepEqual(savedConfig(null), defaultConfig)
  const c = savedConfig({ screenshots: true, location: true, version: 4 } as never)
  assert.equal(c.screenshots && c.location && c.idle_time, true)
  assert.equal('version' in c, false)
})

test('device health treats silence as the tamper signal', () => {
  const now = Date.parse('2026-11-17T12:00:00Z')
  const d = { last_checkin_at: '2026-11-17T11:59:00Z', uninstall: false, paused: false, enabled: true }
  assert.deepEqual(health(d, now), { label: 'active', tone: 'ok' })
  assert.equal(health({ ...d, last_checkin_at: null }, now).label, 'awaiting first check-in')
  // Silence outranks every desired state, so a paused laptop that stops reporting still shows as stale.
  assert.deepEqual(health({ ...d, paused: true, last_checkin_at: '2026-11-17T11:40:00Z' }, now), { label: 'stale (possible tamper)', tone: 'bad' })
  assert.equal(health({ ...d, paused: true }, now).label, 'paused')
  // Silence that starts at a sign-out is a laptop switched off, as on DESKTOP-J76VGJF.
  const off = { ...d, last_checkin_at: '2026-11-17T08:55:39Z', last_session_event: 'logoff', last_session_at: '2026-11-17T08:56:10Z' }
  assert.deepEqual(health(off, now), { label: 'offline since sign-out', tone: 'off' })
  // Still checking in long after the sign-out, then silent: unexplained. So is a lock.
  assert.equal(health({ ...off, last_checkin_at: '2026-11-17T09:30:00Z' }, now).tone, 'bad')
  assert.equal(health({ ...off, last_session_event: 'lock' }, now).tone, 'bad')
  assert.equal(health({ ...d, enabled: false }, now).tone, 'warn')
})
