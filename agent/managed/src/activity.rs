//! Activity aggregation for the session helper. The helper samples once per
//! second (lock state, idle seconds, foreground executable) and this module
//! folds samples into one `activity` event per minute plus a fixed-cadence
//! screenshot schedule. Pure logic so it is unit-tested on any OS.

use std::collections::BTreeMap;

/// Input counts as "active" when the last input was under this many seconds ago.
/// Matches the personal desktop app, which treats any input in the last second
/// of a 1s sample as activity.
pub const ACTIVE_IDLE_SECS: f64 = 1.0;
/// Samples further apart than this (sleep, hibernate, debugger) are dropped so a
/// resume never back-fills time that was not observed.
pub const MAX_SAMPLE_GAP_SECS: f64 = 2.0;

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Minute {
    pub active_secs: f64,
    pub idle_secs: f64,
    pub locked_secs: f64,
    pub apps: BTreeMap<String, f64>,
}

impl Minute {
    pub fn is_empty(&self) -> bool {
        self.active_secs + self.idle_secs + self.locked_secs == 0.0
    }

    pub fn to_payload(&self, user: &str) -> serde_json::Value {
        let round = |v: f64| (v * 10.0).round() / 10.0;
        let apps: serde_json::Map<String, serde_json::Value> = self
            .apps
            .iter()
            .map(|(k, v)| (k.clone(), round(*v).into()))
            .collect();
        serde_json::json!({
            "user": user,
            "active_secs": round(self.active_secs),
            "idle_secs": round(self.idle_secs),
            "locked_secs": round(self.locked_secs),
            "apps": apps,
        })
    }
}

/// Folds 1s samples into minutes. `capture` false (paused/disabled/not yet
/// acknowledged) records nothing at all, not even lock time.
#[derive(Debug, Default)]
pub struct Aggregator {
    current: Minute,
    window_secs: f64,
    /// Unlocked seconds since the last screenshot boundary.
    shot_elapsed: f64,
}

pub struct Tick {
    /// A completed minute ready to send as an `activity` event.
    pub minute: Option<Minute>,
    /// A screenshot boundary was crossed during this sample.
    pub screenshot_due: bool,
}

impl Aggregator {
    /// `app` must already have passed `redact::apply_exclusion`.
    pub fn sample(
        &mut self,
        dt: f64,
        unlocked: bool,
        idle_secs: Option<f64>,
        app: Option<&str>,
        screenshot_interval_secs: Option<u32>,
    ) -> Tick {
        let mut tick = Tick { minute: None, screenshot_due: false };
        if !(0.0..=MAX_SAMPLE_GAP_SECS).contains(&dt) {
            return tick;
        }
        if !unlocked {
            self.current.locked_secs += dt;
        } else {
            match idle_secs {
                Some(i) if i < ACTIVE_IDLE_SECS => self.current.active_secs += dt,
                _ => self.current.idle_secs += dt,
            }
            if let Some(a) = app {
                *self.current.apps.entry(a.to_string()).or_default() += dt;
            }
            if let Some(interval) = screenshot_interval_secs {
                // Fixed elapsed boundaries of unlocked time. Never randomized and
                // never caught up after lock or sleep.
                self.shot_elapsed += dt;
                if self.shot_elapsed >= interval as f64 {
                    self.shot_elapsed = 0.0;
                    tick.screenshot_due = true;
                }
            }
        }
        self.window_secs += dt;
        if self.window_secs >= 60.0 {
            tick.minute = self.flush();
        }
        tick
    }

    /// Emit the partial minute (pause, shutdown). None when nothing was observed.
    pub fn flush(&mut self) -> Option<Minute> {
        self.window_secs = 0.0;
        let m = std::mem::take(&mut self.current);
        (!m.is_empty()).then_some(m)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_minute_of_samples_emits_one_event() {
        let mut a = Aggregator::default();
        let mut minutes = Vec::new();
        for s in 0..120 {
            let idle = if s % 2 == 0 { 0.2 } else { 30.0 };
            if let Some(m) = a.sample(1.0, true, Some(idle), Some("code.exe"), None).minute {
                minutes.push(m);
            }
        }
        assert_eq!(minutes.len(), 2);
        assert_eq!(minutes[0].active_secs, 30.0);
        assert_eq!(minutes[0].idle_secs, 30.0);
        assert_eq!(minutes[0].apps["code.exe"], 60.0);
    }

    #[test]
    fn locked_time_has_no_apps_and_no_screenshot_progress() {
        let mut a = Aggregator::default();
        for _ in 0..700 {
            assert!(!a.sample(1.0, false, None, None, Some(600)).screenshot_due);
        }
        let m = a.flush().unwrap_or_default();
        assert!(m.apps.is_empty() && m.active_secs == 0.0);
    }

    #[test]
    fn screenshots_on_fixed_unlocked_boundaries_without_catch_up() {
        let mut a = Aggregator::default();
        let mut due = 0;
        for _ in 0..1800 {
            due += a.sample(1.0, true, Some(0.0), Some("x.exe"), Some(600)).screenshot_due as i32;
        }
        assert_eq!(due, 3);
        // A long sleep gap is dropped, not counted toward the next boundary.
        assert!(!a.sample(3600.0, true, Some(0.0), None, Some(600)).screenshot_due);
    }

    #[test]
    fn payload_rounds_and_names_user() {
        let mut a = Aggregator::default();
        a.sample(1.04, true, Some(0.0), Some("Excluded"), None);
        let p = a.flush().unwrap().to_payload("alice");
        assert_eq!(p["user"], "alice");
        assert_eq!(p["active_secs"], 1.0);
        assert_eq!(p["apps"]["Excluded"], 1.0);
    }
}
