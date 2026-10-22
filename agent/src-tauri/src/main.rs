#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod applications;
mod diagnostics;
mod location;
mod platform;
mod queue;
mod updater;
use chrono::Utc;
use diagnostics::Code as LogCode;
use queue::Queue;
use serde::Serialize;
use serde_json::json;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, State,
};

// Override at build time with WORKTRACK_SERVER_URL for staging or a new domain.
// The updater endpoint in tauri.conf.json must be changed separately.
const SERVER_URL: &str = match option_env!("WORKTRACK_SERVER_URL") {
    Some(url) => url,
    None => "https://worktrack.178.156.213.40.sslip.io",
};

fn queue_matches_server(saved_server: &str, pending: usize) -> bool {
    pending == 0 || saved_server == SERVER_URL
}

struct Runtime {
    queue: Queue,
    server: String,
    token: Option<String>,
    session: Option<String>,
    pending_stop: Option<(String, chrono::DateTime<Utc>)>,
    elapsed: f64,
    active: f64,
    segment: f64,
    segment_start: chrono::DateTime<Utc>,
    next_capture: f64,
    last: Instant,
    paused: bool,
    error: Option<String>,
    update_reserved: bool,
    update: updater::UpdateStatus,
    pending_update: Option<tauri_plugin_updater::Update>,
    diagnostics: diagnostics::Diagnostics,
    location: location::Consent,
    applications: applications::Applications,
    shutting_down: bool,
}
type Shared = Arc<Mutex<Runtime>>;
#[derive(Serialize)]
struct Status {
    platform: &'static str,
    screen_capture_allowed: bool,
    authenticated: bool,
    tracking: bool,
    stopping: bool,
    paused: bool,
    elapsed: f64,
    next_capture: f64,
    queued: usize,
    rejected: usize,
    error: Option<String>,
    server: String,
    update_reserved: bool,
    update: updater::UpdateStatus,
    diagnostics_enabled: bool,
    diagnostics_queued: usize,
    diagnostics_error: Option<&'static str>,
    location_enabled: bool,
    location_pending: bool,
    location_error: Option<&'static str>,
}
fn utc_now() -> chrono::DateTime<Utc> {
    chrono::DateTime::from_timestamp(Utc::now().timestamp(), 0).expect("valid current timestamp")
}
fn credential(server: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("com.worktrack.agent", server).map_err(|e| e.to_string())
}
fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn status(state: State<'_, Shared>) -> Result<Status, String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || snapshot_status(&shared))
        .await
        .map_err(|e| e.to_string())?
}
fn snapshot_status(shared: &Shared) -> Result<Status, String> {
    let r = shared.lock().map_err(|e| e.to_string())?;
    Ok(Status {
        platform: std::env::consts::OS,
        screen_capture_allowed: platform::screen_capture_allowed(),
        authenticated: r.token.is_some(),
        tracking: r.session.is_some(),
        stopping: r.pending_stop.is_some(),
        paused: r.paused,
        elapsed: r.elapsed,
        next_capture: (r.next_capture - r.elapsed).max(0.0),
        queued: r.queue.count(),
        rejected: r.queue.rejected_count(),
        error: r.error.clone(),
        server: r.server.clone(),
        update_reserved: r.update_reserved,
        update: r.update.clone(),
        diagnostics_enabled: r.diagnostics.enabled,
        diagnostics_queued: r.diagnostics.count(),
        diagnostics_error: r.diagnostics.error,
        location_enabled: r.location.enabled,
        location_pending: r.location.pending,
        location_error: r.location.error,
    })
}
#[tauri::command]
fn request_screen_capture(state: State<Shared>) -> Result<bool, String> {
    let r = state.lock().map_err(|e| e.to_string())?;
    updater::ensure_not_reserved(&r)?;
    if r.token.is_none() || r.session.is_some() || r.pending_stop.is_some() {
        return Err("Sign in and stop tracking before changing screen recording permission".into());
    }
    drop(r);
    Ok(platform::request_screen_capture())
}
#[tauri::command]
fn open_screen_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            .spawn()
            .map(|_| ())
            .map_err(|_| "Could not open screen recording settings".into())
    }
    #[cfg(not(target_os = "macos"))]
    Err("Screen recording settings are available only on macOS".into())
}
#[tauri::command]
async fn login(state: State<'_, Shared>, email: String, password: String) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let server = SERVER_URL.to_string();
        let mut r = state.lock().map_err(|e| e.to_string())?;
        updater::ensure_not_reserved(&r)?;
        if r.session.is_some() { return Err("Stop tracking before signing in".into()); }
        let pending = r.queue.count() + usize::from(r.pending_stop.is_some());
        if !queue_matches_server(&r.queue.get("server").unwrap_or_default(), pending) { return Err("This installation has unsynced records for another server. Sync them using version 0.1.0 before upgrading. No records were moved or deleted.".into()); }
        if pending > 0 && r.queue.get("email").as_deref() != Some(email.trim().to_lowercase().as_str()) { return Err("Queued records belong to another account. Use that account to sync first.".into()); }
        let response = client()?.post(format!("{server}/api/auth/login")).json(&json!({"email":&email,"password":password,"device_name":std::env::var("COMPUTERNAME").unwrap_or_else(|_| "WorkTrack desktop".into())})).send().map_err(|_| { r.diagnostics.record(LogCode::LoginFailed, None); "Cannot reach server".to_string() })?;
        if !response.status().is_success() { r.diagnostics.record(LogCode::LoginFailed, Some(response.status().as_u16())); return Err(format!("Login rejected ({})", response.status())); }
        let body: serde_json::Value = response.json().map_err(|_| "Invalid login response")?;
        let token = body["device_token"].as_str().ok_or("Missing device token")?.to_string();
        // Fail closed rather than silently putting a device token in SQLite.
        credential(&server)?.set_password(&token).map_err(|_| "Could not save device token in OS credential storage")?;
        r.queue.set("email", &email.trim().to_lowercase())?;
        r.queue.set("server", &server)?;
        // Diagnostics are mandatory for every signed-in account.
        r.diagnostics.configure(true);
        r.location.reset();
        r.server = server; r.token = Some(token); r.error = None;
        Ok(())
    }).await.map_err(|e| e.to_string())?
}
fn require_location(r: &Runtime) -> Result<(), String> {
    if r.location.diagnosing {
        return Err("Wait for the location diagnostic to finish before starting".into());
    }
    if r.location.enabled {
        Ok(())
    } else {
        Err("Allow WorkTrack to use system location before starting. Location is required with every screenshot.".into())
    }
}
#[tauri::command]
fn start(state: State<Shared>, consent: bool) -> Result<(), String> {
    let mut r = state.lock().map_err(|e| e.to_string())?;
    updater::ensure_not_reserved(&r)?;
    if r.pending_stop.is_some() {
        return Err("The previous stop is still being saved. Records are retained and will retry automatically.".into());
    }
    if !cfg!(any(windows, target_os = "macos")) {
        return Err("Tracking is supported only on Windows and macOS".into());
    }
    if !consent || r.token.is_none() {
        return Err("Sign in and accept the monitoring disclosure first".into());
    }
    if r.session.is_some() {
        return Ok(());
    }
    require_location(&r)?;
    if !platform::screen_capture_allowed() {
        return Err("Allow screen recording in System Settings before starting. Restart WorkTrack if macOS asks you to.".into());
    }
    if !platform::unlocked() {
        return Err("Unlock your desktop first".into());
    }
    if r.queue
        .get("active_session")
        .is_some_and(|id| !id.is_empty())
    {
        return Err(
            "A previous stop is still pending. Restart to recover it before starting.".into(),
        );
    }
    let id = uuid::Uuid::new_v4().to_string();
    let started = utc_now();
    r.queue
        .atomic(|q| {
            q.push(
                "/api/sessions/start",
                &json!({"id":id,"started_at":started}),
                None,
            )?;
            q.set("active_session", &id)?;
            q.set("checkpoint", &started.to_rfc3339())
        })
        .inspect_err(|_| r.diagnostics.record(LogCode::QueueFailed, None))?;
    r.session = Some(id);
    r.segment = 0.0;
    r.segment_start = started;
    r.elapsed = 0.0;
    r.active = 0.0;
    r.next_capture = 600.0;
    r.applications.clear();
    r.last = Instant::now();
    r.paused = false;
    r.error = None;
    Ok(())
}
fn flush_block(r: &mut Runtime, image: Option<&[u8]>) -> Result<(), String> {
    let session = r
        .session
        .as_ref()
        .or_else(|| r.pending_stop.as_ref().map(|(id, _)| id));
    if session.is_none() {
        return Ok(());
    }
    let seconds = (r.segment.floor() as i64).min(600);
    if seconds < 1 {
        return Ok(());
    }
    let end = r.segment_start + chrono::Duration::seconds(seconds);
    let location = image.map(|_| {
        let mut snapshot = location::Snapshot::new(r.location.enabled);
        snapshot.captured_at = end;
        snapshot
    });
    let applications = r.applications.snapshot(seconds);
    r.queue.atomic(|q| {
        q.push("/api/blocks", &json!({"blocks":[{"id":uuid::Uuid::new_v4().to_string(),"session_id":session,"start_at":r.segment_start,"end_at":end,"active_seconds":(r.active.floor() as i64).min(seconds),"location":location,"application_usage":applications}]}), image)?;
        q.set("checkpoint", &end.to_rfc3339())
    }).inspect_err(|_| r.diagnostics.record(LogCode::QueueFailed, None))?;
    r.segment -= seconds as f64;
    r.applications.clear();
    r.active = 0.0;
    r.segment_start = end;
    Ok(())
}
fn stop_runtime(r: &mut Runtime) -> Result<(), String> {
    if let Some(id) = r.session.take() {
        // Stop collection immediately, but retain the final interval and its original stop time.
        r.pending_stop = Some((id, utc_now()));
    }
    let Some((id, stopped_at)) = r.pending_stop.clone() else {
        return Ok(());
    };
    flush_block(r, None)?;
    r.queue
        .atomic(|q| {
            q.push(
                "/api/sessions/stop",
                &json!({"id":id,"stopped_at":stopped_at}),
                None,
            )?;
            q.set("active_session", "")
        })
        .inspect_err(|_| r.diagnostics.record(LogCode::QueueFailed, None))?;
    r.pending_stop = None;
    Ok(())
}
#[tauri::command]
fn stop(state: State<Shared>) -> Result<(), String> {
    let mut r = state.lock().map_err(|e| e.to_string())?;
    updater::ensure_not_reserved(&r)?;
    stop_runtime(&mut r)
}
fn revoke_device(server: &str, token: &str) -> Result<(), String> {
    let response = client()?
        .post(format!("{server}/api/auth/logout"))
        .bearer_auth(token)
        .json(&json!({}))
        .send()
        .map_err(|_| {
            "Cannot reach server. Sign-out was not completed. Retry when online.".to_string()
        })?;
    // A retry after successful revocation may already have an invalid token.
    if !response.status().is_success() && response.status() != reqwest::StatusCode::UNAUTHORIZED {
        return Err(format!(
            "Sign-out rejected ({}). Saved sign-in retained for retry.",
            response.status()
        ));
    }
    Ok(())
}
#[tauri::command]
async fn logout(state: State<'_, Shared>) -> Result<(), String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut r = shared.lock().map_err(|e| e.to_string())?;
        updater::ensure_not_reserved(&r)?;
        if r.session.is_some() || r.pending_stop.is_some() || r.queue.first()?.is_some() {
            return Err("Stop and sync before signing out".into());
        }
        if let Some(token) = &r.token {
            revoke_device(&r.server, token)?;
        }
        credential(&r.server)?
            .delete_credential()
            .map_err(|e| e.to_string())?;
        r.token = None;
        r.diagnostics.configure(false);
        r.location.reset();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
fn screenshot() -> Result<Vec<u8>, String> {
    if !platform::screen_capture_allowed() {
        return Err("Screen recording permission unavailable".into());
    }
    if !platform::unlocked() {
        return Err("Screen is locked".into());
    }
    let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
    let monitor = monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .ok_or("No primary display")?;
    let raw = monitor.capture_image().map_err(|e| e.to_string())?;
    if !platform::unlocked() {
        return Err("Desktop changed during capture; screenshot discarded".into());
    }
    let rgb = image::DynamicImage::ImageRgba8(raw)
        .resize(1920, 1080, image::imageops::FilterType::Triangle)
        .to_rgb8();
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 65)
        .encode_image(&rgb)
        .map_err(|e| e.to_string())?;
    Ok(bytes)
}
fn tick(r: &mut Runtime) -> Result<(), String> {
    let now = Instant::now();
    let dt = now.duration_since(r.last).as_secs_f64();
    r.last = now;
    if r.pending_stop.is_some() {
        return stop_runtime(r);
    }
    if r.session.is_none() {
        return Ok(());
    }
    let unlocked = platform::unlocked();
    let idle = if unlocked {
        platform::idle_seconds()
    } else {
        None
    };
    let app = if unlocked && dt <= 2.0 && !r.paused {
        platform::foreground_app()
    } else {
        None
    };
    sample_tick(r, dt, unlocked, idle, app.as_deref(), screenshot)
}
fn sample_tick(
    r: &mut Runtime,
    dt: f64,
    unlocked: bool,
    idle: Option<f64>,
    app: Option<&str>,
    capture: impl FnOnce() -> Result<Vec<u8>, String>,
) -> Result<(), String> {
    if r.session.is_none() {
        return Ok(());
    }
    let was_paused = r.paused;
    r.paused = dt > 2.0 || !unlocked;
    if r.paused {
        if !was_paused {
            flush_block(r, None)?;
            // API blocks use whole seconds. Drop the unfinished fraction at pause
            // so the next capture always belongs to a nonempty time block.
            r.elapsed = r.elapsed.floor();
        }
        return Ok(());
    }
    if was_paused {
        r.segment_start = utc_now();
        r.segment = 0.0;
        return Ok(());
    }
    let idle = idle
        .ok_or("Windows activity sampling failed")
        .inspect_err(|_| r.diagnostics.record(LogCode::ActivityFailed, None))?;
    r.elapsed += dt;
    r.segment += dt;
    r.applications.record(app, dt);
    if idle < 1.0 {
        r.active += dt;
    }
    if r.elapsed >= r.next_capture {
        // Fixed elapsed boundaries, never randomized or caught up after lock/sleep.
        r.next_capture += 600.0;
        let bytes =
            capture().inspect_err(|_| r.diagnostics.record(LogCode::CaptureFailed, None))?;
        flush_block(r, Some(&bytes))?;
    } else if r.segment >= 30.0 {
        flush_block(r, None)?;
    }
    Ok(())
}
fn collect_tick(
    shared: &Shared,
    last: &mut Option<(bool, bool)>,
    notify: impl FnOnce(bool, bool) -> bool,
) {
    let state = {
        let Ok(mut r) = shared.lock() else {
            return;
        };
        if let Err(e) = tick(&mut r) {
            let _ = stop_runtime(&mut r);
            r.error = Some(e);
        }
        (r.session.is_some(), r.paused)
    };
    // Tray setters wait for the UI thread, which may itself need the Runtime lock.
    if *last != Some(state) && notify(state.0, state.1) {
        *last = Some(state);
    }
}
fn sync_one(shared: &Shared) -> Result<bool, String> {
    let (item, server, token) = {
        let r = shared.lock().map_err(|e| e.to_string())?;
        let Some(token) = r.token.clone() else {
            return Ok(false);
        };
        let Some(item) = r.queue.first()? else {
            return Ok(false);
        };
        (item, r.server.clone(), token)
    };
    let http = client()?;
    let mut payload: serde_json::Value =
        serde_json::from_str(&item.json).map_err(|e| e.to_string())?;
    if payload["blocks"][0]["location"]["status"] == "pending" {
        let snapshot: location::Snapshot =
            serde_json::from_value(payload["blocks"][0]["location"].clone())
                .map_err(|e| e.to_string())?;
        if (utc_now() - snapshot.captured_at).num_seconds() >= 10 {
            shared
                .lock()
                .map_err(|e| e.to_string())?
                .queue
                .finish_location(item.id, &snapshot.finish(None))?;
        }
        return Ok(false);
    }
    if payload["blocks"][0]["screenshot_key"].as_str().is_none() {
        if let Some(bytes) = item.image.as_ref() {
            let block_id = payload["blocks"][0]["id"]
                .as_str()
                .ok_or("Invalid queued block")?;
            let response = http
            .post(format!("{server}/api/uploads/screenshot-url"))
            .bearer_auth(&token)
            .json(
                &json!({"block_id":block_id,"content_type":"image/jpeg","size_bytes":bytes.len()}),
            )
            .send()
            .map_err(|e| e.to_string())?;
            if !response.status().is_success() {
                return Err(format!("Screenshot URL rejected ({})", response.status()));
            }
            let upload: serde_json::Value = response.json().map_err(|e| e.to_string())?;
            let url = upload["upload_url"].as_str().ok_or("Missing upload URL")?;
            let parsed = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
            if parsed.scheme() != "https"
                && !(parsed.scheme() == "http"
                    && matches!(parsed.host_str(), Some("localhost" | "127.0.0.1")))
            {
                return Err("Unsafe screenshot upload URL".into());
            }
            let response = http
                .put(url)
                .header("Content-Type", "image/jpeg")
                .body(bytes.clone())
                .send()
                .map_err(|e| e.to_string())?;
            if !response.status().is_success() {
                return Err(format!(
                    "Screenshot upload rejected ({})",
                    response.status()
                ));
            }
            payload["blocks"][0]["screenshot_key"] = upload["object_key"].clone();
            shared
                .lock()
                .map_err(|e| e.to_string())?
                .queue
                .finalize_upload(item.id, &payload)?;
        }
    }
    let response = http
        .post(format!("{server}{}", item.path))
        .bearer_auth(token)
        .json(&payload)
        .send()
        .map_err(|_| "Offline: queued data will retry automatically".to_string())?;
    if !response.status().is_success() {
        let status = response.status();
        let error: serde_json::Value = response.json().unwrap_or_default();
        if status == reqwest::StatusCode::BAD_REQUEST
            && error["code"] == "upload_expired"
            && item.image.is_some()
        {
            if let Some(block) = payload["blocks"][0].as_object_mut() {
                block.remove("screenshot_key");
            }
            shared
                .lock()
                .map_err(|e| e.to_string())?
                .queue
                .finalize_upload(item.id, &payload)?;
            return Err(
                "Screenshot reservation expired. Retained image will be uploaded again on retry."
                    .into(),
            );
        }
        if permanent_rejection(status) {
            let mut r = shared.lock().map_err(|e| e.to_string())?;
            if hold_or_reject(&mut r, item.id, status.as_u16(), utc_now())? {
                r.error = Some(format!(
                    "The server refused one record ({status}) for 24 hours. It was set aside locally so newer records can sync. Contact your manager."
                ));
                return Ok(true);
            }
            return Err(format!(
                "Sync refused ({status}). Retrying. If this persists for 24 hours the record is set aside so newer records can sync."
            ));
        }
        return Err(format!(
            "Sync rejected ({}). Records retained. Sign-in may need renewal.",
            status
        ));
    }
    let mut r = shared.lock().map_err(|e| e.to_string())?;
    r.queue.ack(item.id)?;
    r.queue.set(HEAD_REJECTED, "")?;
    r.error = None;
    Ok(true)
}
const HEAD_REJECTED: &str = "head_rejected";
/// Hold time before a refused record is set aside. A rolled-back or misconfigured
/// API can also answer 4xx, so valid data gets a day for the server to be fixed.
const REJECT_AFTER_SECONDS: i64 = 24 * 3600;
fn permanent_rejection(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 400 | 403 | 404 | 409 | 410 | 413 | 422)
}
/// Returns true when the head item was moved to the local rejected table.
/// The clock runs per refusal streak, not per item, and any accepted record
/// resets it. Once refusals persist a day, later refused items (often blocks of
/// an already-refused session) are set aside without another day's wait.
fn hold_or_reject(
    r: &mut Runtime,
    id: i64,
    status: u16,
    now: chrono::DateTime<Utc>,
) -> Result<bool, String> {
    let first = r
        .queue
        .get(HEAD_REJECTED)
        .and_then(|at| chrono::DateTime::parse_from_rfc3339(&at).ok())
        .map(|at| at.with_timezone(&Utc));
    let Some(first) = first else {
        r.queue.set(HEAD_REJECTED, &now.to_rfc3339())?;
        return Ok(false);
    };
    if (now - first).num_seconds() < REJECT_AFTER_SECONDS {
        return Ok(false);
    }
    r.queue.reject(id, status)?;
    r.diagnostics.record(LogCode::SyncRejected, Some(status));
    Ok(true)
}
fn icon(on: bool) -> tauri::image::Image<'static> {
    let color = if on {
        [25, 158, 99, 255]
    } else {
        [105, 117, 125, 255]
    };
    tauri::image::Image::new_owned(color.repeat(32 * 32), 32, 32)
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let dir = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let queue = Queue::open(&dir.join("queue.sqlite3"))?;
            if let Some(id) = queue.get("active_session").filter(|id| !id.is_empty()) {
                let stopped = queue
                    .get("checkpoint")
                    .unwrap_or_else(|| utc_now().to_rfc3339());
                queue.atomic(|q| {
                    q.push(
                        "/api/sessions/stop",
                        &json!({"id":id,"stopped_at":stopped}),
                        None,
                    )?;
                    q.set("active_session", "")
                })?;
            }
            let saved_server = queue.get("server").unwrap_or_default();
            let compatible_queue = queue_matches_server(&saved_server, queue.count());
            let server = SERVER_URL.to_string();
            let token = if compatible_queue {
                credential(&server).ok().and_then(|e| e.get_password().ok())
            } else {
                None
            };
            let signed_in = token.is_some();
            let shared = Arc::new(Mutex::new(Runtime {
                queue,
                server,
                token,
                session: None,
                pending_stop: None,
                elapsed: 0.0,
                active: 0.0,
                segment: 0.0,
                segment_start: utc_now(),
                next_capture: 600.0,
                last: Instant::now(),
                paused: false,
                update_reserved: false,
                update: Default::default(),
                pending_update: None,
                diagnostics: diagnostics::Diagnostics::signed_in(signed_in),
                location: Default::default(),
                applications: Default::default(),
                shutting_down: false,
                error: if compatible_queue { None } else { Some("Unsynced records belong to another server. Sync using version 0.1.0 before upgrading. No records were moved or deleted.".into()) },
            }));
            app.manage(shared.clone());
            let show =
                MenuItem::with_id(app, "show", "Open / Start tracking...", true, None::<&str>)?;
            let stop_item = MenuItem::with_id(app, "stop", "Stop tracking", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Stop and quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &stop_item, &quit])?;
            TrayIconBuilder::with_id("tracker")
                .icon(icon(false))
                .tooltip("WorkTrack - tracking OFF")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "stop" | "quit" => {
                        if let Ok(mut r) = app.state::<Shared>().lock() {
                            if r.update_reserved { return; }
                            if let Err(e) = stop_runtime(&mut r) {
                                r.error = Some(e);
                                if event.id.as_ref() == "quit" { return; }
                            }
                            if event.id.as_ref() == "quit" {
                                r.shutting_down = true;
                            }
                        }
                        if event.id.as_ref() == "quit" {
                            app.exit(0);
                        }
                    }
                    _ => (),
                })
                .build(app)?;
            let collector = shared.clone();
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut last = None;
                loop {
                    std::thread::sleep(Duration::from_millis(100));
                    collect_tick(&collector, &mut last, |tracking, paused| {
                        if let Some(tray) = handle.tray_by_id("tracker") {
                            let icon_updated = tray.set_icon(Some(icon(tracking))).is_ok();
                            let tooltip_updated = tray.set_tooltip(Some(if !tracking {
                                "WorkTrack - tracking OFF"
                            } else if paused {
                                "WorkTrack - PAUSED"
                            } else {
                                "WorkTrack - tracking ON"
                            })).is_ok();
                            icon_updated && tooltip_updated
                        } else { false }
                    });
                }
            });
            let location_worker = shared.clone();
            std::thread::spawn(move || location::run(location_worker));
            let diagnostic_sender = shared.clone();
            std::thread::spawn(move || diagnostics::run(diagnostic_sender));
            let heartbeat = shared.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(30));
                let auth = heartbeat.lock().ok().and_then(|r| {
                    if r.session.is_some() && !r.paused {
                        r.token.clone().map(|token| (r.server.clone(), token))
                    } else {
                        None
                    }
                });
                if let Some((server, token)) = auth {
                    let response = client().ok().and_then(|http| http
                        .post(format!("{server}/api/heartbeat"))
                        .bearer_auth(&token)
                        .json(&json!({}))
                        .send().ok());
                    if !response.as_ref().is_some_and(|response| response.status().is_success()) {
                        if let Ok(mut r) = heartbeat.try_lock() {
                            if r.token.as_ref() == Some(&token) && r.server == server {
                                r.diagnostics.record(LogCode::HeartbeatFailed, response.map(|response| response.status().as_u16()));
                            }
                        }
                    }
                }
            });
            std::thread::spawn(move || {
                let mut delay = 1;
                loop {
                    match sync_one(&shared) {
                        Ok(true) => {
                            delay = 1;
                            continue;
                        }
                        Ok(false) => {
                            delay = 1;
                        }
                        Err(e) => {
                            if let Ok(mut r) = shared.lock() {
                                r.diagnostics.record(LogCode::SyncFailed, None);
                                r.error = Some(e);
                            }
                            delay = (delay * 2).min(300);
                        }
                    }
                    std::thread::sleep(Duration::from_secs(delay));
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if let Ok(mut r) = window.state::<Shared>().lock() {
                    if !r.update_reserved {
                        if let Err(e) = stop_runtime(&mut r) {
                            r.error = Some(e);
                        }
                    }
                }
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![status, request_screen_capture, open_screen_settings, login, start, stop, logout, location::request_location, location::diagnose_location, location::open_location_settings, updater::check_update, updater::install_update])
        .build(tauri::generate_context!())
        .expect("WorkTrack failed to start")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if let Ok(mut r) = app.state::<Shared>().lock() {
                    if r.update_reserved || r.pending_stop.is_some() {
                        api.prevent_exit();
                    } else {
                        r.shutting_down = true;
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_exposes_native_platform_and_screen_permission_without_prompting() {
        let shared = Arc::new(Mutex::new(runtime()));
        let status = serde_json::to_value(snapshot_status(&shared).unwrap()).unwrap();
        assert_eq!(status["platform"], std::env::consts::OS);
        assert_eq!(
            status["screen_capture_allowed"],
            platform::screen_capture_allowed()
        );
        assert!(status.get("latitude").is_none());
        assert!(status.get("longitude").is_none());
    }

    #[test]
    fn tray_notification_releases_runtime_before_waiting_for_ui_and_only_updates_on_change() {
        let mut r = runtime();
        r.session = None;
        let shared = Arc::new(Mutex::new(r));
        let mut last = None;
        let mut notifications = 0;
        collect_tick(&shared, &mut last, |tracking, paused| {
            let r = shared
                .try_lock()
                .expect("tray/UI must not inherit collector lock");
            assert_eq!(tracking, r.session.is_some());
            assert_eq!(paused, r.paused);
            drop(r);
            assert!(!snapshot_status(&shared).unwrap().tracking);
            notifications += 1;
            true
        });
        collect_tick(&shared, &mut last, |_, _| {
            panic!("unchanged tray state must not be reposted")
        });
        assert_eq!(notifications, 1);
        last = None;
        collect_tick(&shared, &mut last, |_, _| false);
        assert_eq!(last, None, "failed tray updates must remain retryable");
        collect_tick(&shared, &mut last, |_, _| true);
        assert_eq!(last, Some((false, false)));
    }
    #[test]
    fn device_logout_revokes_token_and_handles_retries() {
        use std::io::{Read, Write};
        for (status, success) in [(200, true), (401, true), (503, false)] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let server = format!("http://{}", listener.local_addr().unwrap());
            let worker = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let mut byte = [0u8; 1];
                while !request.ends_with(b"\r\n\r\n") {
                    stream.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                }
                let mut body = [0u8; 2];
                stream.read_exact(&mut body).unwrap();
                assert_eq!(&body, b"{}");
                let text = String::from_utf8(request).unwrap();
                assert!(text.starts_with("POST /api/auth/logout HTTP/1.1\r\n"));
                assert!(text
                    .to_ascii_lowercase()
                    .contains("authorization: bearer test-device\r\n"));
                write!(
                    stream,
                    "HTTP/1.1 {status} Test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .unwrap();
            });
            let result = revoke_device(&server, "test-device");
            assert_eq!(result.is_ok(), success, "status {status}: {result:?}");
            worker.join().unwrap();
        }
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let server = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        assert!(revoke_device(&server, "test-device").is_err());
    }

    #[test]
    fn diagnostics_follow_sign_in_and_location_gates_start() {
        assert!(!diagnostics::Diagnostics::signed_in(false).enabled);
        assert!(diagnostics::Diagnostics::signed_in(true).enabled);
        let mut r = runtime();
        r.token = Some("test".into());
        r.location.enabled = false;
        assert!(require_location(&r).is_err());
        r.location.enabled = true;
        assert!(require_location(&r).is_ok());
    }

    #[test]
    fn collection_failures_create_codes_only_when_diagnostics_are_enabled() {
        let mut r = runtime();
        r.diagnostics.configure(false);
        assert!(sample_tick(&mut r, 1.0, true, None, None, || panic!("capture")).is_err());
        assert_eq!(r.diagnostics.count(), 0);
        r.token = Some("test".into());
        r.diagnostics.configure(true);
        assert!(sample_tick(&mut r, 1.0, true, None, None, || panic!("capture")).is_err());
        assert_eq!(r.diagnostics.count(), 1);
        r.elapsed = 599.0;
        assert!(sample_tick(&mut r, 1.0, true, Some(0.0), None, || Err(
            "private OS error or URL must stay local".into()
        ))
        .is_err());
        assert_eq!(r.diagnostics.count(), 2);
    }

    #[test]
    fn fixed_server_preserves_queue_ownership() {
        assert_eq!(SERVER_URL, "https://worktrack.178.156.213.40.sslip.io");
        assert!(queue_matches_server("", 0));
        assert!(queue_matches_server(SERVER_URL, 3));
        assert!(queue_matches_server("https://previous.invalid", 0));
        assert!(!queue_matches_server("https://previous.invalid", 3));
        assert!(!queue_matches_server("", 3));
    }

    pub(crate) fn runtime() -> Runtime {
        Runtime {
            queue: Queue::open(std::path::Path::new(":memory:")).unwrap(),
            server: String::new(),
            token: None,
            session: Some(uuid::Uuid::new_v4().to_string()),
            pending_stop: None,
            elapsed: 0.0,
            active: 0.0,
            segment: 0.0,
            segment_start: utc_now(),
            next_capture: 600.0,
            last: Instant::now(),
            paused: false,
            error: None,
            update_reserved: false,
            update: Default::default(),
            pending_update: None,
            diagnostics: Default::default(),
            location: Default::default(),
            applications: Default::default(),
            shutting_down: false,
        }
    }
    #[test]
    fn captures_only_at_fixed_elapsed_boundaries() {
        let mut r = runtime();
        let mut captures = Vec::new();
        for second in 1..=1800 {
            sample_tick(&mut r, 1.0, true, Some(0.0), Some("chrome.exe"), || {
                captures.push(second);
                Ok(vec![1, 2, 3])
            })
            .unwrap();
        }
        assert_eq!(captures, vec![600, 1200, 1800]);
        assert_eq!(r.elapsed, 1800.0);
        let mut screenshots = 0;
        while let Some(item) = r.queue.first().unwrap() {
            let body: serde_json::Value = serde_json::from_str(&item.json).unwrap();
            let block = &body["blocks"][0];
            assert_eq!(block["application_usage"][0]["app"], "chrome.exe");
            assert!(
                block["application_usage"][0]["milliseconds"]
                    .as_u64()
                    .unwrap()
                    <= 30000
            );
            if item.image.is_some() {
                screenshots += 1;
                assert_eq!(block["location"]["status"], "disabled");
            } else {
                assert!(block["location"].is_null());
            }
            r.queue.ack(item.id).unwrap();
        }
        assert_eq!(screenshots, 3);
    }
    #[test]
    fn stopped_locked_and_suspend_never_capture_or_count() {
        let mut r = runtime();
        r.elapsed = 599.0;
        sample_tick(
            &mut r,
            1.0,
            false,
            None,
            Some("must-not-record.exe"),
            || panic!("locked capture"),
        )
        .unwrap();
        assert_eq!(r.elapsed, 599.0);
        sample_tick(
            &mut r,
            3600.0,
            true,
            Some(0.0),
            Some("must-not-record.exe"),
            || panic!("suspend capture"),
        )
        .unwrap();
        sample_tick(
            &mut r,
            1.0,
            true,
            Some(0.0),
            Some("must-not-record.exe"),
            || panic!("resume catchup"),
        )
        .unwrap();
        assert_eq!(r.elapsed, 599.0);
        r.session = None;
        sample_tick(&mut r, 1.0, true, None, Some("must-not-record.exe"), || {
            panic!("off capture")
        })
        .unwrap();
        assert_eq!(r.elapsed, 599.0);
        assert!(r.applications.snapshot(600).is_empty());
    }
    #[test]
    fn partial_stop_is_integer_seconds_and_idempotent() {
        let mut r = runtime();
        r.segment_start -= chrono::Duration::seconds(15);
        r.segment = 12.8;
        r.active = 5.9;
        stop_runtime(&mut r).unwrap();
        let item = r.queue.first().unwrap().unwrap();
        let body: serde_json::Value = serde_json::from_str(&item.json).unwrap();
        assert_eq!(body["blocks"][0]["active_seconds"], 5);
        let block = &body["blocks"][0];
        let start =
            chrono::DateTime::parse_from_rfc3339(block["start_at"].as_str().unwrap()).unwrap();
        let end = chrono::DateTime::parse_from_rfc3339(block["end_at"].as_str().unwrap()).unwrap();
        assert_eq!((end - start).num_seconds(), 12);
        assert_eq!(start.timestamp_subsec_nanos(), 0);
        assert_eq!(r.queue.count(), 2);
        stop_runtime(&mut r).unwrap();
        assert_eq!(r.queue.count(), 2);
    }
    #[test]
    fn status_exposes_pending_stop_until_records_are_saved() {
        let mut r = runtime();
        let id = r.session.take().unwrap();
        r.queue.set("active_session", &id).unwrap();
        r.pending_stop = Some((id, utc_now()));
        let shared = Arc::new(Mutex::new(r));
        let status = snapshot_status(&shared).unwrap();
        assert!(status.stopping);
        assert!(!status.tracking);
        assert_eq!(status.queued, 0);
        stop_runtime(&mut shared.lock().unwrap()).unwrap();
        assert!(!snapshot_status(&shared).unwrap().stopping);
    }
    #[test]
    fn failed_final_writes_stop_collection_and_retry_without_losing_time() {
        for failed_path in ["/api/blocks", "/api/sessions/stop"] {
            let mut r = runtime();
            let id = r.session.clone().unwrap();
            r.queue.set("active_session", &id).unwrap();
            r.segment_start -= chrono::Duration::seconds(90);
            r.segment = 12.8;
            r.elapsed = 42.8;
            r.active = 5.9;
            r.applications.record(Some("editor.exe"), 12.8);
            r.queue.0.execute_batch(&format!(
                "CREATE TRIGGER fail_final_write BEFORE INSERT ON queue WHEN NEW.path='{failed_path}' BEGIN SELECT RAISE(FAIL, 'disk write failed'); END;"
            )).unwrap();

            assert!(stop_runtime(&mut r).is_err());
            assert!(
                r.session.is_none(),
                "monitoring must stop even when disk writes fail"
            );
            assert!(r.pending_stop.is_some());
            assert_eq!(r.queue.get("active_session").as_deref(), Some(id.as_str()));
            if failed_path == "/api/blocks" {
                assert_eq!(r.segment, 12.8);
                assert_eq!(r.active, 5.9);
                assert_eq!(r.queue.count(), 0);
            } else {
                assert_eq!(r.queue.count(), 1);
            }
            let stopped_at = utc_now() - chrono::Duration::seconds(60);
            r.pending_stop.as_mut().unwrap().1 = stopped_at;
            r.last = Instant::now() - Duration::from_secs(60);
            assert!(tick(&mut r).is_err());
            assert_eq!(r.elapsed, 42.8, "retry must not invent tracked time");
            assert_eq!(r.pending_stop.as_ref().unwrap().1, stopped_at);
            r.queue
                .0
                .execute_batch("DROP TRIGGER fail_final_write")
                .unwrap();
            tick(&mut r).unwrap();

            assert!(r.pending_stop.is_none());
            assert!(r.session.is_none());
            assert_eq!(r.elapsed, 42.8);
            assert_eq!(r.queue.get("active_session").as_deref(), Some(""));
            assert_eq!(r.queue.count(), 2);
            let block = r.queue.first().unwrap().unwrap();
            let payload: serde_json::Value = serde_json::from_str(&block.json).unwrap();
            assert_eq!(payload["blocks"][0]["session_id"], id);
            assert_eq!(payload["blocks"][0]["active_seconds"], 5);
            assert_eq!(
                payload["blocks"][0]["application_usage"][0]["app"],
                "editor.exe"
            );
            let start = chrono::DateTime::parse_from_rfc3339(
                payload["blocks"][0]["start_at"].as_str().unwrap(),
            )
            .unwrap();
            let end = chrono::DateTime::parse_from_rfc3339(
                payload["blocks"][0]["end_at"].as_str().unwrap(),
            )
            .unwrap();
            assert_eq!((end - start).num_seconds(), 12);
            r.queue.ack(block.id).unwrap();
            let stop = r.queue.first().unwrap().unwrap();
            let payload: serde_json::Value = serde_json::from_str(&stop.json).unwrap();
            assert_eq!(payload["id"], id);
            assert_eq!(payload["stopped_at"], json!(stopped_at));
            stop_runtime(&mut r).unwrap();
            assert_eq!(
                r.queue.count(),
                1,
                "retry must not duplicate blocks or stops"
            );
        }
    }
    #[test]
    fn refused_head_is_held_for_a_day_then_set_aside() {
        let mut r = runtime();
        r.diagnostics.enabled = true;
        r.queue
            .push("/api/blocks", &json!({"id":"bad"}), None)
            .unwrap();
        r.queue
            .push("/api/blocks", &json!({"id":"good"}), None)
            .unwrap();
        let id = r.queue.first().unwrap().unwrap().id;
        let t0 = utc_now();
        assert!(!hold_or_reject(&mut r, id, 409, t0).unwrap());
        assert!(!hold_or_reject(&mut r, id, 409, t0 + chrono::Duration::hours(23)).unwrap());
        assert_eq!(r.queue.count(), 2);
        assert!(hold_or_reject(&mut r, id, 409, t0 + chrono::Duration::hours(24)).unwrap());
        assert_eq!((r.queue.count(), r.queue.rejected_count()), (1, 1));
        assert!(r.queue.first().unwrap().unwrap().json.contains("good"));
        assert_eq!(r.diagnostics.count(), 1);
        // The streak continues: the next refused record is set aside at once.
        let next = r.queue.first().unwrap().unwrap().id;
        assert!(hold_or_reject(&mut r, next, 400, t0 + chrono::Duration::hours(25)).unwrap());
        assert_eq!(r.queue.count(), 0);
        // An accepted record clears the streak, so a later refusal waits again.
        r.queue.set(HEAD_REJECTED, "").unwrap();
        r.queue
            .push("/api/blocks", &json!({"id":"later"}), None)
            .unwrap();
        let later = r.queue.first().unwrap().unwrap().id;
        assert!(!hold_or_reject(&mut r, later, 400, t0 + chrono::Duration::hours(48)).unwrap());
        assert!(permanent_rejection(reqwest::StatusCode::CONFLICT));
        assert!(!permanent_rejection(reqwest::StatusCode::UNAUTHORIZED));
        assert!(!permanent_rejection(reqwest::StatusCode::TOO_MANY_REQUESTS));
        assert!(!permanent_rejection(
            reqwest::StatusCode::SERVICE_UNAVAILABLE
        ));
    }
    #[test]
    fn missing_activity_fails_closed() {
        let mut r = runtime();
        assert!(sample_tick(&mut r, 1.0, true, None, None, || panic!("capture")).is_err());
        assert_eq!(r.elapsed, 0.0);
    }
    #[test]
    fn failed_block_post_retries_without_uploading_again() {
        upload_retry_case(false);
    }
    #[test]
    fn expired_reservation_reuploads_retained_image() {
        upload_retry_case(true);
    }
    fn upload_retry_case(expired: bool) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let server = format!("http://{}", listener.local_addr().unwrap());
        let upload_url = format!("{server}/object");
        let block_id = uuid::Uuid::new_v4().to_string();
        let expected_id = block_id.clone();
        let worker = std::thread::spawn(move || {
            let mut paths = vec!["/api/uploads/screenshot-url", "/object", "/api/blocks"];
            if expired {
                paths.extend(["/api/uploads/screenshot-url", "/object"]);
            }
            paths.push("/api/blocks");
            for (index, expected) in paths.iter().enumerate() {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0u8; 4096];
                loop {
                    let n = stream.read(&mut buffer).unwrap();
                    assert!(n > 0);
                    request.extend_from_slice(&buffer[..n]);
                    if let Some(end) = request.windows(4).position(|b| b == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&request[..end]);
                        let length = header
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length: ")
                                    .and_then(|s| s.parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                let text = String::from_utf8_lossy(&request);
                assert!(text.lines().next().unwrap().contains(expected));
                if *expected == "/api/uploads/screenshot-url" {
                    assert!(text.contains("\"size_bytes\":3"));
                    assert!(text.contains(&expected_id));
                }
                if *expected == "/object" {
                    assert!(!text.to_ascii_lowercase().contains("authorization:"));
                    assert!(request.ends_with(&[1, 2, 3]));
                }
                if *expected == "/api/blocks" {
                    assert!(text.contains("\"screenshot_key\":\"stable\""));
                    assert!(text.contains(&expected_id));
                }
                let body = if *expected == "/api/uploads/screenshot-url" {
                    json!({"upload_url":upload_url,"object_key":"stable"}).to_string()
                } else if index == 2 && expired {
                    json!({"code":"upload_expired","error":"reservation expired"}).to_string()
                } else {
                    "{}".into()
                };
                let status = if index == 2 {
                    if expired {
                        "400 Bad Request"
                    } else {
                        "500 Internal Server Error"
                    }
                } else {
                    "200 OK"
                };
                write!(stream,"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
        });
        let mut r = runtime();
        r.server = server;
        r.token = Some("test-device".into());
        r.queue
            .push(
                "/api/blocks",
                &json!({"blocks":[{"id":block_id}]}),
                Some(&[1, 2, 3]),
            )
            .unwrap();
        let shared = Arc::new(Mutex::new(r));
        assert!(sync_one(&shared).is_err());
        let retained = shared.lock().unwrap().queue.first().unwrap().unwrap();
        assert_eq!(retained.image.as_deref(), Some([1, 2, 3].as_slice()));
        let payload: serde_json::Value = serde_json::from_str(&retained.json).unwrap();
        assert_eq!(
            payload["blocks"][0]["screenshot_key"].as_str().is_none(),
            expired
        );
        assert!(sync_one(&shared).unwrap());
        assert_eq!(shared.lock().unwrap().queue.count(), 0);
        worker.join().unwrap();
    }
}
