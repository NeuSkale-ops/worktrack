//! worktrack-svc: Windows service host for the managed-device agent.
//!
//! Runs as LocalSystem from boot. Responsibilities:
//!   - Check in with the server (heartbeat, desired state, config).
//!   - Own the durable local buffer and upload it in idempotent batches.
//!   - Launch the visible per-user helper (`worktrack-session.exe`) into every
//!     active user session (a service in session 0 cannot see a user's desktop,
//!     so capture must run in the user's session) and accept its events over a
//!     local named pipe restricted to interactive users.
//!   - Record logon/logoff/lock/unlock session events.
//!   - Apply admin commands: pause, disable, uninstall.
//!
//! This file is Windows-only. On other hosts it builds to a stub so the core
//! library stays testable on any OS.

#![cfg_attr(not(windows), allow(dead_code))]

#[cfg(not(windows))]
fn main() {
    eprintln!("worktrack-svc is a Windows service and only runs on Windows.");
}

#[cfg(windows)]
fn main() {
    if std::env::args().any(|a| a == "--flush-and-exit") {
        // Used by uninstall.ps1: best-effort final upload, then exit.
        win::flush_and_exit();
        return;
    }
    if let Err(e) = win::run() {
        eprintln!("service dispatcher failed: {e}");
        std::process::exit(1);
    }
}

#[cfg(windows)]
mod win {
    use std::collections::HashMap;
    use std::ffi::OsString;
    use std::io::{Read, Write};
    use std::path::{Path, PathBuf};
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::{Duration, Instant};

