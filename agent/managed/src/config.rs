//! Capture configuration schema. Server-authoritative, versioned, validated on
//! load. Default is the least data that meets the goal: session events and idle
//! time only. Screenshots and location are opt-in per device from the dashboard.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    /// Bumped by the server on every change; the agent caches the last applied.
    pub version: u32,
    /// Foreground executable name + duration (never titles, paths, URLs).
    pub foreground_apps: bool,
    /// Idle vs active time from GetLastInputInfo (a timestamp, not keystrokes).
    pub idle_time: bool,
    /// Logon/logoff/lock/unlock session events.
    pub session_events: bool,
    /// Primary-monitor screenshots at fixed elapsed boundaries.
    pub screenshots: bool,
    /// One geolocation fix per screenshot boundary (never continuous).
    pub location: bool,
    /// Seconds between screenshot captures. Fixed cadence, no randomization.
    pub screenshot_interval_secs: u32,
    /// Executable names never recorded by name; reported as "Excluded".
    pub excluded_apps: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            version: 1,
            foreground_apps: true,
            idle_time: true,
            session_events: true,
            screenshots: false,
            location: false,
            screenshot_interval_secs: 600,
            excluded_apps: Vec::new(),
        }
    }
}

impl Config {
    /// Parse and validate server-supplied config. Rejects nonsense rather than
    /// capturing with unsafe settings; the caller keeps the previous config.
    pub fn parse(json: &str) -> Result<Self, String> {
        let c: Config = serde_json::from_str(json).map_err(|e| e.to_string())?;
        c.validate()?;
        Ok(c)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.version < 1 {
            return Err("config version must be >= 1".into());
        }
        // Bound cadence so a bad value cannot hammer the disk or sit idle forever.
        if self.screenshots && !(60..=3600).contains(&self.screenshot_interval_secs) {
            return Err("screenshot_interval_secs must be 60..=3600".into());
        }
        // Location without screenshots has nothing to attach to.
        if self.location && !self.screenshots {
            return Err("location requires screenshots".into());
        }
        if self.excluded_apps.len() > 256 {
            return Err("excluded_apps capped at 256 entries".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_least_data() {
        let c = Config::default();
        assert!(c.session_events && c.idle_time && c.foreground_apps);
        assert!(!c.screenshots && !c.location);
        c.validate().unwrap();
    }

    #[test]
    fn rejects_unknown_fields_and_bad_cadence() {
        assert!(Config::parse(r#"{"version":1,"spy":true}"#).is_err());
        assert!(Config::parse(r#"{"version":1,"screenshots":true,"screenshot_interval_secs":5}"#).is_err());
        assert!(Config::parse(r#"{"version":1,"location":true,"screenshots":false}"#).is_err());
    }

    #[test]
    fn accepts_valid_screenshot_config() {
        let c = Config::parse(
            r#"{"version":3,"screenshots":true,"location":true,"screenshot_interval_secs":600,"excluded_apps":["keepass.exe"]}"#,
        )
        .unwrap();
        assert_eq!(c.version, 3);
        assert!(c.location);
    }
}
