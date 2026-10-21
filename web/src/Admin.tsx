import { useState } from 'react'
import type { FormEvent } from 'react'
import { post } from './api'
import type { User, Worker } from './api'

const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Unable to connect. Please try again.'

/** Mirrors the API rule: owners manage everyone but themselves, managers manage workers. */
export function canManage(actor: User, target: Worker): boolean {
  if (actor.id === target.id) return false
  return actor.role === 'owner' || (actor.role === 'manager' && target.role === 'worker')
}

export function MemberAdmin({ person, onChange }: { person: Worker; onChange: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [resetUrl, setResetUrl] = useState('')
  const name = person.name || person.email
  async function act(path: string, confirmText: string, done: string) {
    if (!confirm(confirmText)) return
    setBusy(true)
    setError('')
    setNote('')
    setResetUrl('')
    try {
      const result = await post<{ url?: string }>(`/users/${encodeURIComponent(person.id)}/${path}`, {})
      if (result.url) setResetUrl(result.url)
      setNote(done)
      onChange()
    } catch (error) {
      setError(message(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <details className="invite member-admin">
      <summary>Manage {name}</summary>
      <div className="block-actions">
        {person.disabled ? (
          <button disabled={busy} onClick={() => void act('enable', `Allow ${name} to sign in again?`, 'Account enabled.')}>
            Enable account
          </button>
        ) : (
          <button className="delete" disabled={busy} onClick={() => void act('disable', `Disable ${name}? They are signed out everywhere, any open session is closed at its last uploaded block, and records are kept.`, 'Account disabled.')}>
            Disable account
          </button>
        )}
        <button disabled={busy || person.disabled} onClick={() => void act('revoke-devices', `Sign ${name} out of every desktop app? They can sign in again.`, 'Desktop sign-ins revoked.')}>
          Sign out desktops
        </button>
        <button disabled={busy || person.disabled} onClick={() => void act('password-reset', `Create a one-time password reset link for ${name}? Any earlier link stops working.`, 'Reset link created.')}>
          Create reset link
        </button>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
      {note && <p role="status" className="muted">{note}</p>}
      {resetUrl && (
        <div className="invite-result">
          <label>
            Private reset link, valid 24 hours
            <input readOnly value={resetUrl} onFocus={(e) => e.currentTarget.select()} />
          </label>
          <p className="muted">Send it directly to {name}. Resetting signs them out everywhere.</p>
        </div>
      )}
    </details>
  )
}

export function PasswordForm() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const fields = new FormData(form)
    setBusy(true)
    setError('')
    setDone(false)
    try {
      await post('/auth/password', {
        current_password: String(fields.get('current')),
        new_password: String(fields.get('next')),
      })
      form.reset()
      setDone(true)
    } catch (error) {
      setError(message(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <details className="invite">
      <summary>Change password</summary>
      <form onSubmit={submit}>
        <label>
          Current password
          <input type="password" name="current" autoComplete="current-password" required />
        </label>
        <label>
          New password
          <input type="password" name="next" autoComplete="new-password" minLength={12} required />
        </label>
        <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
      </form>
      {error && <p role="alert" className="error">{error}</p>}
      {done && <p role="status" className="muted">Password changed. Other browsers and desktop apps were signed out.</p>}
    </details>
  )
}

export function ResetPassword({ token, onDone }: { token: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await post('/auth/reset-password', { token, password: String(new FormData(event.currentTarget).get('password')) })
      history.replaceState(null, '', '/')
      onDone()
    } catch (error) {
      setError(message(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit}>
      <h2>Choose a new password</h2>
      <p className="muted">This link works once. Every existing sign-in is ended.</p>
      <label>
        New password
        <input type="password" name="password" autoComplete="new-password" minLength={12} required />
      </label>
      <p className="muted">Use at least 12 characters.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? 'Please wait…' : 'Set password'}</button>
    </form>
  )
}
