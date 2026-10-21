use super::{client, utc_now, Shared};
use chrono::{DateTime, Utc};
use serde::Serialize;
use std::{collections::VecDeque, time::Duration};

const MAX_EVENTS: usize = 100;
const BATCH_SIZE: usize = 20;

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(clippy::enum_variant_names)] // Match the fixed backend event codes.
pub enum Code {
    LoginFailed,
    SyncFailed,
    CaptureFailed,
    ActivityFailed,
    QueueFailed,
    HeartbeatFailed,
    UpdateCheckFailed,
    UpdateInstallFailed,
    SyncRejected,
}

#[derive(Clone, Serialize)]
struct Event {
    id: String,
    occurred_at: DateTime<Utc>,
    code: Code,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<u16>,
}

#[derive(Default)]
pub struct Diagnostics {
    pub enabled: bool,
    pub error: Option<&'static str>,
    generation: u64,
    events: VecDeque<Event>,
    last: Option<Event>,
}

impl Diagnostics {
    pub fn configure(&mut self, enabled: bool) {
        self.generation = self.generation.wrapping_add(1);
        self.enabled = enabled;
        self.events.clear();
        self.last = None;
        self.error = None;
    }

    pub fn count(&self) -> usize {
        self.events.len()
    }

    // No free-form text argument: URLs, credentials and platform errors cannot enter logs.
    pub fn record(&mut self, code: Code, status: Option<u16>) {
        if !self.enabled {
            return;
        }
        let status = status.filter(|value| (100..=599).contains(value));
        let now = utc_now();
        if self.last.as_ref().is_some_and(|last| {
            last.code == code
                && last.status == status
                && (0..60).contains(&(now - last.occurred_at).num_seconds())
        }) {
            return;
        }
        let event = Event {
            id: uuid::Uuid::new_v4().to_string(),
            occurred_at: now,
            code,
            status,
        };
        if self.events.len() == MAX_EVENTS {
            self.events.pop_front();
        }
        self.last = Some(event.clone());
        self.events.push_back(event);
    }

    fn ack(&mut self, batch: &[Event]) {
        self.events
            .retain(|event| !batch.iter().any(|sent| sent.id == event.id));
        self.error = None;
    }
}

fn send_once(shared: &Shared) -> Result<(), ()> {
    let (server, token, generation, batch) = {
        let Ok(mut r) = shared.try_lock() else {
            return Ok(());
        };
        let oldest = utc_now() - chrono::Duration::days(7);
        r.diagnostics
            .events
            .retain(|event| event.occurred_at > oldest);
        if !r.diagnostics.enabled || r.diagnostics.events.is_empty() || r.shutting_down {
            return Ok(());
        }
        let Some(token) = r.token.clone() else {
            return Ok(());
        };
        (
            r.server.clone(),
            token,
            r.diagnostics.generation,
            r.diagnostics
                .events
                .iter()
                .take(BATCH_SIZE)
                .cloned()
                .collect::<Vec<_>>(),
        )
    };
    // Never hold the tracking mutex during diagnostic HTTP work.
    let delivered = match client() {
        Ok(http) => http
            .post(format!("{server}/api/agent/logs"))
            .timeout(Duration::from_secs(5))
            .bearer_auth(&token)
            .json(&serde_json::json!({"version":env!("CARGO_PKG_VERSION"),"events":batch}))
            .send()
            .is_ok_and(|response| response.status().is_success()),
        Err(_) => false,
    };
    if let Ok(mut r) = shared.try_lock() {
        // Ignore an old account or consent snapshot, including disable/re-enable in flight.
        if r.diagnostics.generation == generation
            && r.token.as_ref() == Some(&token)
            && r.server == server
        {
            if delivered {
                r.diagnostics.ack(&batch);
            } else {
                r.diagnostics.error = Some("Diagnostic upload failed. Retrying in the background.");
            }
        }
    }
    if delivered {
        Ok(())
    } else {
        Err(())
    }
}

