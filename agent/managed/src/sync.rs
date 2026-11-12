//! Sync engine logic: batch assembly and the retry/backoff schedule. The HTTP
//! transport lives in the service binary; this module is the pure, testable core.
//!
//! Delivery is at-least-once send + idempotent server ingest = exactly-once. The
//! agent sends oldest-first, the server returns acked_seq, the agent prunes
//! through it. A survived duplicate on retry is suppressed server-side.

use crate::buffer::Record;
use std::time::Duration;

pub const MAX_BATCH: usize = 500;
pub const MAX_BATCH_BYTES: usize = 256 * 1024;

#[derive(Debug, PartialEq, serde::Serialize)]
pub struct WireEvent {
    pub seq: i64,
    pub event_id: String,
    pub kind: String,
    pub occurred_at: String,
    pub payload: serde_json::Value,
}

/// Build one wire batch from oldest records, bounded by count and serialized
/// size so a burst of large screenshots cannot exceed the server's body limit.
pub fn build_batch(records: Vec<Record>) -> Vec<WireEvent> {
    let mut out = Vec::new();
    let mut bytes = 0usize;
    for r in records.into_iter().take(MAX_BATCH) {
        let approx = r.payload.to_string().len() + r.event_id.len() + 64;
        if !out.is_empty() && bytes + approx > MAX_BATCH_BYTES {
            break;
        }
        bytes += approx;
        out.push(WireEvent {
            seq: r.seq,
            event_id: r.event_id,
            kind: r.kind,
            occurred_at: r.occurred_at,
            payload: r.payload,
        });
    }
    out
}

/// Exponential backoff with full jitter, 5s floor and 30min ceiling. `attempt`
/// is the count of consecutive failures (0 after a success). `rand01` is a
/// caller-supplied uniform in [0,1) so the schedule stays deterministic to test.
pub fn backoff(attempt: u32, rand01: f64) -> Duration {
    let base = 5u64;
    let cap = 1800u64;
    let exp = base.saturating_mul(1u64 << attempt.min(10));
    let ceil = exp.min(cap);
    // Full jitter: uniform in [0, ceil].
    Duration::from_secs_f64(ceil as f64 * rand01.clamp(0.0, 1.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(seq: i64, pad: usize) -> Record {
        Record {
            seq,
            event_id: format!("id{seq}"),
            kind: "idle".into(),
            occurred_at: "2026-01-01T00:00:00Z".into(),
            payload: serde_json::json!({ "pad": "x".repeat(pad) }),
        }
    }

    #[test]
    fn batch_is_bounded_by_count() {
        let records: Vec<_> = (0..600).map(|i| rec(i, 0)).collect();
        assert_eq!(build_batch(records).len(), MAX_BATCH);
    }

    #[test]
    fn batch_is_bounded_by_bytes_but_always_sends_one() {
        // Each record ~300KB, over the per-batch byte cap; must still send one so
        // an oversized record never wedges the queue forever.
        let records: Vec<_> = (0..3).map(|i| rec(i, 300 * 1024)).collect();
        assert_eq!(build_batch(records).len(), 1);
    }

    #[test]
    fn backoff_grows_and_is_capped_and_jittered() {
        assert_eq!(backoff(0, 1.0), Duration::from_secs(5));
        assert_eq!(backoff(0, 0.0), Duration::from_secs(0));
        // Caps at 1800s even for huge attempt counts.
        assert_eq!(backoff(50, 1.0), Duration::from_secs(1800));
        // Monotonic ceiling before the cap.
        assert!(backoff(3, 1.0) > backoff(1, 1.0));
    }
}
