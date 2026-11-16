//! worktrack-session: per-user helper launched by the service into each
//! interactive session. It is the only part that touches the user's desktop:
//!   - Shows the monitoring notice on first logon and records acknowledgment.
//!   - Keeps a visible tray icon while it runs, stating whether monitoring is
//!     active or paused. Clicking it shows the notice again.
//!   - Samples foreground executable, idle time and lock state once a second,
//!     takes fixed-cadence screenshots and one location fix per screenshot when
//!     the admin enabled them, applies exclusions, and hands everything to the
//!     service over a local named pipe.
//!
//! No keyboard hooks or key-state APIs: CI fails the build if they appear.
//!
//! Windows-only; stub elsewhere so the workspace builds cross-platform.

#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(not(windows))]
fn main() {
    eprintln!("worktrack-session runs inside a Windows user session.");
}

#[cfg(windows)]
fn main() {
    win::run();
}

#[cfg(windows)]
mod win {
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{
        GetLastError, ERROR_ALREADY_EXISTS, HWND, LPARAM, LRESULT, WPARAM,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::CreateMutexW;
    use windows::Win32::UI::Shell::{
        Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NIM_MODIFY,
        NOTIFYICONDATAW,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, LoadIconW, MessageBoxW, PeekMessageW,
        RegisterClassW, TranslateMessage, HWND_MESSAGE, IDI_INFORMATION, MB_ICONINFORMATION, MB_OK,
        MB_SETFOREGROUND, MB_TOPMOST, MSG, PM_REMOVE, WINDOW_EX_STYLE, WINDOW_STYLE, WM_APP,
        WM_LBUTTONUP, WNDCLASSW,
    };

    use worktrack_managed::activity::Aggregator;
    use worktrack_managed::ipc::{self, Reply, Request};
    use worktrack_managed::{redact, Config};

    const TRAY_MSG: u32 = WM_APP + 1;
    const POLL_EVERY: Duration = Duration::from_secs(5);

    const NOTICE_TITLE: PCWSTR = w!("Welcome to QuantiPeak");
    const NOTICE: PCWSTR = w!("Welcome to QuantiPeak.\n\n\
This is a company device. While you are signed in.");

    // ---- pipe client ------------------------------------------------------

    fn call(req: &Request, attachment: &[u8]) -> Option<Reply> {
        for _ in 0..10 {
            match std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(ipc::PIPE_NAME)
            {
                Ok(mut pipe) => {
                    ipc::write_msg(&mut pipe, req, attachment).ok()?;
                    return ipc::read_msg::<_, Reply>(&mut pipe).ok().map(|(r, _)| r);
                }
                // All instances busy: the server creates the next one shortly.
                Err(e) if e.raw_os_error() == Some(231) => {
                    std::thread::sleep(Duration::from_millis(50))
                }
                Err(_) => return None,
            }
        }
        None
    }

    fn send(kind: &str, payload: serde_json::Value, attachment: &[u8]) -> bool {
        let req = Request::Event {
            event_id: uuid::Uuid::new_v4().to_string(),
            kind: kind.into(),
            occurred_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            payload,
        };
        call(&req, attachment).map(|r| r.ok).unwrap_or(false)
    }

    // ---- acknowledgment ---------------------------------------------------

    fn ack_path() -> Option<PathBuf> {
        let base = std::env::var_os("LOCALAPPDATA")?;
        Some(PathBuf::from(base).join("WorkTrack").join("acknowledged"))
    }

    fn acknowledged() -> bool {
        ack_path().map(|p| p.exists()).unwrap_or(false)
    }

    fn show_notice() {
        unsafe {
            MessageBoxW(
                None,
                NOTICE,
                NOTICE_TITLE,
                MB_OK | MB_ICONINFORMATION | MB_TOPMOST | MB_SETFOREGROUND,
            );
        }
    }

    /// Blocks until the user closes the notice, then records it locally and with
    /// the service. Capture does not start before this returns.
    fn acknowledge() {
        show_notice();
        if let Some(p) = ack_path() {
            let _ = std::fs::create_dir_all(p.parent().unwrap());
            let _ = std::fs::write(&p, chrono::Utc::now().to_rfc3339());
        }
        send("acknowledged", serde_json::json!({}), &[]);
    }

    // ---- tray -------------------------------------------------------------

    unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        if msg == TRAY_MSG && lp.0 as u32 == WM_LBUTTONUP {
            std::thread::spawn(show_notice);
            return LRESULT(0);
        }
        DefWindowProcW(hwnd, msg, wp, lp)
    }

    struct Tray {
        data: NOTIFYICONDATAW,
        shown: Option<bool>,
    }

