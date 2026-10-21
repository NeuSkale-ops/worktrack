import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import './style.css';

type Status = { authenticated: boolean; tracking: boolean; paused: boolean; elapsed: number; next_capture: number; queued: number; error: string | null; server: string };
function App() {
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState('');
  const [renew, setRenew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false);
  async function refresh() { try { setStatus(await invoke<Status>('status')); } catch (e) { setError(String(e)); } }
  useEffect(() => { void refresh(); const id = setInterval(() => void refresh(), 1000); return () => clearInterval(id); }, []);
  async function run(command: string, args?: Record<string, unknown>) {
    setBusy(true); setError('');
    try { await invoke(command, args); if (command === 'login') setRenew(false); await refresh(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  const elapsed = status?.elapsed ?? 0;
  return <main>
    <header><span className="mark">W</span><div><h1>WorkTrack</h1><p>Your time. Clearly recorded.</p></div></header>
    <section className="disclosure"><h2>What monitoring means</h2><p>Only while you choose Start, WorkTrack measures elapsed time and input activity, and takes a compressed screenshot of your primary display at each exact 10-minute elapsed boundary. No random captures.</p><p>No typed text, keys, window titles, or websites are recorded. Locking or suspending pauses monitoring. Stop ends all collection. Queued records may still upload while stopped.</p><p>Screenshots can contain private information. Close private content before starting. This app remains visible in the tray and never starts tracking automatically.</p></section>
    {!status?.authenticated || renew ? <form onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); void run('login', { email: data.get('email'), password: data.get('password') }); }}>
      <p>Connected to your WorkTrack workspace. Sign in with the account created from your invitation.</p>
      <label>Email<input name="email" type="email" autoComplete="username" required /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
      <button disabled={busy}>Sign in</button>
    </form> : <section className="timer">
      <p className={status.tracking ? 'live' : ''}>{status.tracking ? status.paused ? 'PAUSED - SCREEN LOCKED / SUSPENDED' : 'TRACKING ON' : 'TRACKING OFF'}</p>
      <output>{Math.floor(elapsed / 3600).toString().padStart(2, '0')}:{Math.floor(elapsed / 60 % 60).toString().padStart(2, '0')}:{Math.floor(elapsed % 60).toString().padStart(2, '0')}</output>
      {status.tracking ? <p>Next screenshot in {Math.ceil(status.next_capture)} elapsed seconds</p> : <label className="consent"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />I understand and agree to the monitoring described above.</label>}
      <button className={status.tracking ? 'stop' : ''} disabled={busy || (!status.tracking && !consent)} onClick={() => void run(status.tracking ? 'stop' : 'start', { consent })}>{status.tracking ? 'Stop tracking' : 'Start tracking'}</button>
      <p>{status.queued} records waiting to sync</p><button className="secondary" disabled={busy || status.tracking} onClick={() => setRenew(true)}>Renew sign-in</button><button className="secondary" disabled={busy || status.tracking || status.queued > 0} onClick={() => void run('logout')}>Sign out</button>
    </section>}
    {(error || status?.error) && <p role="alert" className="error">{error || status?.error}</p>}
    <footer>Closing the window stops tracking. Use the tray to reopen.</footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
