// Exercise real public Mac download bytes and cache/attachment behavior on Node 22+.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { macRelease, macReleaseFeed } from '../web/src/macRelease.ts'
const base = process.env.WT_DOWNLOAD_BASE
const expected = process.env.WT_MAC_SHA256
assert(base && expected && /^[a-f0-9]{64}$/.test(expected), 'Set WT_DOWNLOAD_BASE and independently verified WT_MAC_SHA256')
const origin = new URL(base).origin
assert.equal(new URL(base).protocol, 'https:')
const request = path => fetch(`${origin}${path}`, { redirect: 'error', cache: 'no-store' })
const feed = await request(macReleaseFeed)
assert.equal(feed.status, 200)
assert.match(feed.headers.get('cache-control') || '', /no-cache/)
assert.doesNotMatch(feed.headers.get('cache-control') || '', /immutable/)
const release = macRelease(await feed.json(), origin)
assert.equal(release.sha256.toLowerCase(), expected)
const response = await request(release.url)
assert.equal(response.status, 200)
assert.match(response.headers.get('content-disposition') || '', /attachment/i)
assert.match(response.headers.get('cache-control') || '', /immutable/)
const bytes = Buffer.from(await response.arrayBuffer())
assert(bytes.length > 512)
assert.equal(bytes.subarray(bytes.length - 512, bytes.length - 508).toString(), 'koly', 'Real UDIF disk image trailer')
assert.equal(createHash('sha256').update(bytes).digest('hex'), expected)
const checksums = await request(release.checksums)
assert.equal(checksums.status, 200)
const filename = release.url.split('/').at(-1)
assert((await checksums.text()).split('\n').some(line => line === `${expected}  ${filename}` || line === `${expected}  ./${filename}`))
for (const path of ['/downloads/macos/missing.dmg', '/downloads/macos/.hidden', `/downloads/macos/${release.version}/`]) {
  assert.equal((await request(path)).status, 404, path)
}
console.log(`PASS public Mac ${release.version}: exact DMG SHA-256, canonical manifest, attachment/cache headers, checksum file, missing/hidden/listing 404s`)