    impl Tray {
        fn new() -> Option<Tray> {
            unsafe {
                let instance = GetModuleHandleW(None).ok()?;
                let class = w!("WorkTrackSessionTray");
                let wc = WNDCLASSW {
                    lpfnWndProc: Some(wndproc),
                    hInstance: instance.into(),
                    lpszClassName: class,
                    ..Default::default()
                };
                RegisterClassW(&wc);
                let hwnd = CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    class,
                    w!("QuantiPeak"),
                    WINDOW_STYLE::default(),
                    0,
                    0,
                    0,
                    0,
                    Some(HWND_MESSAGE),
                    None,
                    Some(instance.into()),
                    None,
                )
                .ok()?;
                let data = NOTIFYICONDATAW {
                    cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
                    hWnd: hwnd,
                    uID: 1,
                    uFlags: NIF_ICON | NIF_TIP | NIF_MESSAGE,
                    uCallbackMessage: TRAY_MSG,
                    hIcon: LoadIconW(None, IDI_INFORMATION).ok()?,
                    ..Default::default()
                };
                Some(Tray { data, shown: None })
            }
        }

        /// Update the tooltip. Re-adds the icon if Explorer restarted and lost it.
        fn set(&mut self, active: bool) {
            let tip = if active {
                "QuantiPeak: active"
            } else {
                "QuantiPeak: paused"
            };
            let mut buf = [0u16; 128];
            for (i, c) in tip.encode_utf16().take(127).enumerate() {
                buf[i] = c;
            }
            self.data.szTip = buf;
            unsafe {
                let ok =
                    self.shown.is_some() && Shell_NotifyIconW(NIM_MODIFY, &self.data).as_bool();
                if !ok {
                    let _ = Shell_NotifyIconW(NIM_ADD, &self.data);
                }
            }
            self.shown = Some(active);
        }

        fn pump(&self) {
            unsafe {
                let mut msg = MSG::default();
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
        }
    }

    impl Drop for Tray {
        fn drop(&mut self) {
            unsafe {
                let _ = Shell_NotifyIconW(NIM_DELETE, &self.data);
            }
        }
    }

    // ---- collectors -------------------------------------------------------

    mod platform {
        // Same probes as the personal desktop app. No keyboard hooks: Windows
        // exposes only the timestamp of the last input.
        use std::ffi::c_void;
        #[repr(C)]
        struct LastInput {
            size: u32,
            tick: u32,
        }
        #[link(name = "user32")]
        extern "system" {
            fn GetLastInputInfo(info: *mut LastInput) -> i32;
            fn GetForegroundWindow() -> *mut c_void;
            fn GetWindowThreadProcessId(window: *mut c_void, process: *mut u32) -> u32;
            fn OpenInputDesktop(flags: u32, inherit: i32, access: u32) -> *mut c_void;
            fn CloseDesktop(desktop: *mut c_void) -> i32;
            fn SwitchDesktop(desktop: *mut c_void) -> i32;
            fn GetUserObjectInformationW(
                h: *mut c_void,
                index: i32,
                value: *mut c_void,
                len: u32,
                needed: *mut u32,
            ) -> i32;
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn GetTickCount() -> u32;
            fn OpenProcess(access: u32, inherit: i32, id: u32) -> *mut c_void;
            fn QueryFullProcessImageNameW(
                process: *mut c_void,
                flags: u32,
                path: *mut u16,
                size: *mut u32,
            ) -> i32;
            fn CloseHandle(handle: *mut c_void) -> i32;
        }

        pub fn foreground_app() -> Option<String> {
            unsafe {
                let mut pid = 0;
                let window = GetForegroundWindow();
                if window.is_null() || GetWindowThreadProcessId(window, &mut pid) == 0 {
                    return None;
                }
                let process = OpenProcess(0x1000, 0, pid);
                if process.is_null() {
                    return None;
                }
                let mut path = [0u16; 32768];
                let mut size = path.len() as u32;
                let ok = QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut size);
                CloseHandle(process);
                if ok == 0 || size as usize > path.len() {
                    return None;
                }
                let path = String::from_utf16_lossy(&path[..size as usize]);
                let name = path.rsplit(['\\', '/']).next()?.trim().to_lowercase();
                (!name.is_empty() && !name.chars().any(|c| c.is_control() || c == ':'))
                    .then_some(name)
            }
        }

        pub fn idle_seconds() -> Option<f64> {
            let mut input = LastInput {
                size: std::mem::size_of::<LastInput>() as u32,
                tick: 0,
            };
            unsafe {
                if GetLastInputInfo(&mut input) == 0 {
                    None
                } else {
                    Some(GetTickCount().wrapping_sub(input.tick) as f64 / 1000.0)
                }
            }
        }

