import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import './style.css';

type Update = { version: string; current_version: string; body: string | null; date: string | null };
type UpdateStatus = { phase: 'idle' | 'checking' | 'available' | 'downloading' | 'installing' | 'installed' | 'error' | 'unavailable'; downloaded: number; total: number | null; error: string | null };
type Status = { authenticated: boolean; tracking: boolean; paused: boolean; elapsed: number; next_capture: number; queued: number; rejected: number; error: string | null; server: string; update: UpdateStatus; update_reserved: boolean; diagnostics_enabled: boolean; diagnostics_queued: number; diagnostics_error: string | null; location_enabled: boolean; location_pending: boolean; location_error: string | null };
function App() {
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState('');
  const [renew, setRenew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false);
  const [available, setAvailable] = useState<Update | null>(null);
  const [version, setVersion] = useState('');
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [updateError, setUpdateError] = useState('');
  const [unavailable, setUnavailable] = useState('');
  const [deferred, setDeferred] = useState(false);
  const [installing, setInstalling] = useState(false);
  const refreshPending = useRef(false);
  const checkPending = useRef(false);
  const installPending = useRef(false);
  const reserved = useRef(false);
  reserved.current = Boolean(status?.update_reserved) || installing;
  async function checkUpdate() {
    if (checkPending.current || reserved.current) return;
    checkPending.current = true; setChecking(true); setUpdateError(''); setUnavailable(''); setAvailable(null); setChecked(false);
    try {
      const update = await invoke<Update | null>('check_update');
      setAvailable(update); setChecked(true); setDeferred(false);
      if (update) setVersion(update.current_version);
    } catch (e) {
      const message = String(e);
      if (message.startsWith('UPDATER_UNAVAILABLE:')) setUnavailable(message.replace(/^UPDATER_UNAVAILABLE:\s*/, ''));
      else setUpdateError(`Could not check for updates: ${message}. Check your connection and try again. You can keep tracking.`);
    }
    finally { checkPending.current = false; setChecking(false); }
  }
  useEffect(() => {
    void getVersion().then(setVersion).catch(() => {});
    void checkUpdate();
    const id = setInterval(() => void checkUpdate(), 6 * 60 * 60 * 1000);
    return () => clearInterval(id);
  }, []);
  async function refresh() {
    if (refreshPending.current) return;
    refreshPending.current = true;
    try { setStatus(await invoke<Status>('status')); }
    catch (e) { setError(String(e)); }
    finally { refreshPending.current = false; }
  }
  useEffect(() => { void refresh(); const id = setInterval(() => void refresh(), 1000); return () => clearInterval(id); }, []);
  async function run(command: string, args?: Record<string, unknown>) {
    if (reserved.current && !(['set_diagnostics', 'set_location'].includes(command) && args?.enabled === false)) return;
    setBusy(true); setError('');
    try { await invoke(command, args); if (command === 'login') setRenew(false); await refresh(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  async function installUpdate() {
    if (!available || installPending.current || reserved.current || busy || checking) return;
    installPending.current = true; reserved.current = true; setInstalling(true); setUpdateError('');
    try { await invoke('install_update', { version: available.version }); }
    catch (e) { setUpdateError(`Update could not be installed: ${String(e)}. Resolve the issue, then try Update now again.`); }
    finally { await refresh(); installPending.current = false; setInstalling(false); }
  }
  const elapsed = status?.elapsed ?? 0;
  const installReserved = Boolean(status?.update_reserved) || installing;
  const update = status?.update;
  const updateBusy = checking || update?.phase === 'checking';
  const unavailableMessage = unavailable || (update?.phase === 'unavailable' ? update.error?.replace(/^UPDATER_UNAVAILABLE:\s*/, '') : '');
  const updateFailure = updateError || (update?.phase !== 'unavailable' ? update?.error : null);
  const unsafeInstall = !status || status.tracking || status.queued > 0;
  return <main>
    <header><span className="mark">W</span><div><h1>WorkTrack</h1><p>Your time. Clearly recorded.</p></div></header>
    <section className="disclosure"><h2>What monitoring means</h2><p>Only while you choose Start, WorkTrack measures elapsed time, input activity, foreground application names and estimated time in each, and takes a compressed screenshot of your primary display at each exact 10-minute elapsed boundary. No random captures.</p><p>No typed text, keys, window titles, or websites are recorded. Locking or suspending pauses monitoring. Stop ends monitoring collection. Queued records and separately enabled diagnostics may still upload while stopped.</p><p>You, your managers, and the owner can view these work records. No application file paths are sent. Application usage stays with work records until the time block is deleted from the live database. Backups follow separate retention. Screenshots can contain private information. Close private content before starting. This app remains visible in the tray and never starts tracking automatically.</p></section>
    {!status?.authenticated || renew ? <form onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); void run('login', { email: data.get('email'), password: data.get('password') }); }}>
      <p>Connected to your WorkTrack workspace. Sign in with the account created from your invitation.</p>
      <label>Email<input name="email" type="email" autoComplete="username" required disabled={installReserved} /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" required disabled={installReserved} /></label>
      <button disabled={busy || installReserved}>Sign in</button>
    </form> : <section className="timer">
      <p className={status.tracking ? 'live' : ''}>{status.tracking ? status.paused ? 'PAUSED - SCREEN LOCKED / SUSPENDED' : 'TRACKING ON' : 'TRACKING OFF'}</p>
      <output>{Math.floor(elapsed / 3600).toString().padStart(2, '0')}:{Math.floor(elapsed / 60 % 60).toString().padStart(2, '0')}:{Math.floor(elapsed % 60).toString().padStart(2, '0')}</output>
      {status.tracking ? <p>Next screenshot in {Math.ceil(status.next_capture)} elapsed seconds</p> : <label className="consent"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />I understand and agree to the monitoring described above.</label>}
      <button className={status.tracking ? 'stop' : ''} disabled={busy || installReserved || (!status.tracking && !consent)} onClick={() => void run(status.tracking ? 'stop' : 'start', { consent })}>{status.tracking ? 'Stop tracking' : 'Start tracking'}</button>
      <p>{status.queued} records waiting to sync</p>{status.rejected > 0 && <p role="status">{status.rejected} records refused by the server were set aside on this PC. Contact your manager.</p>}<button className="secondary" disabled={busy || installReserved || status.tracking} onClick={() => setRenew(true)}>Renew sign-in</button><button className="secondary" disabled={busy || installReserved || status.tracking || status.queued > 0} onClick={() => void run('logout')}>Sign out</button>
    </section>}
    {(error || status?.error) && <p role="alert" className="error">{error || status?.error}</p>}
    <section className="disclosure" aria-labelledby="location-title">
      <h2 id="location-title">Location with screenshots</h2>
      <p>Optional coordinates, accuracy, and fix time are linked to each screenshot and visible to you, managers, and the owner. Windows may use Wi-Fi or GPS; accuracy varies. No continuous location tracking or IP-based guesses. Deleting a screenshot removes its location from the live database; backups follow separate retention.</p>
      <label><input id="location-consent" type="checkbox" checked={Boolean(status?.location_enabled || status?.location_pending)} disabled={busy || !status?.authenticated || (installReserved && !status?.location_enabled && !status?.location_pending)} onChange={e => void run('set_location', { enabled: e.target.checked })} />Share location with screenshots for this launch</label>
      <p>{status?.location_pending ? 'Waiting for Windows location permission. You can turn this off.' : status?.location_enabled ? 'Location requested only when a screenshot is taken. A denied or unavailable fix does not stop tracking.' : 'Off by default. Sign in and enable sharing to request Windows permission.'}</p>
      {status?.location_error && <p role="status">{status.location_error}</p>}
    </section>
    <section className="disclosure" aria-labelledby="diagnostics-title">
      <h2 id="diagnostics-title">Diagnostic logs for testing</h2>
      <p>Optional error codes, HTTP status, app version, and timestamps are linked to your account and sent to the owner. No error text, screenshots, typed content, passwords, or tokens are included. Logs expire after seven days.</p>
      <label><input id="diagnostic-consent" type="checkbox" checked={Boolean(status?.diagnostics_enabled)} disabled={busy || !status?.authenticated || (installReserved && !status?.diagnostics_enabled)} onChange={e => void run('set_diagnostics', { enabled: e.target.checked })} />Send diagnostic logs for this launch</label>
      <p>Sign in first. Diagnostics can upload while tracking is off. Up to 100 pending events stay in memory and are lost on exit. Turning this off clears pending events; an upload already in progress may finish.</p>
      {status?.diagnostics_enabled && <p role="status">{status.diagnostics_queued} diagnostic events waiting. {status.diagnostics_error || 'Uploads run separately from tracking.'}</p>}
    </section>
    <section className="updater" aria-labelledby="updates-title">
      <h2 id="updates-title">App updates</h2>
      <p>{version ? `Installed version ${version}. ` : ''}Checks at startup and every 6 hours. Updates install only when you choose Update now.</p>
      <div role="status" aria-live="polite">
        {updateBusy && <p>Checking for updates…</p>}
        {!updateBusy && checked && !available && !updateFailure && !unavailableMessage && <p>You are up to date{version ? ` on version ${version}` : ''}.</p>}
        {unavailableMessage && <p>App updates are not available in this build. {unavailableMessage} You can keep tracking normally.</p>}
        {available && <p><strong>Version {available.version} is available.</strong>{deferred ? ' You can update later.' : ''}</p>}
        {installReserved && <p>Update in progress. Tracking and sign-in are unavailable until installation finishes. The app may restart. Tracking will remain off.</p>}
        {update?.phase === 'downloading' && <>
          <label htmlFor="update-progress">Downloading update: {update.total ? `${Math.min(100, Math.round(update.downloaded / update.total * 100))}%` : `${Math.round(update.downloaded / 1024)} KB received`}</label>
          <progress id="update-progress" max={update.total || undefined} value={update.total ? Math.min(update.downloaded, update.total) : undefined} />
        </>}
        {update?.phase === 'installing' && <p>Installing update. Please keep WorkTrack open.</p>}
        {update?.phase === 'installed' && <p>Update installed. Restart WorkTrack if it does not restart automatically.</p>}
      </div>
      {available && !deferred && <>
        <h3>Release notes</h3><p className="release-notes">{available.body || 'No release notes provided.'}</p>
        <p>Stop tracking and wait for all queued records to sync before updating. Your saved sign-in and records are kept.</p>
        {unsafeInstall && <p>Update now is available once tracking is stopped and the sync queue is empty.</p>}
        <div className="update-actions"><button disabled={busy || updateBusy || installReserved || unsafeInstall || update?.phase === 'installed'} onClick={() => void installUpdate()}>Update now</button><button className="secondary" disabled={installReserved} onClick={() => setDeferred(true)}>Later</button></div>
      </>}
      {available && deferred && <button className="secondary" disabled={installReserved} onClick={() => setDeferred(false)}>Show update</button>}
      {updateFailure && <p className="error" role="alert">{updateFailure}</p>}
      <button className="secondary check-update" disabled={updateBusy || installReserved} onClick={() => void checkUpdate()}>Check for updates</button>
    </section>
    <footer>Closing the window stops tracking. Use the tray to reopen.</footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
