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

const SERVER_URL: &str = "https://worktrack.178.156.213.40.sslip.io";

fn queue_matches_server(saved_server: &str, pending: usize) -> bool {
    pending == 0 || saved_server == SERVER_URL
}

struct Runtime {
    queue: Queue,
    server: String,
    token: Option<String>,
    session: Option<String>,
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
    authenticated: bool,
    tracking: bool,
    paused: bool,
    elapsed: f64,
    next_capture: f64,
    queued: usize,
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
        authenticated: r.token.is_some(),
        tracking: r.session.is_some(),
        paused: r.paused,
        elapsed: r.elapsed,
        next_capture: (r.next_capture - r.elapsed).max(0.0),
        queued: r.queue.count(),
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
fn configure_diagnostics(r: &mut Runtime, enabled: bool) -> Result<(), String> {
    if enabled {
        updater::ensure_not_reserved(r)?;
        if r.token.is_none() {
            return Err("Sign in before enabling diagnostic uploads".into());
        }
    }
    if r.diagnostics.enabled != enabled {
        r.diagnostics.configure(enabled);
    }
    Ok(())
}
#[tauri::command]
fn set_diagnostics(state: State<Shared>, enabled: bool) -> Result<(), String> {
    let mut r = state.lock().map_err(|e| e.to_string())?;
    configure_diagnostics(&mut r, enabled)
}
#[tauri::command]
async fn login(state: State<'_, Shared>, email: String, password: String) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let server = SERVER_URL.to_string();
        let mut r = state.lock().map_err(|e| e.to_string())?;
        updater::ensure_not_reserved(&r)?;
        if r.session.is_some() { return Err("Stop tracking before signing in".into()); }
        if !queue_matches_server(&r.queue.get("server").unwrap_or_default(), r.queue.count()) { return Err("This installation has unsynced records for another server. Sync them using version 0.1.0 before upgrading. No records were moved or deleted.".into()); }
        if r.queue.count() > 0 && r.queue.get("email").as_deref() != Some(email.trim().to_lowercase().as_str()) { return Err("Queued records belong to another account. Use that account to sync first.".into()); }
        let response = client()?.post(format!("{server}/api/auth/login")).json(&json!({"email":&email,"password":password,"device_name":std::env::var("COMPUTERNAME").unwrap_or_else(|_| "WorkTrack desktop".into())})).send().map_err(|_| { r.diagnostics.record(LogCode::LoginFailed, None); "Cannot reach server".to_string() })?;
        if !response.status().is_success() { r.diagnostics.record(LogCode::LoginFailed, Some(response.status().as_u16())); return Err(format!("Login rejected ({})", response.status())); }
        let body: serde_json::Value = response.json().map_err(|_| "Invalid login response")?;
        let token = body["device_token"].as_str().ok_or("Missing device token")?.to_string();
        // Fail closed rather than silently putting a device token in SQLite.
        credential(&server)?.set_password(&token).map_err(|_| "Could not save device token in OS credential storage")?;
        r.queue.set("email", &email.trim().to_lowercase())?;
        r.queue.set("server", &server)?;
        r.diagnostics.configure(false);
        r.location.reset();
        r.server = server; r.token = Some(token); r.error = None;
        Ok(())
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
fn start(state: State<Shared>, consent: bool) -> Result<(), String> {
    let mut r = state.lock().map_err(|e| e.to_string())?;
    updater::ensure_not_reserved(&r)?;
    if !cfg!(windows) {
        return Err("Tracking is supported only on Windows in V1".into());
    }
    if !consent || r.token.is_none() {
        return Err("Sign in and accept the monitoring disclosure first".into());
    }
    if r.session.is_some() {
        return Ok(());
    }
    if !platform::unlocked() {
        return Err("Unlock your normal Windows desktop first".into());
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
    if r.session.is_none() {
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
        q.push("/api/blocks", &json!({"blocks":[{"id":uuid::Uuid::new_v4().to_string(),"session_id":r.session,"start_at":r.segment_start,"end_at":end,"active_seconds":(r.active.floor() as i64).min(seconds),"location":location,"application_usage":applications}]}), image)?;
        q.set("checkpoint", &end.to_rfc3339())
    }).inspect_err(|_| r.diagnostics.record(LogCode::QueueFailed, None))?;
    r.segment -= seconds as f64;
    r.applications.clear();
    r.active = 0.0;
    r.segment_start = end;
    Ok(())
}
fn stop_runtime(r: &mut Runtime) -> Result<(), String> {
    let block_result = flush_block(r, None);
    if let Some(id) = r.session.take() {
        // Collection is stopped before any fallible disk work.
        r.queue
            .atomic(|q| {
                q.push(
                    "/api/sessions/stop",
                    &json!({"id":id,"stopped_at":utc_now()}),
                    None,
                )?;
                q.set("active_session", "")
            })
            .inspect_err(|_| r.diagnostics.record(LogCode::QueueFailed, None))?;
    }
    if block_result.is_err() {
        r.segment = 0.0;
        r.active = 0.0;
    }
    block_result
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
        if r.session.is_some() || r.queue.first()?.is_some() {
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
        return Err(format!(
            "Sync rejected ({}). Records retained. Sign-in may need renewal.",
            status
        ));
    }
    let mut r = shared.lock().map_err(|e| e.to_string())?;
    r.queue.ack(item.id)?;
    r.error = None;
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
            let shared = Arc::new(Mutex::new(Runtime {
                queue,
                server,
                token,
                session: None,
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
                diagnostics: Default::default(),
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
        .invoke_handler(tauri::generate_handler![status, login, start, stop, logout, set_diagnostics, location::set_location, updater::check_update, updater::install_update])
        .build(tauri::generate_context!())
        .expect("WorkTrack failed to start")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if let Ok(mut r) = app.state::<Shared>().lock() {
                    if r.update_reserved {
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
    fn diagnostic_consent_requires_sign_in_but_opt_out_survives_update_reservation() {
        let mut r = runtime();
        assert!(configure_diagnostics(&mut r, true).is_err());
        assert!(!r.diagnostics.enabled);
        r.token = Some("test".into());
        configure_diagnostics(&mut r, true).unwrap();
        r.diagnostics.record(LogCode::SyncFailed, None);
        configure_diagnostics(&mut r, true).unwrap();
        assert_eq!(r.diagnostics.count(), 1);
        r.update_reserved = true;
        configure_diagnostics(&mut r, false).unwrap();
        assert!(!r.diagnostics.enabled);
        assert_eq!(r.diagnostics.count(), 0);
        assert!(configure_diagnostics(&mut r, true).is_err());
    }

    #[test]
    fn collection_failures_create_codes_only_when_diagnostics_are_enabled() {
        let mut r = runtime();
        configure_diagnostics(&mut r, false).unwrap();
        assert!(sample_tick(&mut r, 1.0, true, None, None, || panic!("capture")).is_err());
        assert_eq!(r.diagnostics.count(), 0);
        r.token = Some("test".into());
        configure_diagnostics(&mut r, true).unwrap();
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