    use windows::core::{w, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_PIPE_CONNECTED, HANDLE, HLOCAL, LocalFree, STILL_ACTIVE,
    };
    use windows::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows::Win32::Security::{
        DuplicateTokenEx, SecurityImpersonation, TokenPrimary, PSECURITY_DESCRIPTOR,
        SECURITY_ATTRIBUTES, TOKEN_ALL_ACCESS,
    };
    use windows::Win32::Storage::FileSystem::{
        FlushFileBuffers, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX,
    };
    use windows::Win32::System::Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock};
    use windows::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId,
        PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES,
        PIPE_WAIT,
    };
    use windows::Win32::System::RemoteDesktop::{
        ProcessIdToSessionId, WTSActive, WTSDomainName, WTSEnumerateSessionsW, WTSFreeMemory,
        WTSQuerySessionInformationW, WTSQueryUserToken, WTSUserName, WTS_INFO_CLASS,
        WTS_SESSION_INFOW,
    };
    use windows::Win32::System::Threading::{
        CreateProcessAsUserW, GetExitCodeProcess, OpenProcess, QueryFullProcessImageNameW,
        TerminateProcess, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT,
        DETACHED_PROCESS, PROCESS_INFORMATION, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION, STARTUPINFOW,
    };
    use windows_service::service::{
        ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus,
        ServiceType, SessionChangeReason,
    };
    use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
    use windows_service::service_dispatcher;

    use worktrack_managed::buffer::Buffer;
    use worktrack_managed::control::{accept_helper_event, CheckinReply, Desired};
    use worktrack_managed::ipc::{self, Reply, Request};
    use worktrack_managed::seal::Dpapi;
    use worktrack_managed::sync;
    use worktrack_managed::update;

    const SERVICE_NAME: &str = "WorkTrackAgent";
    const SERVICE_TYPE: ServiceType = ServiceType::OWN_PROCESS;
    const VERSION: &str = env!("CARGO_PKG_VERSION");
    const CHECKIN_EVERY: Duration = Duration::from_secs(60);
    const RECONCILE_EVERY: Duration = Duration::from_secs(5);
    const UPDATE_EVERY: Duration = Duration::from_secs(6 * 3600);
    /// Local buffer cap. Screenshots dominate; this holds days of offline use.
    const BUFFER_MAX_BYTES: i64 = 512 * 1024 * 1024;
    /// Pipe: SYSTEM and admins full, interactive users read/write only. Remote
    /// clients are rejected by the pipe mode as well.
    const PIPE_SDDL: PCWSTR = w!("D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;IU)");
    /// Helper process object: SYSTEM and admins full; the owning user (OW
    /// restricts implicit owner rights) and other interactive users may only
    /// query it. A standard user therefore cannot terminate the helper, and the
    /// service respawns it within seconds if it exits anyway.
    const HELPER_SDDL: PCWSTR = w!("D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x1000;;;OW)(A;;0x1000;;;IU)");

    fn data_dir() -> PathBuf {
        let base = std::env::var_os("ProgramData").unwrap_or_else(|| "C:\\ProgramData".into());
        PathBuf::from(base).join("WorkTrack")
    }

    fn install_dir() -> PathBuf {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(Path::to_path_buf))
            .unwrap_or_else(|| PathBuf::from("C:\\Program Files\\WorkTrack Agent"))
    }

    /// Append-only diagnostic log in the protected data dir, rotated at 1 MB.
    /// Contains operational errors only, never captured content.
    pub fn log(msg: &str) {
        let path = data_dir().join("agent.log");
        if std::fs::metadata(&path).map(|m| m.len() > 1024 * 1024).unwrap_or(false) {
            let _ = std::fs::rename(&path, data_dir().join("agent.log.1"));
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(f, "{} {msg}", chrono::Utc::now().to_rfc3339());
        }
    }

    // ---- persisted files --------------------------------------------------

    #[derive(serde::Deserialize)]
    struct ServerFile {
        server: String,
    }

    #[derive(serde::Deserialize)]
    struct Enrollment {
        #[allow(dead_code)]
        device_id: String,
        token: String,
    }

    fn read_json<T: for<'de> serde::Deserialize<'de>>(name: &str) -> Option<T> {
        let text = std::fs::read_to_string(data_dir().join(name)).ok()?;
        // PowerShell's Set-Content -Encoding UTF8 writes a BOM.
        serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
    }

    fn save_desired(d: &Desired) {
        let path = data_dir().join("state.json");
        let tmp = data_dir().join("state.json.tmp");
        if let Ok(s) = serde_json::to_vec(d) {
            if std::fs::write(&tmp, s).is_ok() {
                let _ = std::fs::rename(&tmp, &path);
            }
        }
    }

    fn open_buffer() -> Option<Buffer<Dpapi>> {
        let path = data_dir().join("buffer.sqlite");
        match Buffer::open(&path, Dpapi, BUFFER_MAX_BYTES) {
            Ok(b) => Some(b),
            Err(e) => {
                // Corrupt buffer: keep it aside for forensics and start fresh.
                // New events get new event_ids, so the server never confuses
                // them with what was already delivered.
                log(&format!("buffer open failed, recreating: {e}"));
                let aside = data_dir().join(format!("buffer.corrupt-{}.sqlite", chrono::Utc::now().timestamp()));
                let _ = std::fs::rename(&path, aside);
                Buffer::open(&path, Dpapi, BUFFER_MAX_BYTES)
                    .map_err(|e| log(&format!("buffer recreate failed: {e}")))
                    .ok()
            }
        }
    }

    // ---- shared state -----------------------------------------------------

    struct Shared {
        buffer: Option<Buffer<Dpapi>>,
        desired: Desired,
    }

    type State = Arc<Mutex<Shared>>;

    fn new_event_id() -> String {
        uuid::Uuid::new_v4().to_string()
    }

    fn now_rfc3339() -> String {
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    fn push(state: &State, kind: &str, payload: serde_json::Value) {
        let mut s = state.lock().unwrap();
        if let Some(b) = s.buffer.as_mut() {
            if let Err(e) = b.push(&new_event_id(), kind, &now_rfc3339(), &payload) {
                log(&format!("buffer push failed: {e}"));
            }
        }
    }

    // ---- server I/O -------------------------------------------------------

    struct Net {
        http: reqwest::blocking::Client,
        server: String,
        token: String,
    }

    enum NetErr {
        /// Transport failure or 5xx: retry with backoff.
        Retry(String),
        /// The server refused this device (revoked token, uninstalling).
        Refused(u16),
    }

    impl Net {
        fn load() -> Option<Net> {
            let server: ServerFile = read_json("config.json")?;
            let enrollment: Enrollment = read_json("enrollment.json")?;
            let http = reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(60))
                .user_agent(format!("worktrack-managed-agent/{VERSION}"))
                .build()
                .ok()?;
            Some(Net {
                http,
                server: server.server.trim_end_matches('/').to_string(),
                token: enrollment.token,
            })
        }

        fn post(&self, path: &str, body: &serde_json::Value) -> Result<serde_json::Value, NetErr> {
            let resp = self
                .http
                .post(format!("{}{path}", self.server))
                .bearer_auth(&self.token)
                .json(body)
                .send()
                .map_err(|e| NetErr::Retry(e.to_string()))?;
            let status = resp.status().as_u16();
            if status == 401 || status == 403 {
                return Err(NetErr::Refused(status));
            }
            if !resp.status().is_success() {
                return Err(NetErr::Retry(format!("{path}: HTTP {status}")));
            }
            resp.json().map_err(|e| NetErr::Retry(e.to_string()))
        }

        fn put_screenshot(&self, event_id: &str, jpeg: Vec<u8>) -> Result<String, NetErr> {
            let resp = self
                .http
                .put(format!("{}/api/device-screenshots/{event_id}", self.server))
                .bearer_auth(&self.token)
                .header("Content-Type", "image/jpeg")
                .body(jpeg)
                .send()
                .map_err(|e| NetErr::Retry(e.to_string()))?;
            let status = resp.status().as_u16();
            if status == 401 || status == 403 {
                return Err(NetErr::Refused(status));
            }
            if !resp.status().is_success() {
                return Err(NetErr::Retry(format!("screenshot upload: HTTP {status}")));
            }
            let v: serde_json::Value = resp.json().map_err(|e| NetErr::Retry(e.to_string()))?;
            v["screenshot_key"]
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| NetErr::Retry("no screenshot_key".into()))
        }
    }

    fn checkin(net: &Net, state: &State) -> Result<(), NetErr> {
        let body = {
            let s = state.lock().unwrap();
            let (depth, dropped) = s.buffer.as_ref().map(|b| (b.depth(), b.dropped())).unwrap_or((0, 0));
            serde_json::json!({
                "agent_version": VERSION,
                "buffer_depth": depth.min(i32::MAX as i64),
                "dropped_events": dropped.min(i64::MAX as u64),
                "config_version": s.desired.config.version,
            })
        };
        let reply: CheckinReply = serde_json::from_value(net.post("/api/devices/checkin", &body)?)
            .map_err(|e| NetErr::Retry(e.to_string()))?;
        let mut s = state.lock().unwrap();
        let before = s.desired.clone();
        if let Err(e) = s.desired.apply(reply) {
            log(&e);
        }
        if s.desired != before {
            save_desired(&s.desired);
        }
        Ok(())
    }

    /// Upload one batch. Returns how many events remain buffered.
    fn sync_once(net: &Net, state: &State) -> Result<i64, NetErr> {
        let batch = {
            let s = state.lock().unwrap();
            let Some(b) = s.buffer.as_ref() else { return Ok(0) };
            // Bounded read: buffered screenshots are large, so never unseal
            // hundreds at once. build_batch trims further by bytes.
            b.batch(64).map_err(NetErr::Retry)?
        };
        if batch.is_empty() {
            return Ok(0);
        }
        let mut wire = sync::build_batch(batch);
        // Screenshots travel separately to object storage. The buffered event
        // holds the JPEG; it is replaced by the stored object key before the
        // event itself is sent. Re-uploading after a crash is idempotent because
        // the key is derived from the event_id.
        for ev in wire.iter_mut().filter(|e| e.kind == "screenshot") {
            if let Some(b64) = ev.payload.get("jpeg_b64").and_then(|v| v.as_str()) {
                use base64::Engine;
                let jpeg = base64::engine::general_purpose::STANDARD
                    .decode(b64)
                    .map_err(|e| NetErr::Retry(e.to_string()))?;
                let key = net.put_screenshot(&ev.event_id, jpeg)?;
                let obj = ev.payload.as_object_mut().expect("object payload");
                obj.remove("jpeg_b64");
                obj.insert("screenshot_key".into(), key.into());
            }
        }
        let reply = net.post("/api/devices/events", &serde_json::json!({ "events": wire }))?;
        let acked = reply["acked_seq"].as_i64().ok_or_else(|| NetErr::Retry("no acked_seq".into()))?;
        let s = state.lock().unwrap();
        let b = s.buffer.as_ref().expect("buffer present");
        b.prune_through(acked).map_err(NetErr::Retry)?;
        Ok(b.depth())
    }

    fn rand01() -> f64 {
        let b = uuid::Uuid::new_v4().as_u128();
        (b >> 75) as f64 / (1u64 << 53) as f64
    }

    pub fn flush_and_exit() {
        let state: State = Arc::new(Mutex::new(Shared {
            buffer: open_buffer(),
            desired: read_json("state.json").unwrap_or_default(),
        }));
        if let Some(net) = Net::load() {
            for _ in 0..20 {
                match sync_once(&net, &state) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
        }
    }

    // ---- sessions and helpers ---------------------------------------------

    fn session_string(session: u32, class: WTS_INFO_CLASS) -> String {
        unsafe {
            let mut buf = PWSTR::null();
            let mut bytes = 0u32;
            if WTSQuerySessionInformationW(None, session, class, &mut buf, &mut bytes).is_err() || buf.is_null() {
                return String::new();
            }
            let s = buf.to_string().unwrap_or_default();
            WTSFreeMemory(buf.0 as _);
            s
        }
    }

    fn session_user(session: u32) -> String {
        let user = session_string(session, WTSUserName);
        if user.is_empty() {
            return String::new();
        }
        let domain = session_string(session, WTSDomainName);
        if domain.is_empty() { user } else { format!("{domain}\\{user}") }
    }

    /// Sessions with a logged-on interactive user (console or RDP).
    fn active_sessions() -> Vec<u32> {
        let mut out = Vec::new();
        unsafe {
            let mut info: *mut WTS_SESSION_INFOW = std::ptr::null_mut();
            let mut count = 0u32;
            if WTSEnumerateSessionsW(None, 0, 1, &mut info, &mut count).is_err() {
                return out;
            }
            for s in std::slice::from_raw_parts(info, count as usize) {
                if s.SessionId != 0 && s.State == WTSActive && !session_user(s.SessionId).is_empty() {
                    out.push(s.SessionId);
                }
            }
            WTSFreeMemory(info as _);
        }
        out
    }

    struct SecurityDescriptor(PSECURITY_DESCRIPTOR);
    impl SecurityDescriptor {
        fn from_sddl(sddl: PCWSTR) -> windows::core::Result<Self> {
            let mut sd = PSECURITY_DESCRIPTOR::default();
            unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &mut sd, None)? };
            Ok(Self(sd))
        }
        fn attributes(&self) -> SECURITY_ATTRIBUTES {
            SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: self.0 .0,
                bInheritHandle: false.into(),
            }
        }
    }
    impl Drop for SecurityDescriptor {
        fn drop(&mut self) {
            unsafe {
                let _ = LocalFree(Some(HLOCAL(self.0 .0)));
            }
        }
    }

    struct OwnedHandle(HANDLE);
    unsafe impl Send for OwnedHandle {}
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            if !self.0.is_invalid() {
                unsafe {
                    let _ = CloseHandle(self.0);
                }
            }
        }
    }

    fn launch_helper(session: u32) -> windows::core::Result<OwnedHandle> {
        let exe = install_dir().join("worktrack-session.exe");
        unsafe {
            let mut user = HANDLE::default();
            WTSQueryUserToken(session, &mut user)?;
            let user = OwnedHandle(user);
            let mut primary = HANDLE::default();
            DuplicateTokenEx(user.0, TOKEN_ALL_ACCESS, None, SecurityImpersonation, TokenPrimary, &mut primary)?;
            let primary = OwnedHandle(primary);
            let mut env: *mut core::ffi::c_void = std::ptr::null_mut();
            CreateEnvironmentBlock(&mut env, Some(primary.0), false)?;
            let mut desktop: Vec<u16> = "winsta0\\default\0".encode_utf16().collect();
            let si = STARTUPINFOW {
                cb: std::mem::size_of::<STARTUPINFOW>() as u32,
                lpDesktop: PWSTR(desktop.as_mut_ptr()),
                ..Default::default()
            };
            let mut cmd: Vec<u16> = format!("\"{}\"\0", exe.display()).encode_utf16().collect();
            let sd = SecurityDescriptor::from_sddl(HELPER_SDDL)?;
            let psa = sd.attributes();
            let mut pi = PROCESS_INFORMATION::default();
            let r = CreateProcessAsUserW(
                Some(primary.0),
                PCWSTR::null(),
                Some(PWSTR(cmd.as_mut_ptr())),
                Some(&psa),
                None,
                false,
                CREATE_UNICODE_ENVIRONMENT,
                Some(env),
                PCWSTR::null(),
                &si,
                &mut pi,
            );
            let _ = DestroyEnvironmentBlock(env);
            r?;
            let _ = CloseHandle(pi.hThread);
            Ok(OwnedHandle(pi.hProcess))
        }
    }

    fn running(h: &OwnedHandle) -> bool {
        let mut code = 0u32;
        unsafe { GetExitCodeProcess(h.0, &mut code).is_ok() && code == STILL_ACTIVE.0 as u32 }
    }

    struct Helpers(HashMap<u32, OwnedHandle>);

    impl Helpers {
        fn reconcile(&mut self) {
            let active = active_sessions();
            self.0.retain(|sid, h| active.contains(sid) && running(h));
            for sid in active {
                if self.0.contains_key(&sid) {
                    continue;
                }
                match launch_helper(sid) {
                    Ok(h) => {
                        self.0.insert(sid, h);
                    }
                    Err(e) => log(&format!("launch helper in session {sid} failed: {e}")),
                }
            }
        }

        fn stop_all(&mut self) {
            for (_, h) in self.0.drain() {
                unsafe {
                    let _ = TerminateProcess(h.0, 0);
                }
            }
        }
    }

    // ---- pipe server ------------------------------------------------------

    struct Pipe(HANDLE);
    // The handle is owned by exactly one thread at a time.
    unsafe impl Send for Pipe {}
    impl Read for Pipe {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let mut n = 0u32;
            unsafe { ReadFile(self.0, Some(buf), Some(&mut n), None) }.map_err(std::io::Error::other)?;
            Ok(n as usize)
        }
    }
    impl Write for Pipe {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let mut n = 0u32;
            unsafe { WriteFile(self.0, Some(buf), Some(&mut n), None) }.map_err(std::io::Error::other)?;
            Ok(n as usize)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl Drop for Pipe {
        fn drop(&mut self) {
            unsafe {
                // Wait until the helper has read the reply. DisconnectNamedPipe
                // discards unread data, so without this the reply can be lost
                // and the helper shows "monitoring is paused".
                let _ = FlushFileBuffers(self.0);
                let _ = DisconnectNamedPipe(self.0);
                let _ = CloseHandle(self.0);
            }
        }
    }

    /// Identify the pipe client: it must be our installed helper binary, and the
    /// user is taken from its Windows session, never from the request.
    fn client_identity(pipe: HANDLE) -> Result<String, String> {
        unsafe {
            let mut pid = 0u32;
            GetNamedPipeClientProcessId(pipe, &mut pid).map_err(|e| e.to_string())?;
            let mut session = 0u32;
            ProcessIdToSessionId(pid, &mut session).map_err(|e| e.to_string())?;
            let process = OwnedHandle(
                OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).map_err(|e| e.to_string())?,
            );
            let mut path = vec![0u16; 32768];
            let mut size = path.len() as u32;
            QueryFullProcessImageNameW(process.0, PROCESS_NAME_WIN32, PWSTR(path.as_mut_ptr()), &mut size)
                .map_err(|e| e.to_string())?;
            let exe = String::from_utf16_lossy(&path[..size as usize]);
            let expected = install_dir().join("worktrack-session.exe");
            if !exe.eq_ignore_ascii_case(&expected.to_string_lossy()) {
                return Err(format!("unexpected pipe client {exe}"));
            }
            let user = session_user(session);
            if user.is_empty() {
                return Err("pipe client has no session user".into());
            }
            Ok(user)
        }
    }

    fn serve_client(state: &State, mut pipe: Pipe) -> std::io::Result<()> {
        let user = client_identity(pipe.0);
        let (req, attachment): (Request, Vec<u8>) = ipc::read_msg(&mut pipe)?;
        let mut s = state.lock().unwrap();
        let mut reply = Reply {
            ok: true,
            capture: s.desired.capture(),
            config: s.desired.config.clone(),
            error: None,
        };
        let user = match user {
            Ok(u) => u,
            Err(e) => {
                log(&e);
                reply.ok = false;
                reply.capture = false;
                reply.error = Some("unauthorized client".into());
                drop(s);
                return ipc::write_msg(&mut pipe, &reply, &[]);
            }
        };
        if let Request::Event { event_id, kind, occurred_at, payload } = req {
            let accepted = accept_helper_event(
                &s.desired,
                worktrack_managed::control::HelperEvent {
                    kind: &kind,
                    event_id: &event_id,
                    occurred_at: &occurred_at,
                    payload,
                    attachment: &attachment,
                },
                &user,
                chrono::Utc::now(),
            );
            match accepted.and_then(|p| match s.buffer.as_mut() {
                Some(b) => b.push(&event_id, &kind, &occurred_at, &p).map(|_| ()),
                None => Err("buffer unavailable".into()),
            }) {
                Ok(()) => {}
                Err(e) => {
                    reply.ok = false;
                    reply.error = Some(e);
                }
            }
        }
        drop(s);
        ipc::write_msg(&mut pipe, &reply, &[])
    }

    fn pipe_server(state: State) {
        let mut first = true;
        loop {
            let sd = match SecurityDescriptor::from_sddl(PIPE_SDDL) {
                Ok(sd) => sd,
                Err(e) => {
                    log(&format!("pipe SDDL failed: {e}"));
                    return;
                }
            };
            let sa = sd.attributes();
            // FIRST_PIPE_INSTANCE: if another process squatted the name before
            // the service started, fail loudly instead of sharing it.
            let mode = if first { PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE } else { PIPE_ACCESS_DUPLEX };
            let name: Vec<u16> = format!("{}\0", ipc::PIPE_NAME).encode_utf16().collect();
            let handle = unsafe {
                CreateNamedPipeW(
                    PCWSTR(name.as_ptr()),
                    mode,
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                    PIPE_UNLIMITED_INSTANCES,
                    64 * 1024,
                    64 * 1024,
                    0,
                    Some(&sa),
                )
            };
            if handle.is_invalid() {
                log(&format!("CreateNamedPipe failed: {:?}", unsafe { GetLastError() }));
                std::thread::sleep(Duration::from_secs(5));
                continue;
            }
            first = false;
            let connected = unsafe { ConnectNamedPipe(handle, None) };
            if let Err(e) = connected {
                if e.code() != ERROR_PIPE_CONNECTED.to_hresult() {
                    drop(Pipe(handle));
                    continue;
                }
            }
            let state = state.clone();
            let pipe = Pipe(handle);
            std::thread::spawn(move || {
                if let Err(e) = serve_client(&state, pipe) {
                    log(&format!("pipe client error: {e}"));
                }
            });
        }
    }

    // ---- uninstall --------------------------------------------------------

    fn start_uninstall() {
        let script = install_dir().join("uninstall.ps1");
        spawn_detached(&format!("-File \"{}\"", script.display()), "uninstall.ps1");
    }

    /// Run a PowerShell command detached so it survives this service stopping,
    /// which uninstall.ps1 and install.ps1 both do.
    fn spawn_detached(args: &str, what: &str) {
        let mut cmd: Vec<u16> = format!("powershell.exe -NoProfile -ExecutionPolicy Bypass {args}\0")
            .encode_utf16()
            .collect();
        let si = STARTUPINFOW { cb: std::mem::size_of::<STARTUPINFOW>() as u32, ..Default::default() };
        let mut pi = PROCESS_INFORMATION::default();
        let r = unsafe {
            windows::Win32::System::Threading::CreateProcessW(
                PCWSTR::null(),
                Some(PWSTR(cmd.as_mut_ptr())),
                None,
                None,
                false,
                DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW,
                None,
                PCWSTR::null(),
                &si,
                &mut pi,
            )
        };
        match r {
            Ok(()) => unsafe {
                let _ = CloseHandle(pi.hThread);
                let _ = CloseHandle(pi.hProcess);
                log(&format!("{what} started"));
            },
            Err(e) => log(&format!("could not start {what}: {e}")),
        }
    }

    // ---- self-update ------------------------------------------------------

    /// Poll the dashboard's pinned release feed. When it names a newer version,
    /// download the zip into the SYSTEM-only data dir, check the pinned SHA-256,
    /// unpack it and run its install.ps1 in upgrade mode (keeps enrollment).
    fn check_update(net: &Net) -> Result<(), String> {
        let get = |path: &str| -> Result<Vec<u8>, String> {
            let resp = net.http.get(format!("{}{path}", net.server)).send().map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                return Err(format!("{path}: HTTP {}", resp.status().as_u16()));
            }
            resp.bytes().map(|b| b.to_vec()).map_err(|e| e.to_string())
        };
        let Some(rel) = update::pick(VERSION, &get("/managed-agent/latest.json")?) else {
            return Ok(());
        };
        let zip = get(&rel.zip_path())?;
        if !update::verify(&rel, &zip) {
            return Err(format!("update {} failed SHA-256 check", rel.version));
        }
        let dir = data_dir().join("update");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let zip_path = dir.join("agent.zip");
        std::fs::write(&zip_path, &zip).map_err(|e| e.to_string())?;
        // Unpack here, not with PowerShell Expand-Archive: that step failed
        // silently in the detached process and the install never ran.
        let out = dir.join("payload");
        update::unpack(&zip, &out)?;
        // -File, not -Command: no quoting of paths into a script string.
        // install.ps1 writes its own transcript to -LogPath.
        spawn_detached(
            &format!("-File \"{}\" -Server \"{}\" -LogPath \"{}\"", out.join("install.ps1").display(), net.server, dir.join("install.log").display()),
            &format!("upgrade to {}", rel.version),
        );
        Ok(())
    }

    // ---- service lifecycle ------------------------------------------------

    enum Msg {
        Stop,
        Session(SessionChangeReason, u32),
    }

    pub fn run() -> Result<(), Box<dyn std::error::Error>> {
        service_dispatcher::start(SERVICE_NAME, ffi_service_main)?;
        Ok(())
    }

    windows_service::define_windows_service!(ffi_service_main, service_main);

    fn service_main(_args: Vec<OsString>) {
        if let Err(e) = service_body() {
            log(&format!("service error: {e}"));
        }
    }

    fn service_body() -> Result<(), Box<dyn std::error::Error>> {
        let (tx, rx) = mpsc::channel();
        let handler = move |control: ServiceControl| -> ServiceControlHandlerResult {
            match control {
                ServiceControl::Stop | ServiceControl::Shutdown => {
                    let _ = tx.send(Msg::Stop);
                    ServiceControlHandlerResult::NoError
                }
                ServiceControl::SessionChange(p) => {
                    let _ = tx.send(Msg::Session(p.reason, p.notification.session_id));
                    ServiceControlHandlerResult::NoError
                }
                ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
                _ => ServiceControlHandlerResult::NotImplemented,
            }
        };
        let status_handle = service_control_handler::register(SERVICE_NAME, handler)?;
        let set = |state: ServiceState, accept: ServiceControlAccept| {
            status_handle.set_service_status(ServiceStatus {
                service_type: SERVICE_TYPE,
                current_state: state,
                controls_accepted: accept,
                exit_code: ServiceExitCode::Win32(0),
                checkpoint: 0,
                wait_hint: Duration::default(),
                process_id: None,
            })
        };
        set(
            ServiceState::Running,
            ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN | ServiceControlAccept::SESSION_CHANGE,
        )?;
        log(&format!("service {VERSION} started"));

        let state: State = Arc::new(Mutex::new(Shared {
            buffer: open_buffer(),
            desired: read_json("state.json").unwrap_or_default(),
        }));
        {
            let state = state.clone();
            std::thread::spawn(move || pipe_server(state));
        }

        let mut helpers = Helpers(HashMap::new());
        let mut net: Option<Net> = None;
        let mut next_checkin = Instant::now();
        let mut next_sync = Instant::now();
        let mut next_reconcile = Instant::now();
        let mut sync_failures = 0u32;
        let mut uninstalling = false;
        // First update check a few minutes after boot, not during logon rush.
        let mut next_update = Instant::now() + Duration::from_secs(300);

        loop {
            match rx.recv_timeout(Duration::from_secs(1)) {
                Ok(Msg::Stop) => break,
                Ok(Msg::Session(reason, sid)) => {
                    let event = match reason {
                        SessionChangeReason::SessionLogon => Some("logon"),
                        SessionChangeReason::SessionLogoff => Some("logoff"),
                        SessionChangeReason::SessionLock => Some("lock"),
                        SessionChangeReason::SessionUnlock => Some("unlock"),
                        _ => None,
                    };
                    let record = {
                        let s = state.lock().unwrap();
                        s.desired.capture() && s.desired.config.session_events
                    };
                    if let (Some(event), true) = (event, record) {
                        push(&state, "session", serde_json::json!({ "event": event, "user": session_user(sid) }));
                    }
                    next_reconcile = Instant::now();
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            let now = Instant::now();

            if net.is_none() {
                // install.ps1 writes enrollment.json after starting the service.
                net = Net::load();
            }
            if let Some(n) = net.as_ref() {
                if now >= next_checkin {
                    next_checkin = now + CHECKIN_EVERY;
                    match checkin(n, &state) {
                        Ok(()) => {}
                        Err(NetErr::Refused(code)) => log(&format!("check-in refused: HTTP {code}")),
                        Err(NetErr::Retry(e)) => log(&format!("check-in failed: {e}")),
                    }
                }
                let (uninstall, depth) = {
                    let s = state.lock().unwrap();
                    (s.desired.uninstall, s.buffer.as_ref().map(|b| b.depth()).unwrap_or(0))
                };
                if uninstall && !uninstalling {
                    uninstalling = true;
                    helpers.stop_all();
                    start_uninstall();
                }
                if !uninstall && now >= next_update {
                    next_update = now + UPDATE_EVERY;
                    // A failed install leaves this service running, so the
                    // next interval retries it.
                    if let Err(e) = check_update(n) {
                        log(&format!("update check failed: {e}"));
                    }
                }
                if !uninstall && depth > 0 && now >= next_sync {
                    match sync_once(n, &state) {
                        Ok(remaining) => {
                            sync_failures = 0;
                            next_sync = if remaining > 0 { now } else { now + Duration::from_secs(30) };
                        }
                        Err(e) => {
                            match e {
                                NetErr::Retry(m) => log(&format!("sync failed: {m}")),
                                NetErr::Refused(code) => log(&format!("sync refused: HTTP {code}")),
                            }
                            next_sync = now + sync::backoff(sync_failures, rand01()).max(Duration::from_secs(5));
                            sync_failures = sync_failures.saturating_add(1);
                        }
                    }
                }
            }
            if !uninstalling && now >= next_reconcile {
                next_reconcile = now + RECONCILE_EVERY;
                helpers.reconcile();
            }
        }

        helpers.stop_all();
        log("service stopping");
        set(ServiceState::Stopped, ServiceControlAccept::empty())?;
        Ok(())
    }
}