pub fn run(shared: Shared) {
    let mut delay = 30;
    loop {
        std::thread::sleep(Duration::from_secs(delay));
        delay = if send_once(&shared).is_ok() {
            30
        } else {
            (delay * 2).min(300)
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consent_deduplication_and_disable_clear_pending_data() {
        let mut logs = Diagnostics::default();
        logs.record(Code::SyncFailed, None);
        assert_eq!(logs.count(), 0);
        logs.configure(true);
        logs.record(Code::SyncFailed, Some(503));
        logs.record(Code::SyncFailed, Some(503));
        assert_eq!(logs.count(), 1);
        logs.record(Code::HeartbeatFailed, Some(999));
        assert!(logs.events.back().unwrap().status.is_none());
        let generation = logs.generation;
        logs.configure(false);
        assert!(logs.generation != generation);
        assert_eq!(logs.count(), 0);
        logs.record(Code::CaptureFailed, None);
        assert_eq!(logs.count(), 0);
    }

    #[test]
    fn expired_events_are_discarded_without_touching_tracking_queue() {
        let mut r = crate::tests::runtime();
        r.diagnostics.configure(true);
        r.diagnostics.record(Code::SyncFailed, None);
        r.diagnostics.events[0].occurred_at -= chrono::Duration::days(8);
        let shared = std::sync::Arc::new(std::sync::Mutex::new(r));
        assert!(send_once(&shared).is_ok());
        let r = shared.lock().unwrap();
        assert_eq!(r.diagnostics.count(), 0);
        assert!(r.session.is_some());
    }

    #[test]
    fn bounded_buffer_and_ack_do_not_remove_new_events() {
        let mut logs = Diagnostics::default();
        logs.configure(true);
        for i in 0..100 {
            logs.record(
                if i % 2 == 0 {
                    Code::SyncFailed
                } else {
                    Code::QueueFailed
                },
                None,
            );
        }
        let in_flight: Vec<_> = logs.events.iter().take(20).cloned().collect();
        for i in 0..20 {
            logs.record(
                if i % 2 == 0 {
                    Code::SyncFailed
                } else {
                    Code::QueueFailed
                },
                None,
            );
        }
        assert_eq!(logs.count(), MAX_EVENTS);
        logs.ack(&in_flight);
        assert_eq!(logs.count(), MAX_EVENTS);
        let value = serde_json::to_value(&logs.events[0]).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 3);
        assert!(value.get("message").is_none());
        assert!(value.get("token").is_none());
    }

    #[test]
    fn failed_delivery_retains_same_ids_and_never_locks_tracking_during_http() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let mut r = crate::tests::runtime();
        r.server = format!("http://{}", listener.local_addr().unwrap());
        r.token = Some("diagnostic-test-token".into());
        r.diagnostics.configure(true);
        r.diagnostics.record(Code::CaptureFailed, None);
        r.queue
            .push("/tracking", &serde_json::json!({}), None)
            .unwrap();
        let shared = std::sync::Arc::new(std::sync::Mutex::new(r));
        let concurrent = shared.clone();
        let worker = std::thread::spawn(move || {
            let mut first_id = None;
            for (index, status) in [503, 200, 200].into_iter().enumerate() {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut headers = Vec::new();
                let mut byte = [0u8; 1];
                while !headers.ends_with(b"\r\n\r\n") {
                    stream.read_exact(&mut byte).unwrap();
                    headers.push(byte[0]);
                }
                let headers = String::from_utf8(headers).unwrap().to_ascii_lowercase();
                assert!(headers.starts_with("post /api/agent/logs http/1.1"));
                assert!(headers.contains("authorization: bearer diagnostic-test-token"));
                let size: usize = headers
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length: "))
                    .unwrap()
                    .parse()
                    .unwrap();
                let mut body = vec![0; size];
                stream.read_exact(&mut body).unwrap();
                let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(payload["version"], env!("CARGO_PKG_VERSION"));
                assert_eq!(
                    payload["events"][0]["code"],
                    if index == 2 {
                        "activity_failed"
                    } else {
                        "capture_failed"
                    }
                );
                let id = payload["events"][0]["id"].as_str().unwrap().to_string();
                if let Some(first) = &first_id {
                    if index == 2 {
                        assert_ne!(&id, first);
                    } else {
                        assert_eq!(&id, first);
                    }
                } else {
                    first_id = Some(id);
                }
                let mut r = concurrent
                    .try_lock()
                    .expect("diagnostic HTTP must leave tracking unlocked");
                assert_eq!(r.queue.count(), 1);
                assert!(r.session.is_some());
                if index == 1 {
                    r.diagnostics.configure(false);
                    r.diagnostics.configure(true);
                    r.diagnostics.record(Code::ActivityFailed, None);
                }
                drop(r);
                write!(
                    stream,
                    "HTTP/1.1 {status} Test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .unwrap();
            }
        });
        assert!(send_once(&shared).is_err());
        assert_eq!(shared.lock().unwrap().diagnostics.count(), 1);
        assert!(shared.lock().unwrap().diagnostics.error.is_some());
        assert!(send_once(&shared).is_ok());
        assert_eq!(shared.lock().unwrap().diagnostics.count(), 1);
        assert!(send_once(&shared).is_ok());
        let r = shared.lock().unwrap();
        assert_eq!(r.diagnostics.count(), 0);
        assert!(r.diagnostics.error.is_none());
        assert_eq!(r.queue.count(), 1);
        worker.join().unwrap();
    }
}
