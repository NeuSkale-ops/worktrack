import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchMacRelease, macReleaseFeed, macRelease } from './macRelease.ts'

const origin = 'https://worktrack.example'
const path = '/downloads/macos/0.1.6/WorkTrack_0.1.6_aarch64.dmg'
const sha256 = 'ab'.repeat(32)
const manifest = (overrides: Record<string, unknown> = {}) => ({
  version: '0.1.6', architecture: 'aarch64', url: path, sha256, signing: 'ad-hoc', notarized: false, ...overrides,
})

test('Mac preview resolves canonical same-origin installer and adjacent checksums', () => {
  for (const url of [path, origin + path]) {
    assert.deepEqual(macRelease(manifest({ url }), origin), {
      version: '0.1.6', url: path, sha256, checksums: '/downloads/macos/0.1.6/SHA256SUMS',
    })
  }
})

test('rejects malformed versions, URLs, checksums and mismatched preview metadata', () => {
  for (const version of [null, 6, '', '01.1.6', '0.1.6-beta', '0.1.6+build', '../0.1.6', '0.1.6\n']) {
    assert.throws(() => macRelease(manifest({ version }), origin))
  }
  for (const url of [null, 42, '//worktrack.example' + path, 'https://evil.example' + path,
    'https://worktrack.example.evil.test' + path, 'https://user@worktrack.example' + path,
    path + '?download=1', path + '#fragment', path.replaceAll('0.1.6', '0.1.5'),
    path.replace('/macos/', '/macos/other/../'), path.replace('0.1.6', '%30.1.6'),
    path.replace('aarch64', 'x86_64'), path.replace('.dmg', '.zip'), 'javascript:alert(1)']) {
    assert.throws(() => macRelease(manifest({ url }), origin))
  }
  for (const metadata of [{ architecture: 'x86_64' }, { architecture: null }, { signing: 'unsigned' },
    { signing: null }, { notarized: true }, { notarized: 'false' }, { notarized: undefined },
    { sha256: null }, { sha256: 'a'.repeat(63) }, { sha256: 'g'.repeat(64) }, { sha256: sha256 + '\n' }]) {
    assert.throws(() => macRelease(manifest(metadata), origin))
  }
  for (const value of [null, [], {}, { version: '0.1.6' }]) assert.throws(() => macRelease(value, origin))
})

test('Mac feed bypasses cache, refuses redirects and propagates failures', async () => {
  const original = globalThis.fetch
  const signal = new AbortController().signal
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, macReleaseFeed)
      assert.deepEqual(options, { cache: 'no-store', redirect: 'error', signal })
      return Response.json(manifest())
    }
    assert.equal((await fetchMacRelease(origin, signal)).url, path)
    for (const status of [404, 503]) {
      globalThis.fetch = async () => new Response('', { status })
      await assert.rejects(fetchMacRelease(origin, signal), /unavailable/)
    }
    globalThis.fetch = async () => Response.json(manifest({ url: 'https://evil.example' + path }))
    await assert.rejects(fetchMacRelease(origin, signal), /Invalid installer/)
    globalThis.fetch = async () => new Response('not JSON')
    await assert.rejects(fetchMacRelease(origin, signal))
    globalThis.fetch = async () => { throw new DOMException('Aborted', 'AbortError') }
    await assert.rejects(fetchMacRelease(origin, signal), { name: 'AbortError' })
  } finally {
    globalThis.fetch = original
  }
})
