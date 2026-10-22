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

type LocationReport = { status: 'available' | 'unavailable'; requested_at: string; latitude: number | null; longitude: number | null; accuracy_m: number | null; observed_at: string | null; position_source: string | null; is_remote_source: boolean | null };
type Update = { version: string; current_version: string; body: string | null; date: string | null };
type UpdateStatus = { phase: 'idle' | 'checking' | 'available' | 'downloading' | 'installing' | 'installed' | 'error' | 'unavailable'; downloaded: number; total: number | null; error: string | null };
type Status = { authenticated: boolean; tracking: boolean; stopping: boolean; paused: boolean; elapsed: number; next_capture: number; queued: number; rejected: number; error: string | null; server: string; update: UpdateStatus; update_reserved: boolean; diagnostics_enabled: boolean; diagnostics_queued: number; diagnostics_error: string | null; location_enabled: boolean; location_pending: boolean; location_error: string | null };
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
  const [diagnosing, setDiagnosing] = useState(false);
  const [locationReport, setLocationReport] = useState<LocationReport | null>(null);
  const [locationDiagnosticError, setLocationDiagnosticError] = useState('');
  const diagnosticPending = useRef(false);
  const diagnosticEpoch = useRef(0);
  function clearLocationReport() {
    diagnosticEpoch.current += 1;
    setLocationReport(null); setLocationDiagnosticError('');
  }
  async function diagnoseLocation() {
    if (diagnosticPending.current || !status?.authenticated || renew || status.tracking || status.stopping || reserved.current || busy) return;
    diagnosticPending.current = true; setDiagnosing(true); setLocationReport(null); setLocationDiagnosticError('');
    const epoch = diagnosticEpoch.current;
    try {
      const report = await invoke<LocationReport>('diagnose_location');
      if (epoch === diagnosticEpoch.current) setLocationReport(report);
    } catch (error) {
      const knownErrors = ['Sign in and allow location before diagnosing.', 'Unlock the desktop and stop tracking before diagnosing.', 'Location diagnostic already running.', 'Location diagnostic cancelled because state changed.'];
      const nativeError = typeof error === 'string' ? error.replace(/\.$/, '') + '.' : '';
      const message = knownErrors.includes(nativeError) ? nativeError : 'The local test could not complete. Try again.';
      if (epoch === diagnosticEpoch.current) setLocationDiagnosticError(`Location diagnostic failed: ${message}`);
    } finally { diagnosticPending.current = false; setDiagnosing(false); }
  }
  const refreshPending = useRef(false);
  const checkPending = useRef(false);
  const installPending = useRef(false);
  const reserved = useRef(false);
  reserved.current = Boolean(status?.update_reserved) || installing;
  async function checkUpdate() {
    if (checkPending.current || reserved.current || diagnosticPending.current) return;
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
      if (!next.authenticated || next.tracking) clearLocationReport();
      setStatus(next);
    }
    catch (e) { setError(String(e)); }
    finally { refreshPending.current = false; }
  }
  useEffect(() => { void refresh(); const id = setInterval(() => void refresh(), 1000); return () => clearInterval(id); }, []);
  async function run(command: string, args?: Record<string, unknown>) {
    if (reserved.current || (diagnosticPending.current && command !== 'stop')) return;
    if (['login', 'logout', 'start'].includes(command)) clearLocationReport();
    setBusy(true); setError('');
    try { await invoke(command, args); if (command === 'login') setRenew(false); await refresh(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  async function installUpdate() {
    if (!available || diagnosticPending.current || installPending.current || reserved.current || busy || checking) return;
    installPending.current = true; reserved.current = true; setInstalling(true); setUpdateError('');
    try { await invoke('install_update', { version: available.version }); }
    catch (e) { setUpdateError(`Update could not be installed: ${String(e)}. Resolve the issue, then try Update now again.`); }
    finally { await refresh(); installPending.current = false; setInstalling(false); }
  }
  // Location is required. Ask Windows once per sign-in; the worker can retry from the blocked state.
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
  const unsafeInstall = !status || status.tracking || status.stopping || status.queued > 0;
  const signedIn = Boolean(status?.authenticated) && !renew;
  const locationReady = Boolean(status?.location_enabled);
  const clock = [elapsed / 3600, elapsed / 60 % 60, elapsed % 60].map(n => Math.floor(n).toString().padStart(2, '0')).join(':');
  const cycleDone = status?.tracking ? Math.min(10, Math.max(0, 10 - (status.next_capture / 60))) : 0;
  const nextShot = Math.ceil(status?.next_capture ?? 0);
  const stateClass = !status?.tracking ? 'off' : status.paused ? 'paused' : 'on';
  const stateText = !status?.tracking ? 'Not tracking' : status.paused ? 'Paused, screen locked' : 'Tracking';
  const syncText = status?.stopping ? 'Saving the final interval. Keep WorkTrack open while records retry.' : status?.queued ? `${status.queued} records waiting to sync` : 'All records synced';
  const notice = <details className="facts" open={!signedIn}>
    <summary>What WorkTrack records</summary>
    <div className="cols">
      <div><h3>Only while tracking</h3><ul><li>Elapsed time</li><li>Input activity level</li><li>App names and time in each</li><li>Screenshot every 10 minutes</li><li>Location at each screenshot</li></ul></div>
      <div><h3>Never</h3><ul><li>Typed text or keys</li><li>Window titles or websites</li><li>Automatic screen, input or location collection while stopped</li><li>Random captures</li></ul></div>
    </div>
    <details className="full-notice"><summary>Read the full notice</summary>
      <p>Only while you choose Start, WorkTrack measures elapsed time, input activity, foreground application names and estimated time in each, and takes a compressed screenshot of your primary display at each exact 10-minute elapsed boundary. No random captures.</p>
      <p>Location is required. At each screenshot WorkTrack asks Windows for one location fix and stores coordinates, accuracy and fix time with that screenshot. Windows may use Wi-Fi, GPS, IP or a default location, and can be wrong. WorkTrack has no separate IP fallback. Tracking cannot start without Windows location permission.</p>
      <p>Diagnostic logs are required while you are signed in. They contain fixed error codes, HTTP status, app version and timestamps, and may upload while tracking is stopped. They never contain error text, screenshots, typed content, passwords or tokens, and expire after seven days.</p>
      <p>No typed text, keys, window titles or websites are recorded. Locking or suspending pauses monitoring. Stop ends automatic screen, input and location collection. A manual local location diagnostic makes one location request while stopped. Its sensitive coordinates stay local, are not queued or uploaded, and are not added to diagnostic logs. Queued records and diagnostics may still upload while stopped.</p>
      <p>You, your managers and the owner can view these work records. No application file paths are sent. Deleting a screenshot removes its location from the live database. Backups follow separate retention. Screenshots can contain private information, so close private content before starting. This app stays visible in the tray and never starts tracking automatically.</p>
    </details>
  </details>;
  const updateBanner = available && !deferred && <section className="banner" aria-labelledby="update-title">
    <h2 id="update-title">Version {available.version} is ready</h2>
    <p>Stop tracking and let records sync, then update. Your sign-in and records are kept.</p>
    {unsafeInstall && <p>Update now is available once tracking is stopped and the sync queue is empty.</p>}
    <details open><summary>Release notes</summary><p className="release-notes">{available.body || 'No release notes provided.'}</p></details>
    <div className="acts"><button className="primary" disabled={diagnosing || busy || updateBusy || installReserved || unsafeInstall || update?.phase === 'installed'} onClick={() => void installUpdate()}>Update now</button><button disabled={installReserved} onClick={() => setDeferred(true)}>Later</button></div>
  </section>;
  return <div className="win">
    <main className="body">
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
          <label>Email<input name="email" type="email" autoComplete="username" required disabled={diagnosing || installReserved} /></label>
          <label>Password<input name="password" type="password" autoComplete="current-password" required disabled={diagnosing || installReserved} /></label>
          <button className="primary big" disabled={diagnosing || busy || installReserved}>Sign in</button>
          {renew && <button type="button" disabled={busy} onClick={() => setRenew(false)}>Cancel</button>}
        </form>
        {(error || status?.error) && <p role="alert" className="error">{error || status?.error}</p>}
        {notice}
      </> : <>
        <p className={`state ${stateClass}`}><span className="dot" />{stateText}</p>
        <output className={`clock ${status?.tracking ? '' : 'dim'}`} aria-label="Elapsed tracked time">{clock}</output>
        {status?.tracking && !status.paused && <div className="cycle">
          <div className="ticks" role="img" aria-label={`${Math.floor(cycleDone)} of 10 minutes until the next screenshot`}>{Array.from({ length: 10 }, (_, i) => <i key={i} className={i < Math.floor(cycleDone) ? 'done' : ''} style={i === Math.floor(cycleDone) ? { background: `linear-gradient(90deg,var(--stamp) ${(cycleDone % 1) * 100}%,var(--track) 0)` } : undefined} />)}</div>
          <p><span>Next screenshot in <b>{Math.floor(nextShot / 60)} min {nextShot % 60} s</b></span></p>
        </div>}
        {status?.tracking && status.paused && <p className="note paused-note">Nothing is recorded while the screen is locked or the PC sleeps. Tracking resumes when you unlock.</p>}
        {!status?.tracking && !locationReady && <div className="blocked" role="status">
          <h2>{status?.location_pending ? 'Waiting for Windows location permission' : 'Turn on Windows location to start'}</h2>
          <p>Location is required with every screenshot. Open Settings, then Privacy and security, then Location, and allow desktop apps. Then select Try again.</p>
          <div className="acts"><button disabled={diagnosing || busy || installReserved} onClick={() => void run('open_location_settings')}>Open location settings</button><button disabled={diagnosing || busy || installReserved || status?.location_pending} onClick={() => void run('request_location')}>Try again</button></div>
        </div>}
        {!status?.tracking && <label className="consent"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} /><span>I understand what is recorded, including location with each screenshot and diagnostic logs, and agree to it. Close private content before starting.</span></label>}
        <button className={status?.tracking ? 'big stop' : 'primary big'} disabled={busy || installReserved || (!status?.tracking && (diagnosing || !consent || !locationReady || status?.stopping))} onClick={() => void run(status?.tracking ? 'stop' : 'start', { consent })}>{status?.tracking ? 'Stop tracking' : 'Start tracking'}</button>
        <p className="sync-line"><span>{syncText}</span></p>
        {Boolean(status?.rejected) && <p role="status" className="note">{status?.rejected} records refused by the server were set aside on this PC. Contact your manager.</p>}
        {(error || status?.error) && <p role="alert" className="error">{error || status?.error}</p>}
        <section className="facts rows" aria-label="Required monitoring">
          <div className="row"><span className={`req ${locationReady ? 'ok' : 'bad'}`} aria-hidden="true" /><div>Location with screenshots<small>{status?.location_pending ? 'Waiting for Windows permission.' : locationReady ? (status?.location_error || 'Required. Windows location permission granted.') : 'Blocked by Windows. Tracking cannot start.'}</small></div></div>
          <div className="row"><span className={`req ${status?.diagnostics_error ? 'warn' : 'ok'}`} aria-hidden="true" /><div>Diagnostic logs<small>Required. {status?.diagnostics_queued ?? 0} diagnostic events waiting. {status?.diagnostics_error || 'Error codes only, kept 7 days.'}</small></div></div>
        </section>
        <section className="facts" aria-labelledby="location-diagnostic-title">
          <h2 id="location-diagnostic-title">Local location diagnostic</h2>
          <p>Makes one location request while stopped, only when you select Run. Sensitive coordinates stay local, are not queued or uploaded, and are not added to diagnostic logs.</p>
          <p>Windows may use Wi-Fi, GPS, IP or a default location and can be wrong. WorkTrack has no separate IP fallback.</p>
          <button disabled={diagnosing || busy || installReserved || status?.tracking || status?.stopping} onClick={() => void diagnoseLocation()}>Run local location diagnostic</button>
          <div role="status" aria-live="polite">{diagnosing && <p>Requesting local location…</p>}</div>
          {locationDiagnosticError && <p role="alert" className="error">{locationDiagnosticError}</p>}
          {locationReport && <div aria-label="Local location report" style={{ overflowWrap: 'anywhere', userSelect: 'text' }}>
            <h3>Location diagnostic result</h3>
            <p>Status: {locationReport.status}</p>
            <p>Source: {locationReport.position_source ?? 'Unknown'}. Remote source: {locationReport.is_remote_source === null ? 'Unknown' : locationReport.is_remote_source ? 'Yes' : 'No'}.</p>
            <p>Latitude: {locationReport.latitude ?? 'Unavailable'}. Longitude: {locationReport.longitude ?? 'Unavailable'}.</p>
            <p>Accuracy (meters): {locationReport.accuracy_m ?? 'Unknown'}</p>
            <p>Requested at: {locationReport.requested_at}. Observed at: {locationReport.observed_at ?? 'Unknown'}.</p>
          </div>}
          {(locationReport || locationDiagnosticError) && <button onClick={clearLocationReport}>Clear location diagnostic</button>}
        </section>
        {notice}
        <div className="account-actions"><button disabled={diagnosing || busy || installReserved || status?.tracking} onClick={() => { clearLocationReport(); setRenew(true); }}>Renew sign-in</button><button disabled={diagnosing || busy || installReserved || status?.tracking || status?.stopping || (status?.queued ?? 0) > 0} onClick={() => void run('logout')}>Sign out</button></div>
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
    <footer className="foot"><span>{version ? `Version ${version}` : 'WorkTrack'}{status?.tracking ? '. Closing this window stops tracking.' : ''}</span><button className="link" disabled={diagnosing || updateBusy || installReserved} onClick={() => void checkUpdate()}>Check for updates</button></footer>
  </div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
