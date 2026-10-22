use super::{platform, updater, Shared};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, State};

#[derive(Default)]
pub struct Consent {
    pub diagnosing: bool,
    pub enabled: bool,
    pub pending: bool,
    pub error: Option<&'static str>,
    pub generation: u64,
}
type Coordinates = (f64, f64, f64, DateTime<Utc>);
struct Fix {
    coords: Coordinates,
    source: String,
    is_remote_source: Option<bool>,
}
#[derive(Serialize)]
pub struct Diagnostic {
    status: String,
    requested_at: DateTime<Utc>,
    latitude: Option<f64>,
    longitude: Option<f64>,
    accuracy_m: Option<f64>,
    observed_at: Option<DateTime<Utc>>,
    position_source: Option<String>,
    is_remote_source: Option<bool>,
}
impl Diagnostic {
    fn finish(snapshot: Snapshot, fix: Option<Fix>) -> Self {
        let result = snapshot.finish(fix.as_ref().map(|f| f.coords));
        let metadata = fix.filter(|_| result.status == "available");
        Self {
            status: result.status,
            requested_at: result.captured_at,
            latitude: result.latitude,
            longitude: result.longitude,
            accuracy_m: result.accuracy_m,
            observed_at: result.observed_at,
            position_source: metadata.as_ref().map(|f| f.source.clone()),
            is_remote_source: metadata.and_then(|f| f.is_remote_source),
        }
    }
}
fn diagnostic_gate(r: &super::Runtime, unlocked: bool) -> Result<(), String> {
    if r.token.is_none() || !r.location.enabled || r.location.pending {
        return Err("Sign in and allow location before diagnosing".into());
    }
    if !unlocked
        || r.session.is_some()
        || r.pending_stop.is_some()
        || r.update_reserved
        || r.shutting_down
    {
        return Err("Unlock the desktop and stop tracking before diagnosing".into());
    }
    Ok(())
}
fn diagnose(
    shared: &Shared,
    unlocked: impl Fn() -> bool,
    locate: impl FnOnce(&dyn Fn() -> bool) -> Option<Fix>,
) -> Result<Diagnostic, String> {
    let (generation, token, server, email, snapshot) = {
        let mut r = shared.lock().map_err(|_| "Location state unavailable")?;
        diagnostic_gate(&r, unlocked())?;
        if r.location.diagnosing {
            return Err("Location diagnostic already running".into());
        }
        r.location.diagnosing = true;
        (
            r.location.generation,
            r.token.clone(),
            r.server.clone(),
            r.queue.get("email"),
            Snapshot::new(true),
        )
    };
    // Keep singleflight reserved across consent resets until this worker exits.
    struct Reservation<'a>(&'a Shared);
    impl Drop for Reservation<'_> {
        fn drop(&mut self) {
            if let Ok(mut r) = self.0.lock() {
                r.location.diagnosing = false;
            }
        }
    }
    let _reservation = Reservation(shared);
    let cancelled = std::cell::Cell::new(false);
    let allowed = || {
        let valid = !cancelled.get()
            && unlocked()
            && shared.lock().is_ok_and(|r| {
                diagnostic_gate(&r, true).is_ok()
                    && r.location.generation == generation
                    && r.token == token
                    && r.server == server
                    && r.queue.get("email") == email
            });
        if !valid {
            cancelled.set(true);
        }
        valid
    };
    let fix = locate(&allowed);
    if !allowed() {
        return Err("Location diagnostic cancelled because state changed".into());
    }
    Ok(Diagnostic::finish(snapshot, fix))
}
#[tauri::command]
pub async fn diagnose_location(state: State<'_, Shared>) -> Result<Diagnostic, String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        diagnose(&shared, platform::unlocked, |allowed| position(allowed))
    })
    .await
    .map_err(|_| "Location diagnostic worker failed".to_string())?
}
impl Consent {
    pub fn reset(&mut self) {
        self.enabled = false;
        self.pending = false;
        self.error = None;
        self.generation = self.generation.wrapping_add(1);
    }
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Snapshot {
    pub status: String,
    pub captured_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latitude: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub longitude: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accuracy_m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_at: Option<DateTime<Utc>>,
}
impl Snapshot {
    pub fn new(enabled: bool) -> Self {
        Self {
            status: if enabled { "pending" } else { "disabled" }.into(),
            captured_at: super::utc_now(),
            latitude: None,
            longitude: None,
            accuracy_m: None,
            observed_at: None,
        }
    }
    pub(super) fn finish(mut self, fix: Option<(f64, f64, f64, DateTime<Utc>)>) -> Self {
        self.status = "unavailable".into();
        self.latitude = None;
        self.longitude = None;
        self.accuracy_m = None;
        self.observed_at = None;
        if let Some((lat, lon, accuracy, observed)) = fix {
            if lat.is_finite()
                && lon.is_finite()
                && accuracy.is_finite()
                && lat.abs() <= 90.0
                && lon.abs() <= 180.0
                && accuracy > 0.0
                && accuracy <= 20000000.0
                && observed >= self.captured_at - chrono::Duration::seconds(2)
                && observed <= self.captured_at + chrono::Duration::seconds(10)
            {
                self.status = "available".into();
                self.latitude = Some(lat);
                self.longitude = Some(lon);
                self.accuracy_m = Some(accuracy);
                self.observed_at = Some(observed);
            }
        }
        self
    }
}
#[tauri::command]
// Location is mandatory: there is no command to turn it off. The UI requests
// Windows permission after sign-in and Start stays blocked until it is granted.
pub fn request_location(app: AppHandle, state: State<Shared>) -> Result<(), String> {
    let shared = state.inner().clone();
    let generation = {
        let mut r = shared.lock().map_err(|e| e.to_string())?;
        updater::ensure_not_reserved(&r)?;
        if r.token.is_none() {
            return Err("Sign in before allowing screenshot location".into());
        }
        if r.location.enabled || r.location.pending {
            return Ok(());
        }
        r.location.reset();
        r.location.pending = true;
        r.location.generation
    };
    app.run_on_main_thread(move || {
        let callback_shared = shared.clone();
        let result = request_access(move |allowed| {
            if let Ok(mut r) = callback_shared.lock() {
                if r.location.generation != generation { return; }
                r.location.pending = false;
                r.location.enabled = allowed && r.token.is_some() && !r.update_reserved;
                if !r.location.enabled { r.location.error = Some("Location permission unavailable. Enable Windows location services and try again."); }
            }
        });
        if result.is_err() {
            if let Ok(mut r) = shared.lock() {
                if r.location.generation == generation {
                    r.location.pending = false;
                    r.location.error = Some("Windows location permission could not be requested.");
                }
            }
        }
    }).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn open_location_settings() -> Result<(), String> {
    #[cfg(windows)]
    {
        // Fixed URI, no user input reaches the shell.
        std::process::Command::new("explorer.exe")
            .arg("ms-settings:privacy-location")
            .spawn()
            .map(|_| ())
            .map_err(|_| "Could not open Windows location settings".to_string())
    }
    #[cfg(not(windows))]
    Err("Location settings are available only on Windows".into())
}
#[cfg(windows)]
fn request_access(done: impl FnOnce(bool) + Send + 'static) -> Result<(), ()> {
    use windows::Devices::Geolocation::{GeolocationAccessStatus, Geolocator};
    Geolocator::RequestAccessAsync()
        .map_err(|_| ())?
        .when(move |result| {
            done(result.is_ok_and(|access| access == GeolocationAccessStatus::Allowed))
        })
        .map_err(|_| ())
}
#[cfg(not(windows))]
fn request_access(done: impl FnOnce(bool) + Send + 'static) -> Result<(), ()> {
    done(false);
    Ok(())
}

#[cfg(windows)]
fn position(allowed: impl Fn() -> bool) -> Option<Fix> {
    use windows::{
        Devices::Geolocation::Geolocator,
        Foundation::TimeSpan,
        Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
    };
    unsafe {
        RoInitialize(RO_INIT_MULTITHREADED).ok()?;
    }
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe {
                RoUninitialize();
            }
        }
    }
    let _apartment = Apartment;
    if !allowed() {
        return None;
    }
    let operation = Geolocator::new()
        .ok()?
        .GetGeopositionAsyncWithAgeAndTimeout(
            TimeSpan { Duration: 0 },
            TimeSpan {
                Duration: 50_000_000,
            },
        )
        .ok()?;
    let started = std::time::Instant::now();
    loop {
        if !allowed() || started.elapsed() > Duration::from_secs(5) {
            let _ = operation.Cancel();
            return None;
        }
        match operation.Status().ok()?.0 {
            0 => std::thread::sleep(Duration::from_millis(100)),
            1 => break,
            _ => return None,
        }
    }
    if !allowed() {
        let _ = operation.Cancel();
        return None;
    }
    let coordinate = operation.GetResults().ok()?.Coordinate().ok()?;
    let ticks = coordinate
        .Timestamp()
        .ok()?
        .UniversalTime
        .checked_sub(116_444_736_000_000_000)?;
    let observed = DateTime::from_timestamp(ticks.div_euclid(10_000_000), 0)?;
    Some(Fix {
        coords: (
            coordinate.Latitude().ok()?,
            coordinate.Longitude().ok()?,
            coordinate.Accuracy().ok()?,
            observed,
        ),
        source: position_source_label(coordinate.PositionSource().ok().map(|source| source.0))
            .into(),
        is_remote_source: coordinate.IsRemoteSource().ok(),
    })
}
#[cfg(any(windows, test))]
fn position_source_label(source: Option<i32>) -> &'static str {
    match source {
        Some(0) => "cellular",
        Some(1) => "satellite",
        Some(2) => "wifi",
        Some(3) => "ip_address",
        Some(5) => "default",
        Some(6) => "obfuscated",
        _ => "unknown",
    }
}
#[cfg(not(windows))]
fn position(_allowed: impl Fn() -> bool) -> Option<Fix> {
    None
}

