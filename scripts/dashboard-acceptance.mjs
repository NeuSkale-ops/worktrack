// Browser journey through the real production web image and API. Requires playwright-core and
// a local Chrome; run via scripts/container-acceptance.sh with WT_BROWSER=1.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright-core'
const base = process.env.WT_TEST_BASE
const email = process.env.WT_TEST_OWNER_EMAIL
const password = process.env.WT_TEST_OWNER_PASSWORD
assert(base && email && password && ['localhost', '127.0.0.1'].includes(new URL(base).hostname))
let cookie = ''
async function api(path, body, token, expected = 200) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : { Origin: base, Cookie: cookie }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  assert.equal(response.status, expected, `${path}: ${text}`)
  if (!token && response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0]
  return text ? JSON.parse(text) : null
}
await api('/api/auth/login', { email, password })
// One worker tracking now with two 10-minute runs, one stopped worker with a single run.
const names = [`Ribbon Live ${randomUUID().slice(0, 4)}`, `Ribbon Done ${randomUUID().slice(0, 4)}`]
const seeded = []
for (const [index, name] of names.entries()) {
  const workerEmail = `ribbon-${randomUUID()}@example.test`
  const invite = await api('/api/invites', { email: workerEmail, role: 'worker' }, undefined, 201)
  await api('/api/auth/accept-invite', { token: invite.token, name, password })
  const login = await api('/api/auth/login', { email: workerEmail, password, device_name: 'Browser acceptance PC' })
  const token = login.device_token
  const session = randomUUID()
  const end = Math.floor((Date.now() - 60_000) / 60_000) * 60_000
  const start = end - 40 * 60_000
  await api('/api/sessions/start', { id: session, started_at: new Date(start).toISOString() }, token)
  const runs = index === 0 ? [[start, start + 600_000], [end - 600_000, end]] : [[start, start + 600_000]]
  for (const [from, to] of runs) await api('/api/blocks', { blocks: [{ id: randomUUID(), session_id: session, start_at: new Date(from).toISOString(), end_at: new Date(to).toISOString(), active_seconds: 300 }] }, token)
  if (index === 0) await api('/api/heartbeat', {}, token)
  else await api('/api/sessions/stop', { id: session, stopped_at: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString() }, token)
  seeded.push({ name, email: workerEmail, token, runs: runs.length, live: index === 0 })
}
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--ignore-certificate-errors'] })
try {
  for (const width of [1440, 375]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, ignoreHTTPSErrors: true })
    await page.goto(base)
    await page.getByLabel('Email address').fill(email)
    await page.getByLabel('Password').fill(password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.getByRole('heading', { name: /Team (today|on this day)/ }).waitFor()
    const ribbons = page.locator('.rrow')
    for (const worker of seeded) {
      const row = ribbons.filter({ hasText: worker.name })
      await row.waitFor()
      assert.equal(await row.locator('.seg').count(), worker.runs, `${worker.name} ribbon segments`)
      assert.equal(await row.locator('.seg.now').count(), worker.live ? 1 : 0, `${worker.name} live segment`)
      assert.match(await row.innerText(), worker.live ? /Working now/ : /Not tracking now/)
      assert.match(await row.locator('.tot').innerText(), /0h 20m|0h 10m/)
    }
    await ribbons.filter({ hasText: seeded[0].name }).click()
    await page.getByRole('heading', { name: new RegExp(seeded[0].name) }).waitFor()
    // Selection clears and refetches; wait for the selected worker's tiles rather than a busy flag.
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 2, null, { timeout: 15000 })
    assert.equal(await page.locator('.tile').count(), 2, 'selected worker shows both blocks')
    assert.match(await page.locator('[aria-labelledby="day-heading"]').innerText(), /0h 20m tracked, 50% input activity/)
    assert((await page.locator('.hourgrp h3').count()) >= 1)
    const week = page.locator('[aria-labelledby="week-heading"] tbody tr').filter({ hasText: seeded[0].name })
    assert.match(await week.locator('td.total').innerText(), /0h 20m/)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    assert(overflow <= 0, `no horizontal overflow at ${width}px`)
    if (process.env.WT_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.WT_SCREENSHOT_DIR}/dashboard-${width}.png`, fullPage: true })
    await page.close()
  }
  // Worker sees no team ribbon and only their own day.
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true })
  await page.goto(base)
  await page.getByLabel('Email address').fill(seeded[1].email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByRole('heading', { name: /Your day/ }).waitFor()
  await page.waitForFunction(() => document.querySelectorAll('.tile').length === 1)
  assert.equal(await page.locator('.rrow').count(), 0, 'worker has no team ribbon')
} finally {
  await browser.close()
}
console.log('PASS: real dashboard image in Chrome: owner ribbons per worker (live/stopped, segments, totals), selection loads that day, timesheet totals, no overflow at 1440/375px, worker sees only own day')
