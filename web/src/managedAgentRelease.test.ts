import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { managedAgentRelease } from './managedAgentRelease.ts'

const sha256 = 'ab'.repeat(32)

test('resolves the versioned same-origin zip', () => {
  assert.deepEqual(managedAgentRelease({ version: '0.1.0', sha256 }), {
    version: '0.1.0', url: '/managed-agent/worktrack-managed-agent-0.1.0.zip', sha256,
  })
})

test('rejects malformed versions and checksums', () => {
  for (const version of [null, 1, '', '01.1.0', '0.1.0-beta', '../0.1.0', '0.1.0\n']) {
    assert.throws(() => managedAgentRelease({ version, sha256 }))
  }
  for (const bad of [null, 'a'.repeat(63), 'G'.repeat(64), sha256 + '\n']) {
    assert.throws(() => managedAgentRelease({ version: '0.1.0', sha256: bad }))
  }
  for (const value of [null, [], {}, '<!doctype html>']) assert.throws(() => managedAgentRelease(value))
})

test('the committed manifest is valid', () => {
  managedAgentRelease(JSON.parse(readFileSync(new URL('../public/managed-agent/latest.json', import.meta.url), 'utf8')))
})
