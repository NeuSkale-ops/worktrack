import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchWindowsRelease, releaseFeed, windowsRelease } from './windowsRelease.ts'

const origin = 'https://worktrack.example'
const path = '/updates/windows/x86_64/releases/0.1.6/worktrack-setup.exe'
const manifest = (url: unknown = origin + path, version: unknown = '0.1.6') => ({ version, platforms: { 'windows-x86_64': { url } } })

test('stable release resolves only canonical same-origin installer and adjacent checksums', () => {
  for (const url of [path, origin + path]) {
    assert.deepEqual(windowsRelease(manifest(url), origin), {
      version: '0.1.6', url: path, checksums: path.replace('worktrack-setup.exe', 'SHA256SUMS'),
    })
  }
})

test('rejects malformed, prerelease, mismatched and untrusted release metadata', () => {
  for (const version of [null, 6, '', '01.1.6', '0.1.6-beta', '0.1.6+build', '../0.1.6']) {
    assert.throws(() => windowsRelease(manifest(path, version), origin))
  }
  for (const url of [null, 42, '//worktrack.example' + path, 'https://evil.example' + path,
    'https://worktrack.example.evil.test' + path, 'https://user@worktrack.example' + path,
    path + '?download=1', path + '#fragment', path.replace('0.1.6', '0.1.5'),
    path.replace('/releases/', '/releases/other/../'), path.replace('0.1.6', '%30.1.6'),
    path.replace('worktrack-setup.exe', 'other.exe'), 'javascript:alert(1)']) {
    assert.throws(() => windowsRelease(manifest(url), origin))
  }
  for (const value of [null, [], {}, { version: '0.1.6' }]) assert.throws(() => windowsRelease(value, origin))
})

test('public feed fetch bypasses cache, refuses redirects and propagates failures', async () => {
  const original = globalThis.fetch
  const signal = new AbortController().signal
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, releaseFeed)
      assert.deepEqual(options, { cache: 'no-store', redirect: 'error', signal })
      return Response.json(manifest())
    }
    assert.equal((await fetchWindowsRelease(origin, signal)).url, path)
    for (const status of [404, 503]) {
      globalThis.fetch = async () => new Response('', { status })
      await assert.rejects(fetchWindowsRelease(origin, signal), /unavailable/)
    }
    globalThis.fetch = async () => Response.json(manifest('https://evil.example' + path))
    await assert.rejects(fetchWindowsRelease(origin, signal), /Invalid installer/)
    globalThis.fetch = async () => new Response('not JSON')
    await assert.rejects(fetchWindowsRelease(origin, signal))
  } finally {
    globalThis.fetch = original
  }
})
