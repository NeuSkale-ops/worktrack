use super::{platform, updater, Shared};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, State};

#[derive(Default)]
pub struct Consent {
    pub enabled: bool,
    pub pending: bool,
    pub error: Option<&'static str>,
    pub generation: u64,
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
pub fn set_location(app: AppHandle, state: State<Shared>, enabled: bool) -> Result<(), String> {
    let shared = state.inner().clone();
    let generation = {
        let mut r = shared.lock().map_err(|e| e.to_string())?;
        if enabled {
            updater::ensure_not_reserved(&r)?;
            if r.token.is_none() {
                return Err("Sign in before enabling screenshot location".into());
            }
        }
        r.location.reset();
        r.location.pending = enabled;
        r.location.generation
    };
    if !enabled {
        return Ok(());
    }
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
fn position(allowed: impl Fn() -> bool) -> Option<(f64, f64, f64, DateTime<Utc>)> {
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
    Some((
        coordinate.Latitude().ok()?,
        coordinate.Longitude().ok()?,
        coordinate.Accuracy().ok()?,
        observed,
    ))
}
#[cfg(not(windows))]
fn position(_allowed: impl Fn() -> bool) -> Option<(f64, f64, f64, DateTime<Utc>)> {
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
        });
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
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
