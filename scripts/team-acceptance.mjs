// Functional 25-worker journey against the actual local deployment, not a benchmark.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const base = process.env.WT_TEST_BASE;
const email = process.env.WT_TEST_OWNER_EMAIL;
const password = process.env.WT_TEST_OWNER_PASSWORD;
assert(base && email && password, 'Supply disposable local acceptance settings');
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
let cookie = '';
async function api(path, body, token, expected = 200) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : { Origin: base, Cookie: cookie }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.equal(response.status, expected, `${path}: ${text}`);
  if (!token && response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  return response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text;
}
await api('/api/auth/login', { email, password });
const workers = [];
for (let index = 0; index < 25; index++) {
  const workerEmail = `team-${randomUUID()}@example.test`;
  const invite = await api('/api/invites', { email: workerEmail, role: 'worker' }, undefined, 201);
  await api('/api/auth/accept-invite', { token: invite.token, name: `Team acceptance ${index + 1}`, password });
  const login = await api('/api/auth/login', { email: workerEmail, password, device_name: `Fixture PC ${index + 1}` });
  const start = new Date(Math.floor(Date.now() / 1000) * 1000 - 120_000);
  const session = randomUUID();
  const token = login.device_token;
  await api('/api/sessions/start', { id: session, started_at: start.toISOString() }, token);
  await api('/api/blocks', { blocks: [{ id: randomUUID(), session_id: session, start_at: start.toISOString(), end_at: new Date(start.getTime() + 60_000).toISOString(), active_seconds: 20 }] }, token);
  workers.push({ id: login.user.id, token, session, date: start.toISOString().slice(0, 10) });
}
await Promise.all(workers.map(worker => api('/api/heartbeat', {}, worker.token)));
const team = await api('/api/team');
for (const worker of workers) assert.equal(team.find(person => person.id === worker.id)?.working, true);
const from = workers.map(worker => worker.date).sort()[0];
const to = workers.map(worker => worker.date).sort().at(-1);
const hours = await api(`/api/reports/hours?from=${from}&to=${to}`);
for (const worker of workers) assert.equal(hours.filter(row => row.user_id === worker.id).reduce((total, row) => total + row.seconds, 0), 60);
const csv = await api(`/api/reports/hours.csv?from=${from}&to=${to}`);
for (let index = 0; index < 25; index++) assert(csv.includes(`Team acceptance ${index + 1}`));
await Promise.all(workers.map(worker => api('/api/sessions/stop', { id: worker.session, stopped_at: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString() }, worker.token)));
const stoppedTeam = await api('/api/team');
for (const worker of workers) assert.equal(stoppedTeam.find(person => person.id === worker.id)?.working, false);
console.log('PASS: 25 real invited users/device logins, concurrent heartbeats, live team state, exact per-user hours, CSV and stopped state through public HTTPS API');
