use super::{Runtime, Shared};
use rusqlite::OptionalExtension;
use serde::Serialize;
use std::time::Duration;
use tauri::State;
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Clone, Serialize)]
pub struct UpdateStatus {
    pub phase: &'static str,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub error: Option<String>,
}
impl Default for UpdateStatus {
    fn default() -> Self {
        Self {
            phase: "idle",
            downloaded: 0,
            total: None,
            error: None,
        }
    }
}
#[derive(Serialize)]
pub struct UpdateMetadata {
    version: String,
    current_version: String,
    body: Option<String>,
    date: Option<String>,
}

pub fn ensure_not_reserved(r: &Runtime) -> Result<(), String> {
    if r.shutting_down {
        return Err("WorkTrack is shutting down. Reopen the app to continue.".into());
    }
    if r.update_reserved {
        Err("An update is reserved. Wait for installation to finish before changing tracking or login.".into())
    } else {
        Ok(())
    }
}

fn reserve(r: &mut Runtime) -> Result<(), String> {
    ensure_not_reserved(r)?;
    r.update_reserved = true;
    // Read SQLite fallibly: an unreadable queue must never be mistaken for empty.
    let eligible = (|| {
        let queued: i64 = r
            .queue
            .0
            .query_row("SELECT COUNT(*) FROM queue", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        let active: Option<String> = r
            .queue
            .0
            .query_row(
                "SELECT value FROM settings WHERE key='active_session'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if r.session.is_some() || queued != 0 || active.is_some_and(|id| !id.is_empty()) {
            return Err("Stop tracking and sync all pending records before installing an update. Pending data has been retained.".into());
        }
        Ok(())
    })();
    if eligible.is_err() {
        r.update_reserved = false;
    }
    eligible
}

// Retains exclusivity without holding the Runtime mutex across network or installer work.
// Cancellation, unwinding, and all ordinary failure paths release the reservation.
struct Reservation {
    shared: Shared,
    installed: bool,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        if !self.installed {
            if let Ok(mut r) = self.shared.lock() {
                r.update_reserved = false;
                if r.update.phase != "error" {
                    r.update.phase = "error";
                    r.update.error =
                        Some("Update interrupted. You can retry or continue tracking.".into());
                }
            }
        }
    }
}

