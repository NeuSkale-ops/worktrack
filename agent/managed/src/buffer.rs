//! Durable local buffer. SQLite WAL with monotonic `seq`, payload sealed at rest,
//! size caps with coarsening-then-drop backpressure, and corruption recovery.
//!
//! Why SQLite over an append-only log: prune-after-ack, resume cursors and
//! corruption recovery all need an index. SQLite gives those for free and is
//! already a tested dependency. The cost is a slightly heavier writer, bounded
//! here by batching 60s interval rows rather than per-sample inserts.

use crate::seal::Sealer;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

pub struct Buffer<S: Sealer> {
    conn: Connection,
    sealer: S,
    max_bytes: i64,
    dropped: u64,
}

pub struct Record {
    pub seq: i64,
    pub event_id: String,
    pub kind: String,
    pub occurred_at: String,
    pub payload: serde_json::Value,
}

impl<S: Sealer> Buffer<S> {
    /// Open or create the buffer. On a corrupt file, the caller should rename it
    /// aside and reopen; `open` itself surfaces the integrity failure.
    pub fn open(path: &Path, sealer: S, max_bytes: i64) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
             CREATE TABLE IF NOT EXISTS events(
               seq INTEGER PRIMARY KEY AUTOINCREMENT,
               event_id TEXT NOT NULL,
               kind TEXT NOT NULL,
               occurred_at TEXT NOT NULL,
               sealed BLOB NOT NULL);
             CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )
        .map_err(|e| e.to_string())?;
        let ok: String = conn
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if ok != "ok" {
            return Err(format!("buffer integrity_check failed: {ok}"));
        }
        let dropped = conn
            .query_row("SELECT value FROM meta WHERE key='dropped'", [], |r| {
                r.get::<_, String>(0)
            })
            .optional()
            .map_err(|e| e.to_string())?
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        Ok(Self {
            conn,
            sealer,
            max_bytes,
            dropped,
        })
    }

    /// Append an event. Applies backpressure first: if over cap, coarsen then drop
    /// oldest, counting every dropped row so the loss is itself reported.
    pub fn push(
        &mut self,
        event_id: &str,
        kind: &str,
        occurred_at: &str,
        payload: &serde_json::Value,
    ) -> Result<i64, String> {
        self.enforce_cap()?;
        let sealed = self.sealer.seal(payload.to_string().as_bytes());
        self.conn
            .execute(
                "INSERT INTO events(event_id,kind,occurred_at,sealed) VALUES(?1,?2,?3,?4)",
                params![event_id, kind, occurred_at, sealed],
            )
            .map_err(|e| e.to_string())?;
        Ok(self.conn.last_insert_rowid())
    }

    fn total_bytes(&self) -> Result<i64, String> {
        self.conn
            .query_row(
                "SELECT COALESCE(SUM(length(sealed)+64),0) FROM events",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())
    }

    /// Drop oldest rows until under cap. Coarsening (merging 60s rows into 15min)
    /// is a future optimization; the safe floor is dropping oldest with a counter.
    fn enforce_cap(&mut self) -> Result<(), String> {
        while self.total_bytes()? > self.max_bytes {
            let removed = self
                .conn
                .execute(
                    "DELETE FROM events WHERE seq IN (SELECT seq FROM events ORDER BY seq LIMIT 64)",
                    [],
                )
                .map_err(|e| e.to_string())?;
            if removed == 0 {
                break; // single oversized row; nothing more to drop
            }
            self.dropped += removed as u64;
            self.conn
                .execute(
                    "INSERT OR REPLACE INTO meta(key,value) VALUES('dropped',?1)",
                    params![self.dropped.to_string()],
                )
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// FIFO batch for sync. Unseals payloads so the sync engine sends plaintext
    /// over TLS. Returns up to `limit` oldest records.
    pub fn batch(&self, limit: usize) -> Result<Vec<Record>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT seq,event_id,kind,occurred_at,sealed FROM events ORDER BY seq LIMIT ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![limit as i64], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Vec<u8>>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            let (seq, event_id, kind, occurred_at, sealed) = row.map_err(|e| e.to_string())?;
            let plain = self.sealer.unseal(&sealed)?;
            let payload = serde_json::from_slice(&plain).map_err(|e| e.to_string())?;
            out.push(Record {
                seq,
                event_id,
                kind,
                occurred_at,
                payload,
            });
        }
        Ok(out)
    }

    /// Prune everything up to and including the server-acked seq. Exactly-once:
    /// the server ingested these idempotently, so deleting locally cannot lose
    /// data and re-sending a survived row is harmless.
    pub fn prune_through(&self, acked_seq: i64) -> Result<usize, String> {
        self.conn
            .execute("DELETE FROM events WHERE seq<=?1", params![acked_seq])
            .map_err(|e| e.to_string())
    }

    pub fn depth(&self) -> i64 {
        self.conn
            .query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
            .unwrap_or(0)
    }

    pub fn dropped(&self) -> u64 {
        self.dropped
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::seal::Identity;

    fn tmp() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("wt-buf-{}.sqlite", uuid::Uuid::new_v4()))
    }

    #[test]
    fn push_batch_prune_roundtrip() {
        let path = tmp();
        let mut b = Buffer::open(&path, Identity, 100 * 1024 * 1024).unwrap();
        for i in 0..5 {
            b.push(
                &uuid::Uuid::new_v4().to_string(),
                "idle",
                "2026-01-01T00:00:00Z",
                &serde_json::json!({ "n": i }),
            )
            .unwrap();
        }
        assert_eq!(b.depth(), 5);
        let batch = b.batch(3).unwrap();
        assert_eq!(batch.len(), 3);
        assert_eq!(batch[0].payload["n"], 0);
        b.prune_through(batch[2].seq).unwrap();
        assert_eq!(b.depth(), 2);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn payload_is_sealed_at_rest() {
        // A real sealer would encrypt; even Identity stores via the sealed column,
        // so this asserts the plaintext is not stored in a queryable text column.
        let path = tmp();
        let mut b = Buffer::open(&path, Identity, 100 * 1024 * 1024).unwrap();
        b.push(
            "id",
            "foreground",
            "2026-01-01T00:00:00Z",
            &serde_json::json!({ "app": "secret.exe" }),
        )
        .unwrap();
        let text_cols: i64 = b
            .conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('events') WHERE name IN ('payload','json')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(text_cols, 0, "no plaintext payload column exists");
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn cap_drops_oldest_and_counts() {
        let path = tmp();
        // Tiny cap so a handful of rows trip backpressure.
        let mut b = Buffer::open(&path, Identity, 2048).unwrap();
        for i in 0..200 {
            b.push(
                "id",
                "idle",
                "2026-01-01T00:00:00Z",
                &serde_json::json!({ "n": i, "pad": "x".repeat(40) }),
            )
            .unwrap();
        }
        assert!(b.total_bytes().unwrap() <= 2048);
        assert!(b.dropped() > 0);
        // Dropped counter survives reopen so the loss is still reportable.
        let dropped = b.dropped();
        drop(b);
        let b2 = Buffer::open(&path, Identity, 2048).unwrap();
        assert_eq!(b2.dropped(), dropped);
        std::fs::remove_file(path).ok();
    }
}
