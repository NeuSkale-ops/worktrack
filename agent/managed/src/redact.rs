//! Exclusion and redaction, enforced at capture time (in the user session, before
//! any data crosses to the service). An excluded app is never recorded by name.

use crate::config::Config;

/// Case-insensitive match of an executable name against the exclusion list.
/// Returns the name to record: the original, or "Excluded" when suppressed.
pub fn apply_exclusion(cfg: &Config, exe: &str) -> String {
    let exe_l = exe.trim().to_ascii_lowercase();
    if exe_l.is_empty() {
        return "Unknown".into();
    }
    if cfg
        .excluded_apps
        .iter()
        .any(|e| e.trim().to_ascii_lowercase() == exe_l)
    {
        return "Excluded".into();
    }
    // Bound length as the Tauri app does (64 chars) to avoid pathological names.
    let mut name = exe.trim().to_string();
    if name.chars().count() > 64 {
        name = name.chars().take(64).collect();
    }
    name
}

/// True when a screenshot must be discarded: a secure desktop, lock screen, or
/// any state where the foreground app is excluded. Fails closed on uncertainty.
pub fn screenshot_allowed(cfg: &Config, desktop_secure: bool, foreground_exe: Option<&str>) -> bool {
    if desktop_secure {
        return false;
    }
    match foreground_exe {
        None => false,
        Some(exe) => apply_exclusion(cfg, exe) != "Excluded",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg_with(excluded: &[&str]) -> Config {
        Config {
            excluded_apps: excluded.iter().map(|s| s.to_string()).collect(),
            screenshots: true,
            screenshot_interval_secs: 600,
            ..Config::default()
        }
    }

    #[test]
    fn excluded_app_is_never_named() {
        let cfg = cfg_with(&["KeePass.exe", "1password.exe"]);
        assert_eq!(apply_exclusion(&cfg, "keepass.exe"), "Excluded");
        assert_eq!(apply_exclusion(&cfg, "chrome.exe"), "chrome.exe");
        assert_eq!(apply_exclusion(&cfg, ""), "Unknown");
    }

    #[test]
    fn name_length_is_bounded() {
        let cfg = cfg_with(&[]);
        let long = "a".repeat(200);
        assert_eq!(apply_exclusion(&cfg, &long).chars().count(), 64);
    }

    #[test]
    fn screenshot_fails_closed() {
        let cfg = cfg_with(&["keepass.exe"]);
        assert!(!screenshot_allowed(&cfg, true, Some("chrome.exe"))); // secure desktop
        assert!(!screenshot_allowed(&cfg, false, None)); // unknown foreground
        assert!(!screenshot_allowed(&cfg, false, Some("keepass.exe"))); // excluded
        assert!(screenshot_allowed(&cfg, false, Some("chrome.exe")));
    }
}