        /// True only on the normal user desktop. Lock screen, UAC secure desktop
        /// and any failure count as locked (fail closed).
        pub fn unlocked() -> bool {
            unsafe {
                let desktop = OpenInputDesktop(0, 0, 0x0001 | 0x0100);
                if desktop.is_null() {
                    return false;
                }
                let mut name = [0u16; 128];
                let mut needed = 0;
                let read = GetUserObjectInformationW(
                    desktop,
                    2,
                    name.as_mut_ptr().cast(),
                    256,
                    &mut needed,
                );
                let end = name.iter().position(|c| *c == 0).unwrap_or(name.len());
                let safe = read != 0
                    && String::from_utf16_lossy(&name[..end]).eq_ignore_ascii_case("Default")
                    && SwitchDesktop(desktop) != 0;
                CloseDesktop(desktop);
                safe
            }
        }
    }

    fn capture_jpeg() -> Result<Vec<u8>, String> {
        let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
        let monitor = monitors
            .iter()
            .find(|m| m.is_primary().unwrap_or(false))
            .ok_or("no primary display")?;
        let raw = monitor.capture_image().map_err(|e| e.to_string())?;
        if !platform::unlocked() {
            return Err("desktop changed during capture".into());
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

    /// One location fix, at most 5 seconds. Never continuous.
    fn location() -> serde_json::Value {
        use windows::Devices::Geolocation::{Geolocator, PositionAccuracy};
        use windows::Foundation::TimeSpan;
        let unavailable = serde_json::json!({ "status": "unavailable" });
        let Ok(locator) = Geolocator::new() else {
            return unavailable;
        };
        if locator.SetDesiredAccuracy(PositionAccuracy::High).is_err() {
            return unavailable;
        }
        let Ok(op) = locator.GetGeopositionAsyncWithAgeAndTimeout(
            TimeSpan { Duration: 0 },
            TimeSpan {
                Duration: 50_000_000,
            },
        ) else {
            return unavailable;
        };
        let started = Instant::now();
        loop {
            match op.Status().map(|s| s.0) {
                Ok(0) if started.elapsed() < Duration::from_secs(5) => {
                    std::thread::sleep(Duration::from_millis(100))
                }
                Ok(1) => break,
                _ => {
                    let _ = op.Cancel();
                    return unavailable;
                }
            }
        }
        let fix = op.GetResults().and_then(|p| p.Coordinate()).and_then(|c| {
            Ok(serde_json::json!({
                "status": "available",
                "latitude": c.Latitude()?,
                "longitude": c.Longitude()?,
                "accuracy_m": c.Accuracy()?,
            }))
        });
        fix.unwrap_or(unavailable)
    }

    // ---- main loop --------------------------------------------------------

    pub fn run() {
        // One helper per session. The service relaunches it if it exits.
        unsafe {
            let _ = CreateMutexW(None, false, w!("Local\\WorkTrackSessionHelper"));
            if GetLastError() == ERROR_ALREADY_EXISTS {
                return;
            }
            let _ = windows::Win32::System::WinRT::RoInitialize(
                windows::Win32::System::WinRT::RO_INIT_MULTITHREADED,
            );
        }
        let mut tray = Tray::new();
        let mut state: Option<Reply> = None;
        let mut next_poll = Instant::now();
        let mut last = Instant::now();
        let mut agg = Aggregator::default();
        let mut ack = acknowledged();
        let mut last_ok = Instant::now();

        loop {
            if let Some(t) = tray.as_ref() {
                t.pump();
            }
            let now = Instant::now();
            if now >= next_poll {
                next_poll = now + POLL_EVERY;
                // Service unreachable: keep the last known state for a while,
                // but stop capturing after a minute without confirmation.
                match call(&Request::State, &[]) {
                    Some(r) if r.ok => {
                        state = Some(r);
                        last_ok = now;
                    }
                    Some(_) => state = None,
                    None if now.duration_since(last_ok) > Duration::from_secs(60) => state = None,
                    None => {}
                }
            }
            let capture = state.as_ref().map(|s| s.capture).unwrap_or(false);
            if let Some(t) = tray.as_mut() {
                if t.shown != Some(capture) {
                    t.set(capture);
                }
            }
            if capture && !ack {
                acknowledge();
                ack = true;
                last = Instant::now();
                continue;
            }

            let dt = now.duration_since(last).as_secs_f64();
            last = now;
            if !capture {
                // Paused mid-minute: discard, the admin asked for no capture.
                agg.flush();
                std::thread::sleep(Duration::from_secs(1));
                continue;
            }
            let cfg: Config = state.as_ref().map(|s| s.config.clone()).unwrap_or_default();
            let unlocked = platform::unlocked();
            let idle = if unlocked && cfg.idle_time {
                platform::idle_seconds()
            } else {
                None
            };
            let fg = if unlocked {
                platform::foreground_app()
            } else {
                None
            };
            let app = fg.as_deref().map(|a| redact::apply_exclusion(&cfg, a));
            let interval = cfg.screenshots.then_some(cfg.screenshot_interval_secs);
            let tick = agg.sample(
                dt,
                unlocked,
                idle,
                app.as_deref().filter(|_| cfg.foreground_apps),
                interval,
            );
            if let Some(m) = tick.minute {
                // `user` is overwritten by the service from the session identity.
                send("activity", m.to_payload(""), &[]);
            }
            if tick.screenshot_due && redact::screenshot_allowed(&cfg, !unlocked, fg.as_deref()) {
                match capture_jpeg() {
                    Ok(jpeg) => {
                        let mut payload = serde_json::json!({ "app": app });
                        if cfg.location {
                            payload["location"] = location();
                        }
                        send("screenshot", payload, &jpeg);
                    }
                    Err(_) => {
                        send(
                            "activity",
                            serde_json::json!({ "capture_failed": true }),
                            &[],
                        );
                    }
                }
            }
            std::thread::sleep(Duration::from_secs(1).saturating_sub(now.elapsed()));
        }
    }
}
