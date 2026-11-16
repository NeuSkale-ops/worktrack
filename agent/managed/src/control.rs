//! Service control state and helper-event validation. Pure logic used by the
//! Windows service: what the server asked for (enabled/paused/uninstall/config),
//! whether capture may run, and which helper submissions are accepted.

use crate::config::Config;
use serde::{Deserialize, Serialize};

/// Desired state from the last successful check-in, persisted so an offline
/// boot keeps honoring the admin's last decision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Desired {
    pub enabled: bool,
    pub paused: bool,
    pub uninstall: bool,
    pub config: Config,
}

impl Default for Desired {
    fn default() -> Self {
        Self { enabled: true, paused: false, uninstall: false, config: Config::default() }
    }
}

#[derive(Debug, Deserialize)]
pub struct CheckinReply {
    pub enabled: bool,
    pub paused: bool,
    pub uninstall: bool,
    pub config_version: u32,
    #[serde(default)]
    pub config: Option<serde_json::Value>,
}

impl Desired {
    pub fn capture(&self) -> bool {
        self.enabled && !self.paused && !self.uninstall
    }

    /// Apply a check-in reply. A config the agent cannot validate is rejected and
    /// the previous config stays, so a bad dashboard value never widens capture.
    /// Returns an error string for logging when the new config was rejected.
    pub fn apply(&mut self, r: CheckinReply) -> Result<(), String> {
        self.enabled = r.enabled;
        self.paused = r.paused;
        self.uninstall = r.uninstall;
        let Some(mut raw) = r.config else { return Ok(()) };
        if let Some(obj) = raw.as_object_mut() {
            obj.insert("version".into(), r.config_version.into());
        }
        let parsed = serde_json::to_string(&raw)
            .map_err(|e| e.to_string())
            .and_then(|s| Config::parse(&s));
        match parsed {
            Ok(c) => {
                self.config = c;
                Ok(())
            }
            Err(e) => Err(format!("config v{} rejected: {e}", r.config_version)),
        }
    }
}

/// One helper submission as received over the pipe.
pub struct HelperEvent<'a> {
    pub kind: &'a str,
    pub event_id: &'a str,
    pub occurred_at: &'a str,
    pub payload: serde_json::Value,
    pub attachment: &'a [u8],
}

/// Validate one helper submission and build the payload the service stores.
/// The service, not the helper, supplies `user` (from the pipe client's
/// session), so a helper cannot attribute data to someone else.
pub fn accept_helper_event(
    d: &Desired,
    ev: HelperEvent,
    user: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<serde_json::Value, String> {
    let HelperEvent { kind, event_id, occurred_at, mut payload, attachment } = ev;
    if !crate::ipc::HELPER_KINDS.contains(&kind) {
        return Err("kind not allowed".into());
    }
    if uuid::Uuid::parse_str(event_id).is_err() {
        return Err("event_id must be a UUID".into());
    }
    let at = chrono::DateTime::parse_from_rfc3339(occurred_at).map_err(|_| "bad occurred_at")?;
    if at.with_timezone(&chrono::Utc) > now + chrono::Duration::minutes(2) {
        return Err("occurred_at in the future".into());
    }
    // Acknowledgment is recorded even before capture starts: it is the record
    // that the notice was shown. Everything else needs capture to be allowed.
    if kind != "acknowledged" && !d.capture() {
        return Err("capture is paused or disabled".into());
    }
    let obj = payload.as_object_mut().ok_or("payload must be an object")?;
    obj.insert("user".into(), user.into());
    if kind == "screenshot" {
        if !d.config.screenshots {
            return Err("screenshots disabled".into());
        }
        if attachment.len() < 3 || attachment[..3] != [0xFF, 0xD8, 0xFF] {
            return Err("screenshot must be a JPEG".into());
        }
        if !d.config.location {
            obj.remove("location");
        }
        use base64::Engine;
        obj.insert("jpeg_b64".into(), base64::engine::general_purpose::STANDARD.encode(attachment).into());
    } else if !attachment.is_empty() {
        return Err("unexpected attachment".into());
    }
    if kind == "activity" && !d.config.foreground_apps {
        obj.remove("apps");
    }
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> chrono::DateTime<chrono::Utc> {
        "2026-01-01T00:10:00Z".parse().unwrap()
    }
    const ID: &str = "6b2f0d0e-6f6c-4b8e-9a2a-3f1f7d0c9a11";
    const AT: &str = "2026-01-01T00:09:00Z";

    fn ev<'a>(kind: &'a str, id: &'a str, at: &'a str, payload: serde_json::Value, att: &'a [u8]) -> HelperEvent<'a> {
        HelperEvent { kind, event_id: id, occurred_at: at, payload, attachment: att }
    }

    fn accept(d: &Desired, kind: &str, id: &str, at: &str, p: serde_json::Value, att: &[u8], user: &str) -> Result<serde_json::Value, String> {
        accept_helper_event(d, ev(kind, id, at, p, att), user, now())
    }

    #[test]
    fn apply_accepts_valid_and_keeps_old_on_bad_config() {
        let mut d = Desired::default();
        d.apply(CheckinReply {
            enabled: true,
            paused: true,
            uninstall: false,
            config_version: 4,
            config: Some(serde_json::json!({"screenshots": true})),
        })
        .unwrap();
        assert!(d.config.screenshots && d.config.version == 4 && d.paused && !d.capture());
        let err = d.apply(CheckinReply {
            enabled: true,
            paused: false,
            uninstall: false,
            config_version: 5,
            config: Some(serde_json::json!({"location": true, "screenshots": false})),
        });
        assert!(err.is_err());
        assert_eq!(d.config.version, 4);
        assert!(d.capture());
    }

    #[test]
    fn helper_cannot_spoof_user_or_kind() {
        let d = Desired::default();
        let p = accept(&d, "activity", ID, AT, serde_json::json!({"user":"mallory","apps":{}}), &[], "alice").unwrap();
        assert_eq!(p["user"], "alice");
        assert!(accept(&d, "session", ID, AT, serde_json::json!({}), &[], "alice").is_err());
        assert!(accept(&d, "activity", "x", AT, serde_json::json!({}), &[], "alice").is_err());
    }

    #[test]
    fn paused_rejects_capture_but_records_acknowledgment() {
        let d = Desired { paused: true, ..Desired::default() };
        assert!(accept(&d, "activity", ID, AT, serde_json::json!({}), &[], "a").is_err());
        assert!(accept(&d, "acknowledged", ID, AT, serde_json::json!({}), &[], "a").is_ok());
    }

    #[test]
    fn screenshot_rules() {
        let mut d = Desired::default();
        let jpg = [0xFF, 0xD8, 0xFF, 0x00];
        let loc = serde_json::json!({"location": {"latitude": 1.0}});
        assert!(accept(&d, "screenshot", ID, AT, loc.clone(), &jpg, "a").is_err());
        d.config.screenshots = true;
        assert!(accept(&d, "screenshot", ID, AT, loc.clone(), b"PNG", "a").is_err());
        let p = accept(&d, "screenshot", ID, AT, loc.clone(), &jpg, "a").unwrap();
        assert!(p.get("location").is_none(), "location stripped when disabled");
        assert_eq!(p["jpeg_b64"], "/9j/AA==");
        d.config.location = true;
        let p = accept(&d, "screenshot", ID, AT, loc, &jpg, "a").unwrap();
        assert!(p.get("location").is_some());
    }

    #[test]
    fn future_events_rejected() {
        let d = Desired::default();
        assert!(accept(&d, "activity", ID, "2026-01-01T01:00:00Z", serde_json::json!({}), &[], "a").is_err());
    }
}
