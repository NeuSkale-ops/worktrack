#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod platform;
mod queue;
use chrono::Utc;
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
fn status(state: State<Shared>) -> Result<Status, String> {
    let r = state.lock().map_err(|e| e.to_string())?;
    Ok(Status {
        authenticated: r.token.is_some(),
        tracking: r.session.is_some(),
        paused: r.paused,
        elapsed: r.elapsed,
        next_capture: (r.next_capture - r.elapsed).max(0.0),
        queued: r.queue.count(),
        error: r.error.clone(),
        server: r.server.clone(),
    })
}
#[tauri::command]
async fn login(
    state: State<'_, Shared>,
    server: String,
    email: String,
    password: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let url = reqwest::Url::parse(server.trim()).map_err(|_| "Invalid server URL")?;
        let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if url.scheme() != "https" && !(url.scheme() == "http" && local) { return Err("HTTPS is required except on localhost".into()); }
        if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() || url.path() != "/" { return Err("Use a server origin without a path, query, or credentials".into()); }
        let server = url.as_str().trim_end_matches('/').to_string();
        let mut r = state.lock().map_err(|e| e.to_string())?;
        if r.session.is_some() { return Err("Stop tracking before signing in".into()); }
        if r.queue.count() > 0 && (r.server != server || r.queue.get("email").as_deref() != Some(email.trim().to_lowercase().as_str())) { return Err("Queued records belong to another account. Use that account to sync first.".into()); }
        let response = client()?.post(format!("{server}/api/auth/login")).json(&json!({"email":&email,"password":password,"device_name":std::env::var("COMPUTERNAME").unwrap_or_else(|_| "WorkTrack desktop".into())})).send().map_err(|_| "Cannot reach server".to_string())?;
        if !response.status().is_success() { return Err(format!("Login rejected ({})", response.status())); }
        let body: serde_json::Value = response.json().map_err(|_| "Invalid login response")?;
        let token = body["device_token"].as_str().ok_or("Missing device token")?.to_string();
        // Fail closed rather than silently putting a device token in SQLite.
        credential(&server)?.set_password(&token).map_err(|_| "Could not save device token in OS credential storage")?;
        r.queue.set("email", &email.trim().to_lowercase())?;
        r.queue.set("server", &server)?;
        r.server = server; r.token = Some(token); r.error = None;
        Ok(())
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
fn start(state: State<Shared>, consent: bool) -> Result<(), String> {
    let mut r = state.lock().map_err(|e| e.to_string())?;
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
    r.queue.atomic(|q| {
        q.push(
            "/api/sessions/start",
            &json!({"id":id,"started_at":started}),
            None,
        )?;
        q.set("active_session", &id)?;
        q.set("checkpoint", &started.to_rfc3339())
    })?;
    r.session = Some(id);
    r.segment = 0.0;
    r.segment_start = started;
    r.elapsed = 0.0;
    r.active = 0.0;
    r.next_capture = 600.0;
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
    r.queue.atomic(|q| {
        q.push("/api/blocks", &json!({"blocks":[{"id":uuid::Uuid::new_v4().to_string(),"session_id":r.session,"start_at":r.segment_start,"end_at":end,"active_seconds":(r.active.floor() as i64).min(seconds)}]}), image)?;
        q.set("checkpoint", &end.to_rfc3339())
    })?;
    r.segment -= seconds as f64;
    r.active = 0.0;
    r.segment_start = end;
    Ok(())
}
fn stop_runtime(r: &mut Runtime) -> Result<(), String> {
    let block_result = flush_block(r, None);
    if let Some(id) = r.session.take() {
        // Collection is stopped before any fallible disk work.
        r.queue.atomic(|q| {
            q.push(
                "/api/sessions/stop",
                &json!({"id":id,"stopped_at":utc_now()}),
                None,
            )?;
            q.set("active_session", "")
        })?;
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
    stop_runtime(&mut r)
}
#[tauri::command]
fn logout(state: State<Shared>) -> Result<(), String> {
    let mut r = state.lock().map_err(|e| e.to_string())?;
    if r.session.is_some() || r.queue.count() > 0 {
        return Err("Stop and sync before signing out".into());
    }
    credential(&r.server)?
        .delete_credential()
        .map_err(|e| e.to_string())?;
    r.token = None;
    Ok(())
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
    sample_tick(r, dt, unlocked, idle, screenshot)
}
fn sample_tick(
    r: &mut Runtime,
    dt: f64,
    unlocked: bool,
    idle: Option<f64>,
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
    let idle = idle.ok_or("Windows activity sampling failed")?;
    r.elapsed += dt;
    r.segment += dt;
    if idle < 1.0 {
        r.active += dt;
    }
    if r.elapsed >= r.next_capture {
        // Fixed elapsed boundaries, never randomized or caught up after lock/sleep.
        r.next_capture += 600.0;
        let bytes = capture()?;
        flush_block(r, Some(&bytes))?;
    } else if r.segment >= 30.0 {
        flush_block(r, None)?;
    }
    Ok(())
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
    if let Some(bytes) = item.image {
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
            .body(bytes)
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
    let response = http
        .post(format!("{server}{}", item.path))
        .bearer_auth(token)
        .json(&payload)
        .send()
        .map_err(|_| "Offline: queued data will retry automatically".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Sync rejected ({}). Records retained. Sign-in may need renewal.",
            response.status()
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
            let server = queue.get("server").unwrap_or_default();
            let token = credential(&server).ok().and_then(|e| e.get_password().ok());
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
                error: None,
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
                            if let Err(e) = stop_runtime(&mut r) {
                                r.error = Some(e);
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
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(100));
                if let Ok(mut r) = collector.lock() {
                    if let Err(e) = tick(&mut r) {
                        let _ = stop_runtime(&mut r);
                        r.error = Some(e);
                    }
                    if let Some(tray) = handle.tray_by_id("tracker") {
                        let _ = tray.set_icon(Some(icon(r.session.is_some())));
                        let _ = tray.set_tooltip(Some(if r.session.is_none() {
                            "WorkTrack - tracking OFF"
                        } else if r.paused {
                            "WorkTrack - PAUSED"
                        } else {
                            "WorkTrack - tracking ON"
                        }));
                    }
                }
            });
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
                    if let Ok(http) = client() {
                        let _ = http
                            .post(format!("{server}/api/heartbeat"))
                            .bearer_auth(token)
                            .json(&json!({}))
                            .send();
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
                    if let Err(e) = stop_runtime(&mut r) {
                        r.error = Some(e);
                    }
                }
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![status, login, start, stop, logout])
        .run(tauri::generate_context!())
        .expect("WorkTrack failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;
    fn runtime() -> Runtime {
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
        }
    }
    #[test]
    fn captures_only_at_fixed_elapsed_boundaries() {
        let mut r = runtime();
        let mut captures = Vec::new();
        for second in 1..=1800 {
            sample_tick(&mut r, 1.0, true, Some(0.0), || {
                captures.push(second);
                Ok(vec![1, 2, 3])
            })
            .unwrap();
        }
        assert_eq!(captures, vec![600, 1200, 1800]);
        assert_eq!(r.elapsed, 1800.0);
    }
    #[test]
    fn stopped_locked_and_suspend_never_capture_or_count() {
        let mut r = runtime();
        r.elapsed = 599.0;
        sample_tick(&mut r, 1.0, false, None, || panic!("locked capture")).unwrap();
        assert_eq!(r.elapsed, 599.0);
        sample_tick(&mut r, 3600.0, true, Some(0.0), || {
            panic!("suspend capture")
        })
        .unwrap();
        sample_tick(&mut r, 1.0, true, Some(0.0), || panic!("resume catchup")).unwrap();
        assert_eq!(r.elapsed, 599.0);
        r.session = None;
        sample_tick(&mut r, 1.0, true, None, || panic!("off capture")).unwrap();
        assert_eq!(r.elapsed, 599.0);
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
        assert!(sample_tick(&mut r, 1.0, true, None, || panic!("capture")).is_err());
        assert_eq!(r.elapsed, 0.0);
    }
    #[test]
    fn failed_block_post_retries_without_uploading_again() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let server = format!("http://{}", listener.local_addr().unwrap());
        let upload_url = format!("{server}/object");
        let worker = std::thread::spawn(move || {
            for (index, expected) in [
                "/api/uploads/screenshot-url",
                "/object",
                "/api/blocks",
                "/api/blocks",
            ]
            .iter()
            .enumerate()
            {
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
                if index == 0 {
                    assert!(text.contains("\"size_bytes\":3"));
                }
                if index == 1 {
                    assert!(!text.to_ascii_lowercase().contains("authorization:"));
                }
                if index >= 2 {
                    assert!(text.contains("\"screenshot_key\":\"stable\""));
                }
                let body = if index == 0 {
                    json!({"upload_url":upload_url,"object_key":"stable"}).to_string()
                } else {
                    "{}".into()
                };
                let status = if index == 2 {
                    "500 Internal Server Error"
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
                &json!({"blocks":[{"id":uuid::Uuid::new_v4().to_string()}]}),
                Some(&[1, 2, 3]),
            )
            .unwrap();
        let shared = Arc::new(Mutex::new(r));
        assert!(sync_one(&shared).is_err());
        assert!(shared
            .lock()
            .unwrap()
            .queue
            .first()
            .unwrap()
            .unwrap()
            .image
            .is_none());
        assert!(sync_one(&shared).unwrap());
        assert_eq!(shared.lock().unwrap().queue.count(), 0);
        worker.join().unwrap();
    }
}
