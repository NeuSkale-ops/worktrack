// Read-only production acceptance, except for an optional existing-account session.
// Supply the SHA-256 from the independently verified candidate.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { windowsRelease, releaseFeed } from '../web/src/windowsRelease.ts'

const base = process.env.WT_DOWNLOAD_BASE
const expected = process.env.WT_DOWNLOAD_SHA256
const email = process.env.WT_ACCEPTANCE_EMAIL
const password = process.env.WT_ACCEPTANCE_PASSWORD
assert(base && new URL(base).protocol === 'https:', 'Set WT_DOWNLOAD_BASE to the approved HTTPS origin')
assert(expected && /^[a-f0-9]{64}$/.test(expected), 'Set the independently verified WT_DOWNLOAD_SHA256')
assert(Boolean(email) === Boolean(password), 'Supply both acceptance credentials or neither')
const origin = new URL(base).origin
const get = (path, options = {}) => fetch(`${origin}${path}`, {
  redirect: 'error',
  signal: AbortSignal.timeout(30000),
  ...options,
})

const page = await get('/')
assert.equal(page.status, 200)
const html = await page.text()
const asset = html.match(/src="([^"]+\.js)"/)
assert(asset, 'Production HTML must reference the actual React bundle')
const bundle = await get(asset[1])
assert.equal(bundle.status, 200)
const source = await bundle.text()
assert(source.includes(releaseFeed), 'Bundle must use the current public release feed')
assert(source.includes('WorkTrack for Windows'))
assert(source.includes('SHA256SUMS'))
assert(!source.includes('/downloads/0.1.5/'), 'Bundle must not retain the stale installer')
assert.equal((await get('/api/health')).status, 200)
assert.equal((await get('/api/auth/me')).status, 401)

const feed = await get(releaseFeed, { cache: 'no-store' })
assert.equal(feed.status, 200)
const release = windowsRelease(await feed.json(), origin)
const file = await get(release.url)
assert.equal(file.status, 200)
assert.match(file.headers.get('content-disposition') || '', /attachment/i)
assert.match(file.headers.get('cache-control') || '', /immutable/i)
const bytes = Buffer.from(await file.arrayBuffer())
assert.equal(bytes.subarray(0, 2).toString(), 'MZ', 'Download must be a Windows executable, not dashboard HTML')
assert.equal(createHash('sha256').update(bytes).digest('hex'), expected)
const sums = await get(release.checksums)
assert.equal(sums.status, 200)
assert((await sums.text()).split('\n').some(line => line.trim() === `${expected}  worktrack-setup.exe`))
for (const path of ['/updates/windows/x86_64/missing.exe', `/updates/windows/x86_64/releases/${release.version}/.private`, `/updates/windows/x86_64/releases/${release.version}/`]) {
  assert.equal((await get(path)).status, 404)
}
console.log(`PASS: anonymous release ${release.version}, deployed bundle, HTTPS installer (${bytes.length} bytes), verified SHA-256 and checksum link`)

let cookie = ''
try {
  if (email && password) {
    const login = await get('/api/auth/login', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    assert.equal(login.status, 200, 'Existing account login must work after web deployment')
    const session = login.headers.get('set-cookie')
    assert(session && /HttpOnly/i.test(session) && /Secure/i.test(session))
    cookie = session.split(';')[0]
    const user = (await login.json()).user
    const me = await get('/api/auth/me', { headers: { Cookie: cookie } })
    assert.equal(me.status, 200)
    assert.equal((await me.json()).id, user.id)
    console.log('PASS: existing account login and authenticated API')
  } else {
    console.log('SKIP: authenticated checks, no acceptance credentials supplied')
  }
} finally {
  if (cookie) {
    const logout = await get('/api/auth/logout', {
      method: 'POST',
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
      body: '{}',
    })
    assert.equal(logout.status, 200, 'Revoke only the acceptance session')
    assert.equal((await get('/api/auth/me', { headers: { Cookie: cookie } })).status, 401)
    console.log('PASS: acceptance session revoked')
  }
}
