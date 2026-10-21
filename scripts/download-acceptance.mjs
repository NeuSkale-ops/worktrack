// Read-only production acceptance, except for creating and revoking its own login session.
// Supply an existing account and the SHA-256 from the independently verified candidate.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const base = process.env.WT_DOWNLOAD_BASE
const expected = process.env.WT_DOWNLOAD_SHA256
const email = process.env.WT_ACCEPTANCE_EMAIL
const password = process.env.WT_ACCEPTANCE_PASSWORD
assert(base && new URL(base).protocol === 'https:', 'Set WT_DOWNLOAD_BASE to the approved HTTPS origin')
assert(expected && /^[a-f0-9]{64}$/.test(expected), 'Set the independently verified WT_DOWNLOAD_SHA256')
assert(email && password, 'Supply the existing acceptance account through environment variables')
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
assert(source.includes('/downloads/0.1.2/WorkTrack_0.1.2_x64-setup.exe'))
assert(source.includes('Download for Windows 64-bit'))
assert(source.includes('/downloads/0.1.2/SHA256SUMS'))
assert.equal((await get('/api/health')).status, 200)
assert.equal((await get('/api/auth/me')).status, 401)

let cookie = ''
try {
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
  console.log('PASS: deployed React download entry point, existing account login and authenticated API')

  const file = await get('/downloads/0.1.2/WorkTrack_0.1.2_x64-setup.exe')
  assert.equal(file.status, 200)
  assert.match(file.headers.get('content-disposition') || '', /attachment/i)
  assert.match(file.headers.get('cache-control') || '', /immutable/i)
  const bytes = Buffer.from(await file.arrayBuffer())
  assert.equal(bytes.subarray(0, 2).toString(), 'MZ', 'Download must be an actual Windows executable, not dashboard HTML')
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected)
  const sums = await get('/downloads/0.1.2/SHA256SUMS')
  assert.equal(sums.status, 200)
  assert.equal((await sums.text()).trim(), `${expected}  WorkTrack_0.1.2_x64-setup.exe`)
  for (const path of ['/downloads/missing.exe', '/downloads/0.1.2/.private', '/downloads/0.1.2/']) {
    assert.equal((await get(path)).status, 404)
  }
  console.log(`PASS: anonymous HTTPS installer download (${bytes.length} bytes), exact verified SHA-256, checksum link, hidden/missing/listing 404`)
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
