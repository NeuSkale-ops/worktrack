import assert from 'node:assert/strict'
import { test } from 'node:test'
import { configError, defaultConfig, parseExcluded, summarize } from './deviceActivity.ts'

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
