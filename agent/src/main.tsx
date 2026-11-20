import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import '@fontsource/barlow/400.css';
import '@fontsource/barlow/500.css';
import '@fontsource/barlow/600.css';
import '@fontsource/barlow-semi-condensed/300.css';
import '@fontsource/barlow-semi-condensed/600.css';
import './style.css';

type Update = { version: string; current_version: string; body: string | null; date: string | null };
type UpdateStatus = { phase: 'idle' | 'checking' | 'available' | 'downloading' | 'installing' | 'installed' | 'error' | 'unavailable'; downloaded: number; total: number | null; error: string | null };
type Status = { platform?: string; screen_capture_allowed?: boolean; authenticated: boolean; tracking: boolean; stopping: boolean; paused: boolean; elapsed: number; next_capture: number; queued: number; rejected: number; error: string | null; server: string; update: UpdateStatus; update_reserved: boolean; diagnostics_enabled: boolean; diagnostics_queued: number; diagnostics_error: string | null; location_enabled: boolean; location_pending: boolean; location_error: string | null };
function App() {
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState('');
  const [statusError, setStatusError] = useState('');
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
      else setUpdateError(`Could not check for updates: ${message}. Try again later. You can keep tracking.`);
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
    try {
      const next = await invoke<Status>('status');
      setStatus(next);
      setStatusError('');
    }
    catch { setStatusError('Cannot refresh app status. Keep WorkTrack open. Retrying automatically.'); }
    finally { refreshPending.current = false; }
  }
  useEffect(() => { void refresh(); const id = setInterval(() => void refresh(), 1000); return () => clearInterval(id); }, []);
  async function run(command: string, args?: Record<string, unknown>) {
    if (reserved.current) return;
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
  // Location is required. Ask the operating system once per sign-in; the worker can retry from the blocked state.
  const locationAsked = useRef(false);
  useEffect(() => {
    if (!status?.authenticated) { locationAsked.current = false; return; }
    if (locationAsked.current || status.location_enabled || status.location_pending || status.update_reserved) return;
    locationAsked.current = true;
    void invoke('request_location').then(refresh).catch(e => setError(String(e)));
  }, [status?.authenticated, status?.location_enabled, status?.location_pending, status?.update_reserved]);
  const elapsed = status?.elapsed ?? 0;
  const installReserved = Boolean(status?.update_reserved) || installing;
  const update = status?.update;
  const updateBusy = checking || update?.phase === 'checking';
  const unavailableMessage = unavailable || (update?.phase === 'unavailable' ? update.error?.replace(/^UPDATER_UNAVAILABLE:\s*/, '') : '');
  const updateFailure = updateError || (update?.phase !== 'unavailable' ? update?.error : null);
  const unsafeInstall = !status || Boolean(statusError) || status.tracking || status.stopping || status.queued > 0;
  const signedIn = Boolean(status?.authenticated) && !renew;
  const isMac = status?.platform === 'macos';
  const platformName = isMac ? 'macOS' : 'Windows';
  const screenReady = !isMac || status?.screen_capture_allowed === true;
  const locationReady = Boolean(status?.location_enabled);
  const clock = [elapsed / 3600, elapsed / 60 % 60, elapsed % 60].map(n => Math.floor(n).toString().padStart(2, '0')).join(':');
  const cycleDone = status?.tracking ? Math.min(10, Math.max(0, 10 - (status.next_capture / 60))) : 0;
  const nextShot = Math.ceil(status?.next_capture ?? 0);
  const stateClass = statusError || status?.stopping ? 'paused' : !status?.tracking ? 'off' : status.paused ? 'paused' : 'on';
  const stateText = statusError ? 'Status unavailable' : status?.stopping ? 'Saving tracked time' : !status?.tracking ? 'Not tracking' : status.paused ? 'Paused, screen locked' : 'Tracking';
  const syncText = status?.stopping ? 'Saving the final interval. Keep WorkTrack open while records retry.' : status?.queued ? `${status.queued} records waiting to sync` : 'All records synced';
  const notice = <section className="facts" aria-label="Monitoring notice">
    <p>Welcome to worktrack</p>
  </section>;
  const updateBanner = available && !deferred && <section className="banner" aria-labelledby="update-title">
    <h2 id="update-title">Version {available.version} is ready</h2>
    <p>Stop tracking and let records sync, then update. Your sign-in and records are kept.</p>
    {unsafeInstall && <p>Update now is available once tracking is stopped and the sync queue is empty.</p>}
    <details open><summary>Release notes</summary><p className="release-notes">{available.body || 'No release notes provided.'}</p></details>
    <div className="acts"><button className="primary" disabled={busy || updateBusy || installReserved || unsafeInstall || update?.phase === 'installed'} onClick={() => void installUpdate()}>Update now</button><button disabled={installReserved} onClick={() => setDeferred(true)}>Later</button></div>
  </section>;
  return <div className="win">
    <main className="body">
      {statusError && <p role="alert" className="error">{statusError}</p>}
      <div role="status" aria-live="polite" className="update-status">
        {installReserved && <p className="note">Update in progress. Tracking and sign-in are unavailable until installation finishes. The app may restart. Tracking will remain off.</p>}
        {update?.phase === 'downloading' && <>
          <label htmlFor="update-progress">Downloading update: {update.total ? `${Math.min(100, Math.round(update.downloaded / update.total * 100))}%` : `${Math.round(update.downloaded / 1024)} KB received`}</label>
          <progress id="update-progress" max={update.total || undefined} value={update.total ? Math.min(update.downloaded, update.total) : undefined} />
        </>}
        {update?.phase === 'installing' && <p className="note">Installing update. Please keep WorkTrack open.</p>}
        {update?.phase === 'installed' && <p className="note">Update installed. Restart WorkTrack if it does not restart automatically.</p>}
      </div>
      {updateBanner}
      {!signedIn ? <>
        <form className="signin" onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); void run('login', { email: data.get('email'), password: data.get('password') }); }}>
          <h1>Sign in</h1>
          <p className="lead">Use the account from your invitation email.</p>
          <label>Email<input name="email" type="email" autoComplete="username" required disabled={installReserved} /></label>
          <label>Password<input name="password" type="password" autoComplete="current-password" required disabled={installReserved} /></label>
          <button className="primary big" disabled={busy || installReserved}>Sign in</button>
          {renew && <button type="button" disabled={busy} onClick={() => setRenew(false)}>Cancel</button>}
        </form>
        {(error || status?.error) && <p role="alert" className="error">{error || status?.error}</p>}
        {notice}
      </> : <>
        <p className={`state ${stateClass}`}><span className="dot" />{stateText}</p>
        <output className={`clock ${status?.tracking ? '' : 'dim'}`} aria-label="Elapsed tracked time">{clock}</output>
        {status?.tracking && !status.paused && !statusError && <div className="cycle">
          <div className="ticks" role="img" aria-label={`Next screenshot in ${Math.floor(nextShot / 60)} minutes ${nextShot % 60} seconds`}>{Array.from({ length: 10 }, (_, i) => <i key={i} className={i < Math.floor(cycleDone) ? 'done' : ''} style={i === Math.floor(cycleDone) ? { background: `linear-gradient(90deg,var(--stamp) ${(cycleDone % 1) * 100}%,var(--track) 0)` } : undefined} />)}</div>
          <p><span>Next screenshot in <b>{Math.floor(nextShot / 60)} min {nextShot % 60} s</b></span></p>
        </div>}
        {status?.tracking && status.paused && <p className="note paused-note">Nothing is recorded while the screen is locked or the PC sleeps. Tracking resumes when you unlock.</p>}
        {!status?.tracking && !locationReady && <div className="blocked" role="status">
          <h2>{status?.location_pending ? `Waiting for ${platformName} location permission` : `Turn on ${platformName} location to start`}</h2>
          <p>{isMac ? 'Location is required with every screenshot. Open System Settings, then Privacy & Security, then Location Services, and allow WorkTrack. Then select Try again.' : 'Location is required with every screenshot. Open Settings, then Privacy and security, then Location, and allow desktop apps. Then select Try again.'}</p>
          <div className="acts"><button disabled={busy || installReserved} onClick={() => void run('open_location_settings')}>Open location settings</button><button disabled={busy || installReserved || status?.location_pending} onClick={() => void run('request_location')}>Try again</button></div>
        </div>}
        {!status?.tracking && !screenReady && <div className="blocked" role="status">
          <h2>Allow macOS screen recording to start</h2>
          <p>WorkTrack needs Screen Recording access for scheduled screenshots. Allow WorkTrack in System Settings, then Privacy &amp; Security, then Screen Recording. Restart WorkTrack if macOS asks you to.</p>
          <div className="acts"><button disabled={busy || installReserved} onClick={() => void run('request_screen_capture')}>Allow screen recording</button><button disabled={busy || installReserved} onClick={() => void run('open_screen_settings')}>Open screen recording settings</button></div>
        </div>}
        {!status?.tracking && notice}
        {!status?.tracking && <label className="consent"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} /><span>I understand and agree to this monitoring</span></label>}
        <button className={status?.tracking ? 'big stop' : 'primary big'} disabled={busy || installReserved || (!status?.tracking && (Boolean(statusError) || !consent || !locationReady || !screenReady || status?.stopping))} onClick={() => void run(status?.tracking ? 'stop' : 'start', { consent })}>{status?.tracking ? 'Stop tracking' : 'Start tracking'}</button>
        <p className="sync-line"><span>{statusError ? 'Sync status unavailable until the app reconnects.' : syncText}</span></p>
        {Boolean(status?.rejected) && <p role="status" className="note">{status?.rejected} records refused by the server were set aside on this PC. Contact your manager.</p>}
        {(error || status?.error) && <p role="alert" className="error">{error || status?.error}</p>}
        <div className="account-actions"><button disabled={busy || installReserved || status?.tracking} onClick={() => setRenew(true)}>Renew sign-in</button><button disabled={busy || installReserved || status?.tracking || status?.stopping || (status?.queued ?? 0) > 0} onClick={() => void run('logout')}>Sign out</button></div>
      </>}
      <section className="updates" aria-labelledby="updates-title">
        <h2 id="updates-title" className="sr-only">App updates</h2>
        <div role="status" aria-live="polite">
          {updateBusy && <p>Checking for updates…</p>}
          {!updateBusy && checked && !available && !updateFailure && !unavailableMessage && <p>You are up to date{version ? ` on version ${version}` : ''}.</p>}
          {unavailableMessage && <p>App updates are not available in this build. {unavailableMessage} You can keep tracking normally.</p>}
          {available && deferred && <p>Version {available.version} is available. You can update later.</p>}
        </div>
        {available && deferred && <button disabled={installReserved} onClick={() => setDeferred(false)}>Show update</button>}
        {updateFailure && <p className="error" role="alert">{updateFailure}</p>}
      </section>
    </main>
    <footer className="foot"><span>{version ? `Version ${version}` : 'WorkTrack'}{status?.tracking ? '. Closing this window stops tracking.' : ''}</span><button className="link" disabled={updateBusy || installReserved} onClick={() => void checkUpdate()}>Check for updates</button></footer>
  </div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
