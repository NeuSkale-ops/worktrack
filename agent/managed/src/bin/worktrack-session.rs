//! worktrack-session: per-user helper launched by the service into each
//! interactive session. It is the only part that touches the user's desktop:
//!   - Shows the one-time monitoring acknowledgment on first logon.
//!   - Keeps a visible tray indicator while capture is active (disclosure).
//!   - Runs the capture collectors (foreground app, idle time, screenshots,
//!     location) and applies exclusion/redaction before handing data to the
//!     service over a local pipe.
//!
//! Windows-only; stub elsewhere so the workspace builds cross-platform.

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
    use worktrack_managed::config::Config;
    use worktrack_managed::redact;

    pub fn run() {
        // Load the config the service wrote for this machine. On parse failure,
        // fall back to the least-data default rather than capturing with unknown
        // settings.
        let cfg = load_config().unwrap_or_default();

        if !acknowledged() {
            show_acknowledgment();
            // Capture is gated on acknowledgment for this user (first logon only).
            mark_acknowledged();
        }

        // A persistent tray icon is mandatory whenever capture is active: this is
        // disclosure, not stealth. The user cannot dismiss it; it reflects state.
        show_tray_indicator(&cfg);

        // Collector loop: sample foreground app + idle, and at each screenshot
        // boundary capture the primary monitor + one location fix, honoring the
        // exclusion list and failing closed on secure desktops.
        run_collectors(&cfg);
    }

    fn load_config() -> Option<Config> {
        // shortcut: read the service-published config file from ProgramData; wire
        // the exact path once the service writes it. Returns None to use default.
        None
    }

    fn acknowledged() -> bool {
        // shortcut: per-user HKCU flag set after the notice is shown.
        false
    }
    fn mark_acknowledged() {}

    fn show_acknowledgment() {
        // shortcut: modal notice window with the monitoring disclosure text and an
        // "I understand" button, shown once per Windows user.
    }

    fn show_tray_indicator(_cfg: &Config) {
        // shortcut: NOTIFYICONDATA tray icon reflecting active/paused capture.
    }

    fn run_collectors(cfg: &Config) {
        // Illustrates the redaction boundary that the real collectors enforce:
        // the foreground executable name is run through the exclusion list before
        // it is ever buffered or sent.
        let foreground = current_foreground_exe();
        let _recorded = redact::apply_exclusion(cfg, foreground.as_deref().unwrap_or(""));
        // shortcut: idle sampling, fixed-boundary screenshot + location capture,
        // and local-pipe handoff to the service. Capture skipped when the config
        // disables a signal or the device is paused/disabled.
    }

    fn current_foreground_exe() -> Option<String> {
        // shortcut: GetForegroundWindow -> GetWindowThreadProcessId -> exe name.
        None
    }
}