fn configured_updater(app: &tauri::AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    if !cfg!(windows) {
        return Err("UPDATER_UNAVAILABLE: In-app updates are supported only on Windows.".into());
    }
    let config = app.config().plugins.0.get("updater");
    if config
        .and_then(|c| c.get("pubkey"))
        .and_then(|v| v.as_str())
        .is_none_or(|key| key.trim().is_empty())
    {
        return Err("UPDATER_UNAVAILABLE: Updates are not enabled in this build. Install a signed updater-enabled release supplied by your administrator.".into());
    }
    if config
        .and_then(|c| c.get("requireSignedVersion"))
        .and_then(|v| v.as_bool())
        != Some(true)
    {
        return Err(
            "UPDATER_UNAVAILABLE: Updates require signed version verification in this build's configuration.".into(),
        );
    }
    app.updater_builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_update(
    app: tauri::AppHandle,
    state: State<'_, Shared>,
) -> Result<Option<UpdateMetadata>, String> {
    let shared = state.inner().clone();
    {
        let mut r = shared.lock().map_err(|e| e.to_string())?;
        ensure_not_reserved(&r)?;
        if r.update.phase == "checking" {
            return Err("An update check is already running.".into());
        }
        r.pending_update = None;
        r.update = UpdateStatus {
            phase: "checking",
            ..Default::default()
        };
    }
    let result = async {
        configured_updater(&app)?
            .check()
            .await
            .map_err(|e| e.to_string())
    }
    .await;
    let mut r = shared.lock().map_err(|e| e.to_string())?;
    match result {
        Ok(update) => {
            let metadata = update.as_ref().map(|u| UpdateMetadata {
                version: u.version.clone(),
                current_version: u.current_version.clone(),
                body: u.body.clone(),
                date: u.date.map(|d| d.to_string()),
            });
            r.update.phase = if update.is_some() {
                "available"
            } else {
                "idle"
            };
            r.pending_update = update;
            Ok(metadata)
        }
        Err(error) => {
            r.update.phase = if error.starts_with("UPDATER_UNAVAILABLE:") {
                "unavailable"
            } else {
                "error"
            };
            r.update.error = Some(error.clone());
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn install_update(state: State<'_, Shared>, version: String) -> Result<(), String> {
    // An IPC caller going away must not release the gate while a blocking installer runs.
    let shared = state.inner().clone();
    tauri::async_runtime::spawn(install(shared, version))
        .await
        .map_err(|e| e.to_string())?
}

async fn install(shared: Shared, version: String) -> Result<(), String> {
    if !cfg!(windows) {
        return Err("UPDATER_UNAVAILABLE: In-app updates are supported only on Windows.".into());
    }
    let update: Update = {
        let mut r = shared.lock().map_err(|e| e.to_string())?;
        ensure_not_reserved(&r)?;
        let update = r
            .pending_update
            .as_ref()
            .filter(|u| u.version == version)
            .ok_or("This update is no longer available. Check for updates again.")?
            .clone();
        reserve(&mut r)?;
        r.update = UpdateStatus {
            phase: "downloading",
            ..Default::default()
        };
        update
    };
    let mut reservation = Reservation {
        shared: shared.clone(),
        installed: false,
    };
    let result = async {
        let bytes = update
            .download(
                |chunk, total| {
                    if let Ok(mut r) = shared.lock() {
                        r.update.downloaded = r.update.downloaded.saturating_add(chunk as u64);
                        r.update.total = total;
                    }
                },
                || {},
            )
            .await
            .map_err(|e| e.to_string())?;
        shared.lock().map_err(|e| e.to_string())?.update.phase = "installing";
        // The official plugin verifies the signature on download AND again on install.
        tauri::async_runtime::spawn_blocking(move || {
            update.install(bytes).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }
    .await;
    let mut r = shared.lock().map_err(|e| e.to_string())?;
    match result {
        Ok(()) => {
            r.update.phase = "installed";
            reservation.installed = true;
            Ok(())
        }
        Err(error) => {
            r.update.phase = if error.starts_with("UPDATER_UNAVAILABLE:") {
                "unavailable"
            } else {
                "error"
            };
            r.update.error = Some(error.clone());
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::runtime;
    #[test]
    fn active_paused_queue_and_unfinished_stop_block_install() {
        let mut r = runtime();
        r.paused = true;
        assert!(reserve(&mut r).is_err());
        assert!(!r.update_reserved);
        r.session = None;
        r.queue
            .push("/api/sessions/stop", &serde_json::json!({}), None)
            .unwrap();
        assert!(reserve(&mut r).is_err());
        r.queue.0.execute("DELETE FROM queue", []).unwrap();
        r.queue.set("active_session", "unfinished").unwrap();
        assert!(reserve(&mut r).is_err());
        assert!(!r.update_reserved);
        r.queue.set("active_session", "").unwrap();
        reserve(&mut r).unwrap();
        assert!(ensure_not_reserved(&r).is_err());
        assert!(reserve(&mut r).is_err());
        assert!(r.update_reserved);
    }
    #[test]
    fn reservation_releases_on_failure_and_retains_on_success() {
        for installed in [false, true] {
            let mut r = runtime();
            r.session = None;
            reserve(&mut r).unwrap();
            let shared = std::sync::Arc::new(std::sync::Mutex::new(r));
            drop(Reservation {
                shared: shared.clone(),
                installed,
            });
            let r = shared.lock().unwrap();
            assert_eq!(r.update_reserved, installed);
            assert_eq!(ensure_not_reserved(&r).is_err(), installed);
        }
    }
    #[test]
    fn unreadable_pending_data_fails_closed() {
        let mut r = runtime();
        r.session = None;
        r.queue.0.execute("DROP TABLE queue", []).unwrap();
        assert!(reserve(&mut r).is_err());
        assert!(!r.update_reserved);
    }

    #[test]
    fn unreadable_session_marker_fails_closed() {
        let mut r = runtime();
        r.session = None;
        r.queue.0.execute("DROP TABLE settings", []).unwrap();
        assert!(reserve(&mut r).is_err());
        assert!(!r.update_reserved);
    }

    #[test]
    fn reserved_download_leaves_mutex_free_but_rejects_concurrent_mutations() {
        let mut r = runtime();
        r.session = None;
        reserve(&mut r).unwrap();
        let shared = std::sync::Arc::new(std::sync::Mutex::new(r));
        let reservation = Reservation {
            shared: shared.clone(),
            installed: false,
        };
        let concurrent = shared.clone();
        std::thread::spawn(move || {
            let mut r = concurrent
                .try_lock()
                .expect("download must not hold Runtime mutex");
            // Every Start, login and logout command uses this guard under the same lock.
            assert!(ensure_not_reserved(&r).is_err());
            assert!(reserve(&mut r).is_err());
            assert!(r.session.is_none());
            assert_eq!(r.queue.count(), 0);
        })
        .join()
        .unwrap();
        drop(reservation);
        assert!(ensure_not_reserved(&shared.lock().unwrap()).is_ok());
    }

    #[test]
    fn quit_admitted_first_blocks_update_reservation() {
        let mut r = runtime();
        r.session = None;
        r.shutting_down = true;
        assert!(reserve(&mut r).is_err());
        assert!(!r.update_reserved);
    }
}
