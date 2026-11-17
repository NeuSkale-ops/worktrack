import { useState } from 'react'
import type { FormEvent } from 'react'
import { post } from './api'
import type { Invite, Org, User, Worker } from './api'

const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Unable to connect. Please try again.'

/** Mirrors the API rule: owners manage everyone but themselves, managers manage workers. */
export function canManage(actor: User, target: Worker): boolean {
  if (actor.id === target.id) return false
  return actor.role === 'owner' || (actor.role === 'manager' && target.role === 'worker')
}

/** Access controls for one person: reset link, desktop sign-ins, disable or enable. */
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
    <div className="member-admin">
      <div className="option">
        <div><b>Reset link</b><p className="muted">One-time link, valid 24 hours. Using it signs them out everywhere.</p></div>
        <button disabled={busy || person.disabled} onClick={() => void act('password-reset', `Create a one-time password reset link for ${name}? Any earlier link stops working.`, 'Reset link created.')}>
          Create reset link
        </button>
      </div>
      <div className="option">
        <div><b>Desktop sign-ins</b><p className="muted">Signs them out of every desktop app. They can sign in again.</p></div>
        <button disabled={busy || person.disabled} onClick={() => void act('revoke-devices', `Sign ${name} out of every desktop app? They can sign in again.`, 'Desktop sign-ins revoked.')}>
          Sign out desktops
        </button>
      </div>
      <div className="option">
        {person.disabled ? (
          <>
            <div><b>Account is disabled</b><p className="muted">Records are kept. Enabling lets them sign in again.</p></div>
            <button disabled={busy} onClick={() => void act('enable', `Allow ${name} to sign in again?`, 'Account enabled.')}>
              Enable account
            </button>
          </>
        ) : (
          <>
            <div><b>Disable account</b><p className="muted">Signs them out everywhere and closes any open session at its last uploaded block. Records are kept.</p></div>
            <button className="delete" disabled={busy} onClick={() => void act('disable', `Disable ${name}? They are signed out everywhere, any open session is closed at its last uploaded block, and records are kept.`, 'Account disabled.')}>
              Disable account
            </button>
          </>
        )}
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
    </div>
  )
}

export function InviteForm({ user, orgs, org }: { user: User; orgs: Org[]; org: string }) {
  const [invite, setInvite] = useState<Invite | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    setBusy(true)
    setError('')
    setInvite(null)
    setCopied(false)
    try {
      setInvite(
        await post<Invite>('/invites', {
          email: fields.get('email'),
          role: fields.get('role') ?? 'worker',
          org_id: fields.get('org') ?? '',
        }),
      )
    } catch (error) {
      setError(message(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="invite">
      <form onSubmit={submit}>
        <label>
          Email
          <input name="email" type="email" required placeholder="name@company.com" />
        </label>
        {user.role === 'owner' && (
          <label>
            Role
            <select name="role" defaultValue="worker">
              <option value="worker">Worker</option>
              <option value="manager">Manager</option>
            </select>
          </label>
        )}
        {user.role === 'owner' ? (
          <label>
            Organisation
            <select name="org" defaultValue={org}>
              <option value="">Unassigned (assign later)</option>
              {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
        ) : (
          <p className="muted">Joins {orgs.find(o => o.id === user.org_id)?.name ?? 'your organisation'}.</p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create invite link'}
        </button>
      </form>
      {error && <p role="alert" className="error">{error}</p>}
      {invite && (
        <div className="invite-result">
          <label>
            Share this private invitation
            <input readOnly value={invite.url} onFocus={(e) => e.currentTarget.select()} />
          </label>
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(invite.url)
                setCopied(true)
              } catch {
                setError('Copy the link from the field above.')
              }
            }}
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
          <p className="muted">
            Expires {new Date(invite.expires_at).toLocaleString()}. Send this
            link directly to the person.
          </p>
        </div>
      )}
    </div>
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
    <div className="invite">
      <form onSubmit={submit}>
        <label>
          Current password
          <input type="password" name="current" autoComplete="current-password" required />
        </label>
        <label>
          New password
          <input type="password" name="next" autoComplete="new-password" minLength={12} required />
        </label>
        <p className="muted">Use at least 12 characters. Changing it signs out your other browsers and desktop apps.</p>
        <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
      </form>
      {error && <p role="alert" className="error">{error}</p>}
      {done && <p role="status" className="muted">Password changed. Other browsers and desktop apps were signed out.</p>}
    </div>
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
      {error && <p role="alert" className="error">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Set password'}</button>
    </form>
  )
}
