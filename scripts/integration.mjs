// Run only against an isolated test instance with disposable data.
// WT_TEST_BASE, WT_TEST_OWNER_EMAIL and WT_TEST_OWNER_PASSWORD must be supplied.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.WT_TEST_BASE;
const email = process.env.WT_TEST_OWNER_EMAIL;
const password = process.env.WT_TEST_OWNER_PASSWORD;
assert(base && email && password, 'Set WT_TEST_BASE, WT_TEST_OWNER_EMAIL, WT_TEST_OWNER_PASSWORD');
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname), 'Integration test is restricted to localhost');
let cookie = '';
async function request(path, { method = 'GET', body, token, browser = false, status = 200 } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(browser ? { Origin: process.env.APP_ORIGIN || 'http://localhost:5173', ...(cookie ? { Cookie: cookie } : {}) } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  assert.equal(response.status, status, `${method} ${path}: ${text}`);
  if (browser && response.headers.has('set-cookie')) {
    const setCookie = response.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/i, 'Session cookie must not be readable by browser scripts');
    assert.match(setCookie, /SameSite=Strict/i, 'Session cookie must restrict cross-site requests');
    if (new URL(base).protocol === 'https:') assert.match(setCookie, /Secure/i, 'Production HTTPS session cookie must be Secure');
    cookie = setCookie.split(';')[0];
  }
  return response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text;
}

await request('/api/health');
await request('/api/team', { status: 401 });
const owner = await request('/api/auth/login', { method: 'POST', browser: true, body: { email, password } });
assert(owner.user.id);
assert(cookie, 'Browser login must set a session cookie');
const suffix = randomUUID();
const invite = await request('/api/invites', { method: 'POST', browser: true, status: 201, body: { email: `worker-${suffix}@example.test`, role: 'worker' } });
assert(invite.token);
await request('/api/auth/accept-invite', { method: 'POST', browser: true, body: { token: invite.token, name: 'Integration worker', password } });
const worker = await request('/api/auth/login', { method: 'POST', body: { email: `worker-${suffix}@example.test`, password, device_name: 'Integration device' } });
assert(worker.device_token);
const token = worker.device_token;
await request('/api/invites', { method: 'POST', token, body: { email: 'forbidden@example.test', role: 'manager' }, status: 403 });
await request(`/api/timeline?user=${owner.user.id}&date=${new Date().toISOString().slice(0, 10)}`, { token, status: 403 });
const sessionID = randomUUID();
const start = new Date(Math.floor((Date.now() - 120_000) / 1000) * 1000);
const end = new Date(start.getTime() + 60_000);
await request('/api/sessions/start', { method: 'POST', token, body: { id: sessionID, started_at: start.toISOString() } });
await request('/api/heartbeat', { method: 'POST', token, body: {} });
if (process.env.WT_TEST_R2_CONFIG === 'true') {
  const upload = await request('/api/uploads/screenshot-url', { method: 'POST', token, body: { block_id: randomUUID(), content_type: 'image/jpeg', size_bytes: 128 } });
  const signed = new URL(upload.upload_url);
  assert.equal(signed.hostname, 'r2-fixture.invalid');
  assert(signed.pathname.startsWith('/acceptance-screenshots/'));
  assert(signed.searchParams.get('X-Amz-Credential').startsWith('fixture-r2-key/'));
  assert(signed.searchParams.get('X-Amz-Credential').includes('/auto/s3/'));
  console.log('PASS: production R2-prefixed settings produce bucket-scoped signed URL with explicit R2 key and auto region (no live upload)');
}
const block = { id: randomUUID(), session_id: sessionID, start_at: start.toISOString(), end_at: end.toISOString(), active_seconds: 30 };
await request('/api/blocks', { method: 'POST', token, body: { blocks: [block] } });
await request('/api/blocks', { method: 'POST', token, body: { blocks: [block] } });
await request('/api/blocks', { method: 'POST', token, body: { blocks: [{ ...block, active_seconds: 31 }] }, status: 409 });
await request('/api/blocks', { method: 'POST', token, body: { blocks: [{ ...block, id: randomUUID(), active_seconds: 999 }] }, status: 400 });
await request('/api/sessions/stop', { method: 'POST', token, body: { id: sessionID, stopped_at: end.toISOString() } });
const date = start.toISOString().slice(0, 10);
const timeline = await request(`/api/timeline?user=${worker.user.id}&date=${date}`, { browser: true });
assert.equal(timeline.filter(row => row.id === block.id).length, 1, 'Retry must not duplicate a block');
assert.equal(timeline.find(row => row.id === block.id).duration_seconds, 60);
const report = await request(`/api/reports/hours?from=${date}&to=${date}`, { browser: true });
assert.equal(report.find(row => row.user_id === worker.user.id).seconds, 60);
const csv = await request(`/api/reports/hours.csv?from=${date}&to=${date}`, { browser: true });
assert(csv.includes('Integration worker'));
await request(`/api/blocks/${block.id}/screenshot`, { method: 'DELETE', token });
const afterScreenshotDelete = await request(`/api/reports/hours?from=${date}&to=${date}`, { token });
assert.equal(afterScreenshotDelete.find(row => row.user_id === worker.user.id).seconds, 60, 'Deleting a screenshot must preserve tracked hours');
await request(`/api/blocks/${block.id}`, { method: 'DELETE', token });
const afterTimeDelete = await request(`/api/timeline?user=${worker.user.id}&date=${date}`, { token });
assert.equal(afterTimeDelete.length, 0, 'Explicit time deletion must remove the block');
await request('/api/auth/logout', { method: 'POST', token, body: {} });
await request('/api/auth/me', { token, status: 401 });
console.log('PASS: real HTTP + PostgreSQL auth, invites, roles, tracking, idempotency, totals, CSV, screenshot/time deletion and token revocation');