fn resolve_once(
    shared: &Shared,
    locate: impl FnOnce() -> Option<(f64, f64, f64, DateTime<Utc>)>,
) -> bool {
    let (id, snapshot, generation, session, eligible) = {
        let Ok(r) = shared.try_lock() else {
            return false;
        };
        let Ok(Some((id, snapshot, session))) = r.queue.pending_location() else {
            return false;
        };
        let fresh = (super::utc_now() - snapshot.captured_at).num_milliseconds();
        let eligible = r.location.enabled
            && r.session.as_deref() == Some(session.as_str())
            && !r.paused
            && (0..=2000).contains(&fresh);
        (id, snapshot, r.location.generation, session, eligible)
    };
    let fix = if eligible { locate() } else { None };
    if let Ok(mut r) = shared.lock() {
        let still_allowed = r.location.enabled
            && r.location.generation == generation
            && r.session.as_deref() == Some(session.as_str())
            && !r.paused;
        let result = snapshot.finish(if still_allowed { fix } else { None });
        if eligible {
            r.location.error = (result.status != "available")
                .then_some("Location unavailable for the latest screenshot. Tracking continues.");
        }
        let _ = r.queue.finish_location(id, &result);
    }
    true
}
pub fn run(shared: Shared) {
    loop {
        std::thread::sleep(Duration::from_millis(200));
        resolve_once(&shared, || {
            let (generation, session) = match shared.lock() {
                Ok(r) => (r.location.generation, r.session.clone()),
                Err(_) => return None,
            };
            position(|| {
                platform::unlocked()
                    && shared.lock().is_ok_and(|r| {
                        r.location.enabled
                            && r.location.generation == generation
                            && r.session == session
                            && r.session.is_some()
                            && !r.paused
                    })
            })
            .map(|fix| fix.coords)
        });
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    fn diagnostic_runtime() -> Shared {
        let mut r = crate::tests::runtime();
        r.token = Some("diagnostic-token".into());
        r.session = None;
        r.location.enabled = true;
        Arc::new(Mutex::new(r))
    }
    #[test]
    fn diagnostic_gates_never_request_position() {
        for gate in 0..8 {
            let shared = diagnostic_runtime();
            {
                let mut r = shared.lock().unwrap();
                match gate {
                    0 => r.token = None,
                    1 => r.location.enabled = false,
                    2 => r.location.pending = true,
                    3 => r.session = Some("tracking".into()),
                    4 => r.pending_stop = Some(("stopping".into(), super::super::utc_now())),
                    5 => r.update_reserved = true,
                    6 => r.location.diagnosing = true,
                    _ => r.shutting_down = true,
                }
            }
            assert!(diagnose(&shared, || true, |_| panic!("gated sensor request")).is_err());
        }
        assert!(diagnose(
            &diagnostic_runtime(),
            || false,
            |_| panic!("locked sensor request")
        )
        .is_err());
    }
    #[test]
    fn diagnostic_singleflight_cancel_and_privacy() {
        for change in 0..7 {
            let shared = diagnostic_runtime();
            let queued = shared.lock().unwrap().queue.count();
            assert!(diagnose(
                &shared,
                || true,
                |allowed| {
                    assert!(allowed());
                    assert!(
                        diagnose(&shared, || true, |_| panic!("second sensor request")).is_err()
                    );
                    let mut r = shared
                        .try_lock()
                        .expect("sensor must not hold tracking mutex");
                    assert!(super::super::require_location(&r).is_err());
                    match change {
                        0 => r.location.reset(),
                        1 => r.token = Some("changed-token".into()),
                        2 => r.server = "changed-server".into(),
                        3 => r.queue.set("email", "changed@example.test").unwrap(),
                        4 => r.session = Some("tracking".into()),
                        5 => r.pending_stop = Some(("stopping".into(), super::super::utc_now())),
                        _ => r.update_reserved = true,
                    }
                    assert!(r.location.diagnosing);
                    drop(r);
                    assert!(!allowed());
                    Some(Fix {
                        coords: (12.25, -73.5, 20.0, super::super::utc_now()),
                        source: "wifi".into(),
                        is_remote_source: Some(false),
                    })
                }
            )
            .is_err());
            let r = shared.lock().unwrap();
            assert!(!r.location.diagnosing);
            assert_eq!(r.queue.count(), queued);
            assert!(r.location.error.is_none());
        }
        let shared = diagnostic_runtime();
        let unlocked = std::cell::Cell::new(true);
        assert!(diagnose(
            &shared,
            || unlocked.get(),
            |allowed| {
                unlocked.set(false);
                assert!(!allowed());
                unlocked.set(true);
                assert!(!allowed(), "cancellation must stay latched");
                None
            }
        )
        .is_err());
        assert!(diagnose(&shared, || true, |_| None).is_ok());
    }
    #[test]
    fn diagnostic_report_mapping_and_honest_source_labels() {
        for (source, label) in [
            (0, "cellular"),
            (1, "satellite"),
            (2, "wifi"),
            (3, "ip_address"),
            (4, "unknown"),
            (5, "default"),
            (6, "obfuscated"),
            (999, "unknown"),
        ] {
            assert_eq!(position_source_label(Some(source)), label);
        }
        assert_eq!(position_source_label(None), "unknown");
        let snapshot = Snapshot::new(true);
        let report = Diagnostic::finish(
            snapshot.clone(),
            Some(Fix {
                coords: (12.25, -73.5, 20.0, snapshot.captured_at),
                source: "default".into(),
                is_remote_source: None,
            }),
        );
        let json = serde_json::to_value(report).unwrap();
        assert_eq!(json["status"], "available");
        assert_eq!(json["latitude"], 12.25);
        assert_eq!(json["longitude"], -73.5);
        assert_eq!(json["accuracy_m"], 20.0);
        assert_eq!(json["position_source"], "default");
        assert!(json["requested_at"].is_string());
        assert_eq!(json["observed_at"], json["requested_at"]);
        assert!(json["is_remote_source"].is_null());
        for fix in [
            None,
            Some(Fix {
                coords: (
                    12.25,
                    -73.5,
                    20.0,
                    snapshot.captured_at - chrono::Duration::minutes(1),
                ),
                source: "ip_address".into(),
                is_remote_source: Some(true),
            }),
        ] {
            let json = serde_json::to_value(Diagnostic::finish(snapshot.clone(), fix)).unwrap();
            assert_eq!(json.as_object().unwrap().len(), 8);
            assert_eq!(json["status"], "unavailable");
            for field in [
                "latitude",
                "longitude",
                "accuracy_m",
                "observed_at",
                "position_source",
                "is_remote_source",
            ] {
                assert!(json[field].is_null(), "{field} must not leak invalid fix");
            }
        }
        let shared = diagnostic_runtime();
        assert_eq!(
            diagnose(&shared, || true, |_| None).unwrap().status,
            "unavailable"
        );
        assert_eq!(shared.lock().unwrap().queue.count(), 0);
    }
    #[test]
    fn stopped_disabled_and_timed_out_requests_never_collect_or_stall_uploads() {
        let mut r = crate::tests::runtime();
        r.session = None;
        r.token = Some("test".into());
        r.location.enabled = true;
        let mut snapshot = Snapshot::new(true);
        snapshot.captured_at -= chrono::Duration::seconds(20);
        r.queue.push("/api/blocks", &serde_json::json!({"blocks":[{"id":"one", "session_id":"stopped", "location":snapshot}]}), Some(&[1])).unwrap();
        let shared = Arc::new(Mutex::new(r));
        assert!(crate::sync_one(&shared).is_ok_and(|sent| !sent));
        let mut snapshot = Snapshot::new(true);
        let r = shared.lock().unwrap();
        let item = r.queue.first().unwrap().unwrap();
        assert!(item.json.contains("unavailable"));
        // A late provider result must not overwrite a finalized/uploaded payload.
        snapshot.status = "available".into();
        r.queue.finish_location(item.id, &snapshot).unwrap();
        assert!(r
            .queue
            .first()
            .unwrap()
            .unwrap()
            .json
            .contains("unavailable"));
        r.queue.ack(item.id).unwrap();
        r.queue.push("/api/blocks", &serde_json::json!({"blocks":[{"session_id":"stopped", "location":Snapshot::new(true)}]}), Some(&[1])).unwrap();
        drop(r);
        assert!(resolve_once(&shared, || panic!(
            "location requested while stopped"
        )));
        shared
            .lock()
            .unwrap()
            .queue
            .push("/api/blocks", &serde_json::json!({"blocks":[{}]}), None)
            .unwrap();
        assert!(!resolve_once(&shared, || panic!(
            "ordinary blocks must not request location"
        )));
    }
    #[test]
    fn fresh_valid_fixes_only_and_no_location_on_ordinary_blocks() {
        let snapshot = Snapshot::new(true);
        assert_eq!(
            snapshot
                .clone()
                .finish(Some((0.0, 0.0, 10.0, snapshot.captured_at)))
                .status,
            "available"
        );
        for (lat, accuracy, observed) in [
            (91.0, 10.0, snapshot.captured_at),
            (f64::NAN, 10.0, snapshot.captured_at),
            (1.0, 0.0, snapshot.captured_at),
            (
                1.0,
                10.0,
                snapshot.captured_at - chrono::Duration::minutes(1),
            ),
        ] {
            assert_eq!(
                snapshot
                    .clone()
                    .finish(Some((lat, 1.0, accuracy, observed)))
                    .status,
                "unavailable"
            );
        }
        let mut r = crate::tests::runtime();
        r.location.enabled = true;
        r.session = Some("test".into());
        let snap = Snapshot::new(true);
        r.queue
            .push(
                "/api/blocks",
                &serde_json::json!({"blocks":[{"session_id":"test", "location":snap}]}),
                Some(&[1]),
            )
            .unwrap();
        let shared = Arc::new(Mutex::new(r));
        let locate = shared.clone();
        assert!(resolve_once(&shared, || {
            let mut r = locate
                .try_lock()
                .expect("location must not hold tracking mutex");
            r.location.reset();
            Some((1.0, 2.0, 3.0, snap.captured_at))
        }));
        let r = shared.lock().unwrap();
        let payload: serde_json::Value =
            serde_json::from_str(&r.queue.first().unwrap().unwrap().json).unwrap();
        assert_eq!(payload["blocks"][0]["location"]["status"], "unavailable");
        assert!(payload["blocks"][0]["location"].get("latitude").is_none());
    }
}
