import assert from 'node:assert/strict'
import test from 'node:test'
import { api, ApiError, post, withOrg } from './api.ts'

test('API client sends cookie credentials and JSON POST body', async () => {
  const original = globalThis.fetch
  let request: RequestInit | undefined
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/auth/login')
    request = options
    return Response.json({ user: { id: 'test' } })
  }
  try {
    assert.deepEqual(
      await post('/auth/login', {
        email: 'test@example.com',
        password: 'test',
      }),
      { user: { id: 'test' } },
    )
    assert.equal(request?.credentials, 'include')
    assert.equal(request?.method, 'POST')
    assert.equal(
      request?.body,
      JSON.stringify({ email: 'test@example.com', password: 'test' }),
    )
    assert.equal(
      (request?.headers as Record<string, string>)['Content-Type'],
      'application/json',
    )
    assert.ok(request?.signal)
  } finally {
    globalThis.fetch = original
  }
})

test('API errors retain server message and status for session expiry', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () =>
    Response.json({ error: 'Session expired' }, { status: 401 })
  try {
    await assert.rejects(
      api('/auth/me'),
      (error: unknown) =>
        error instanceof ApiError &&
        error.status === 401 &&
        error.message === 'Session expired',
    )
  } finally {
    globalThis.fetch = original
  }
})

test('non-JSON proxy errors are readable', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response('Bad gateway', { status: 502 })
  try {
    await assert.rejects(api('/team'), /Request failed \(502\)/)
  } finally {
    globalThis.fetch = original
  }
})

test('withOrg narrows only when an org is chosen', () => {
  assert.equal(withOrg('/team', ''), '/team')
  assert.equal(withOrg('/team', 'neuskale'), '/team?org=neuskale')
  assert.equal(withOrg('/reports/day?date=2026-11-16', 'quantipeak'), '/reports/day?date=2026-11-16&org=quantipeak')
})
