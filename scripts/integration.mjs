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
const diagnostic = { id: randomUUID(), occurred_at: new Date().toISOString(), code: 'sync_failed', status: 503 };
const diagnosticBody = { version: '0.1.2', events: [diagnostic] };
await request('/api/agent/logs', { method: 'POST', token, body: diagnosticBody });
await request('/api/agent/logs', { method: 'POST', token, body: diagnosticBody });
await request('/api/agent/logs', { token, status: 403 });
const diagnostics = await request('/api/agent/logs', { browser: true });
assert.equal(diagnostics.filter(row => row.id === diagnostic.id && row.user_id === worker.user.id).length, 1);
assert.equal(diagnostics.find(row => row.id === diagnostic.id).message, 'Tracking data could not be synced.');
assert.equal(diagnostics.find(row => row.id === diagnostic.id).status, 503);
await request('/api/agent/logs', { method: 'POST', token, body: { ...diagnosticBody, events: [{ ...diagnostic, message: 'Bearer must-not-store' }] }, status: 400 });
console.log('PASS: real diagnostic ingestion, retry deduplication, owner-only reads and free-form text rejection');
await request('/api/invites', { method: 'POST', token, body: { email: 'forbidden@example.test', role: 'manager' }, status: 403 });
await request(`/api/timeline?user=${owner.user.id}&date=${new Date().toISOString().slice(0, 10)}`, { token, status: 403 });
const sessionID = randomUUID();
const start = new Date(Math.floor((Date.now() - 120_000) / 60_000) * 60_000);
const end = new Date(start.getTime() + 60_000);
await request('/api/sessions/start', { method: 'POST', token, body: { id: sessionID, started_at: start.toISOString() } });
const currentSession = await request('/api/sessions/current', { token });
assert.equal(currentSession.id, sessionID);
assert.equal(currentSession.recoverable, false);
await request('/api/sessions/recover', { method: 'POST', token, body: { id: sessionID }, status: 409 });
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
const block = { id: randomUUID(), session_id: sessionID, start_at: start.toISOString(), end_at: end.toISOString(), active_seconds: 30, application_usage: [{ app: 'chrome.exe', milliseconds: 45000 }, { app: 'code.exe', milliseconds: 15000 }] };
await request('/api/blocks', { method: 'POST', token, body: { blocks: [block] } });
await request('/api/blocks', { method: 'POST', token, body: { blocks: [block] } });
await request('/api/blocks', { method: 'POST', token, body: { blocks: [{ ...block, active_seconds: 31 }] }, status: 409 });
await request('/api/blocks', { method: 'POST', token, body: { blocks: [{ ...block, id: randomUUID(), active_seconds: 999 }] }, status: 400 });
await request('/api/sessions/stop', { method: 'POST', token, body: { id: sessionID, stopped_at: end.toISOString() } });
assert.equal(await request('/api/sessions/current', { token }), null);
const date = start.toISOString().slice(0, 10);
const timeline = await request(`/api/timeline?user=${worker.user.id}&date=${date}`, { browser: true });
assert.equal(timeline.filter(row => row.id === block.id).length, 1, 'Retry must not duplicate a block');
assert.equal(timeline.find(row => row.id === block.id).duration_seconds, 60);
assert.deepEqual(timeline.find(row => row.id === block.id).application_usage, block.application_usage);
assert.equal(timeline.find(row => row.id === block.id).location, null);
await request('/api/blocks', { method: 'POST', token, body: { blocks: [{ ...block, application_usage: [{ app: 'C:\\private\\app.exe', milliseconds: 1000 }] }] }, status: 400 });
await request('/api/blocks', { method: 'POST', token, body: { blocks: [{ ...block, application_usage: [{ app: 'chrome.exe', milliseconds: 60001 }] }] }, status: 400 });
console.log('PASS: foreground application usage persists with blocks, full paths and excess duration rejected, legacy location omitted');
const report = await request(`/api/reports/hours?from=${date}&to=${date}`, { browser: true });
assert.equal(report.find(row => row.user_id === worker.user.id).seconds, 60);
// Local-day reports: the same 60s block lands on its Asia/Kolkata calendar date.
const istDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(start);
const istReport = await request(`/api/reports/hours?from=${istDate}&to=${istDate}&tz=Asia/Kolkata`, { browser: true });
assert.equal(istReport.find(row => row.user_id === worker.user.id)?.seconds, 60, 'tz report must count the block on its local date');
await request(`/api/reports/hours?from=${date}&to=${date}&tz=Not/AZone`, { browser: true, status: 400 });
console.log('PASS: tz=Asia/Kolkata report through production image (embedded tzdata) and invalid zone rejected');
// Team ribbon source: owner sees the worker's span, the worker sees only their own, no screenshot URLs.
const ownerDay = await request(`/api/reports/day?date=${istDate}&tz=Asia/Kolkata`, { browser: true });
const span = ownerDay.find(row => row.user_id === worker.user.id);
assert(span && Date.parse(span.end_at) - Date.parse(span.start_at) === 60_000, 'owner day report must include the worker block');
assert(!JSON.stringify(ownerDay).includes('X-Amz'), 'day report must not sign screenshot URLs');
const workerDay = await request(`/api/reports/day?date=${istDate}&tz=Asia/Kolkata`, { token });
assert(workerDay.length >= 1 && workerDay.every(row => row.user_id === worker.user.id), 'workers see only their own spans');
await request(`/api/reports/day?date=${istDate}&tz=Not/AZone`, { browser: true, status: 400 });
console.log('PASS: /api/reports/day returns visible spans per role through production image');
const csv = await request(`/api/reports/hours.csv?from=${date}&to=${date}`, { browser: true });
assert(csv.includes('Integration worker'));
// Workers see hours only: no timeline, and no deleting of screenshots or time.
await request(`/api/timeline?user=${worker.user.id}&date=${date}`, { token, status: 403 });
await request(`/api/blocks/${block.id}/screenshot`, { method: 'DELETE', token, status: 403 });
await request(`/api/blocks/${block.id}`, { method: 'DELETE', token, status: 403 });
const afterRefusedDelete = await request(`/api/reports/hours?from=${date}&to=${date}`, { token });
assert.equal(afterRefusedDelete.find(row => row.user_id === worker.user.id).seconds, 60, 'A refused worker delete must keep tracked hours');
console.log('PASS: worker is refused the timeline and both deletes, and keeps reading their own hours');
await request('/api/auth/logout', { method: 'POST', token, body: {} });
await request('/api/auth/me', { token, status: 401 });
// Account lifecycle through the public API.
const workerEmail = `worker-${suffix}@example.test`;
const device = (await request('/api/auth/login', { method: 'POST', body: { email: workerEmail, password, device_name: 'Lifecycle device' } })).device_token;
const revoked = await request(`/api/users/${worker.user.id}/revoke-devices`, { method: 'POST', browser: true, body: {} });
assert.equal(revoked.revoked, 1);
await request('/api/auth/me', { token: device, status: 401 });
const reset = await request(`/api/users/${worker.user.id}/password-reset`, { method: 'POST', browser: true, body: {}, status: 201 });
assert(reset.url.startsWith(`${process.env.APP_ORIGIN || base}/reset?token=`), reset.url);
await request('/api/auth/reset-password', { method: 'POST', browser: true, body: { token: reset.token, password: 'acceptance-reset-password' } });
await request('/api/auth/reset-password', { method: 'POST', browser: true, body: { token: reset.token, password: 'acceptance-reset-password2' }, status: 400 });
await request('/api/auth/login', { method: 'POST', body: { email: workerEmail, password, device_name: 'old' }, status: 401 });
const renewed = (await request('/api/auth/login', { method: 'POST', body: { email: workerEmail, password: 'acceptance-reset-password', device_name: 'new' } })).device_token;
await request(`/api/users/${worker.user.id}/disable`, { method: 'POST', browser: true, body: {} });
await request('/api/auth/me', { token: renewed, status: 401 });
await request('/api/auth/login', { method: 'POST', body: { email: workerEmail, password: 'acceptance-reset-password', device_name: 'x' }, status: 401 });
assert.equal((await request('/api/team', { browser: true })).find(p => p.id === worker.user.id).disabled, true);
await request(`/api/users/${owner.user.id}/disable`, { method: 'POST', browser: true, body: {}, status: 403 });
await request(`/api/users/${worker.user.id}/enable`, { method: 'POST', browser: true, body: {} });
await request('/api/auth/login', { method: 'POST', body: { email: workerEmail, password: 'acceptance-reset-password', device_name: 'back' } });
const rejectedLog = { id: randomUUID(), occurred_at: new Date().toISOString(), code: 'sync_rejected', status: 409 };
const back = (await request('/api/auth/login', { method: 'POST', body: { email: workerEmail, password: 'acceptance-reset-password', device_name: 'logs' } })).device_token;
await request('/api/agent/logs', { method: 'POST', token: back, body: { version: '0.1.6', events: [rejectedLog] } });
console.log('PASS: device revocation, single-use reset link, disable/enable lockout, owner self-protection and sync_rejected log code (migration 003)');
console.log('PASS: real HTTP + PostgreSQL auth, invites, roles, tracking, idempotency, totals, CSV, screenshot/time deletion and token revocation');
