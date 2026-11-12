//! worktrack-svc: the Windows service host. Runs as LocalSystem, auto-start at
//! boot. Responsibilities:
//!   - Own the durable buffer and the sync loop (check-in + event upload).
//!   - Apply desired state from the server (enable/pause/uninstall, config).
//!   - Launch one session helper per interactive user session (Session 0 cannot
//!     see a user's desktop, so capture must run in the user's session).
//!   - Restart a crashed helper; Service Recovery restarts the service itself.
//!
//! This file is Windows-only. On other hosts it builds to a stub so the core
//! library still compiles and tests cross-platform.

#[cfg(not(windows))]
fn main() {
    eprintln!("worktrack-svc is a Windows service; build on Windows to run it.");
}

#[cfg(windows)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    win::run()
}

#[cfg(windows)]
mod win {
    use std::ffi::OsString;
    use std::sync::mpsc;
    use std::time::Duration;
    use windows_service::service::{
        ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus,
        ServiceType,
    };
    use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
    use windows_service::service_dispatcher;

    const SERVICE_NAME: &str = "WorkTrackAgent";
    const SERVICE_TYPE: ServiceType = ServiceType::OWN_PROCESS;

    pub fn run() -> Result<(), Box<dyn std::error::Error>> {
        // Hands control to the SCM, which calls service_main on a service thread.
        service_dispatcher::start(SERVICE_NAME, ffi_service_main)?;
        Ok(())
    }

    windows_service::define_windows_service!(ffi_service_main, service_main);

    fn service_main(_args: Vec<OsString>) {
        if let Err(e) = service_body() {
            // The service must never panic out; log to the Event Log in a real
            // build. shortcut: structured Event Log sink, add before fleet rollout.
            eprintln!("service error: {e}");
        }
    }

    fn service_body() -> Result<(), Box<dyn std::error::Error>> {
        let (shutdown_tx, shutdown_rx) = mpsc::channel();

        // SESSIONCHANGE lets the service launch/stop helpers as users log on/off.
        let handler = move |control: ServiceControl| -> ServiceControlHandlerResult {
            match control {
                ServiceControl::Stop | ServiceControl::Shutdown => {
                    let _ = shutdown_tx.send(());
                    ServiceControlHandlerResult::NoError
                }
                ServiceControl::SessionChange(_) => {
                    // A real build reconciles helpers here; the sync loop below also
                    // reconciles on its tick so a missed event is self-healing.
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

        // Main loop: check in, sync buffered events, reconcile helpers. Sleeps
        // between ticks and wakes early on shutdown. The heavy lifting (agent
        // struct, buffer, HTTP) is wired in the capture/sync task of this phase.
        loop {
            // shortcut: full agent tick (check-in, upload, reconcile helpers) wired
            // once the session-helper IPC lands. Keeps the service lifecycle
            // reviewable on its own.
            if shutdown_rx.recv_timeout(Duration::from_secs(300)).is_ok() {
                break;
            }
        }

        set(ServiceState::Stopped, ServiceControlAccept::empty())?;
        Ok(())
    }
}
