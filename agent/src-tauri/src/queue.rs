use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::path::Path;

pub const MAX_BYTES: i64 = 256 * 1024 * 1024;
pub struct Queue(pub Connection);
pub struct Item {
    pub id: i64,
    pub path: String,
    pub json: String,
    pub image: Option<Vec<u8>>,
}
impl Queue {
    pub fn atomic(&self, op: impl FnOnce(&Self) -> Result<(), String>) -> Result<(), String> {
        self.0
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| e.to_string())?;
        match op(self) {
            Ok(()) => self.0.execute_batch("COMMIT").map_err(|e| e.to_string()),
            Err(e) => {
                let _ = self.0.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }
    pub fn finalize_upload(&self, id: i64, payload: &Value) -> Result<(), String> {
        self.0
            .execute(
                "UPDATE queue SET json=?1 WHERE id=?2",
                params![payload.to_string(), id],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    pub fn open(path: &Path) -> Result<Self, String> {
        let c = Connection::open(path).map_err(|e| e.to_string())?;
        c.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA max_page_count=73728; CREATE TABLE IF NOT EXISTS queue(id INTEGER PRIMARY KEY, path TEXT NOT NULL, json TEXT NOT NULL, image BLOB); CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS rejected(id INTEGER PRIMARY KEY, path TEXT NOT NULL, json TEXT NOT NULL, image BLOB, status INTEGER NOT NULL, rejected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP); CREATE INDEX IF NOT EXISTS queue_location_pending ON queue(id) WHERE json_extract(json,'$.blocks[0].location.status')='pending';").map_err(|e| e.to_string())?;
        Ok(Self(c))
    }
    pub fn push(&self, path: &str, json: &Value, image: Option<&[u8]>) -> Result<(), String> {
        let json = json.to_string();
        let bytes: i64 = self
            .0
            .query_row(
                "SELECT COALESCE(SUM(length(json)+COALESCE(length(image),0)),0) FROM queue",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if bytes + json.len() as i64 + image.map_or(0, |b| b.len()) as i64
            > MAX_BYTES
                - if path == "/api/sessions/stop" {
                    0
                } else {
                    65536
                }
        {
            return Err(
                "Offline queue is full. Tracking stopped. Reconnect to sync before starting again."
                    .into(),
            );
        }
        self.0
            .execute(
                "INSERT INTO queue(path,json,image) VALUES (?1,?2,?3)",
                params![path, json, image],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn first(&self) -> Result<Option<Item>, String> {
        self.0
            .query_row(
                "SELECT id,path,json,image FROM queue ORDER BY id LIMIT 1",
                [],
                |r| {
                    Ok(Item {
                        id: r.get(0)?,
                        path: r.get(1)?,
                        json: r.get(2)?,
                        image: r.get(3)?,
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())
    }
    pub fn pending_location(
        &self,
    ) -> Result<Option<(i64, crate::location::Snapshot, String)>, String> {
        let row: Option<(i64, String)> = self.0.query_row("SELECT id,json FROM queue WHERE json_extract(json,'$.blocks[0].location.status')='pending' ORDER BY id LIMIT 1", [], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?;
        row.map(|(id, json)| {
            let payload: Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
            let location = serde_json::from_value(payload["blocks"][0]["location"].clone())
                .map_err(|e| e.to_string())?;
            let session = payload["blocks"][0]["session_id"]
                .as_str()
                .ok_or("Missing screenshot session")?
                .to_owned();
            Ok((id, location, session))
        })
        .transpose()
    }
    pub fn finish_location(
        &self,
        id: i64,
        location: &crate::location::Snapshot,
    ) -> Result<(), String> {
        self.0.execute("UPDATE queue SET json=json_set(json,'$.blocks[0].location',json(?2)) WHERE id=?1 AND json_extract(json,'$.blocks[0].location.status')='pending'", params![id, serde_json::to_string(location).map_err(|e|e.to_string())?]).map(|_|()).map_err(|e|e.to_string())
    }
    pub fn count(&self) -> usize {
        self.0
            .query_row("SELECT COUNT(*) FROM queue", [], |r| r.get(0))
            .unwrap_or(0)
    }
    pub fn get(&self, key: &str) -> Option<String> {
        self.0
            .query_row("SELECT value FROM settings WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .optional()
            .ok()
            .flatten()
    }
    pub fn set(&self, key: &str, value: &str) -> Result<(), String> {
        self.0
            .execute(
                "INSERT OR REPLACE INTO settings VALUES (?1,?2)",
                params![key, value],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    pub fn ack(&self, id: i64) -> Result<(), String> {
        self.0
            .execute("DELETE FROM queue WHERE id=?1", [id])
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    /// Moves an item the server permanently refused out of the FIFO so later
    /// records can sync. The row is kept locally for support, never resent.
    pub fn reject(&self, id: i64, status: u16) -> Result<(), String> {
        self.atomic(|q| {
            q.0.execute("INSERT INTO rejected(path,json,image,status) SELECT path,json,image,?2 FROM queue WHERE id=?1", params![id, status]).map_err(|e| e.to_string())?;
            // shortcut: keep only the newest 20 (screenshots are ~300 KB) inside the SQLite page cap.
            q.0.execute("DELETE FROM rejected WHERE id NOT IN (SELECT id FROM rejected ORDER BY id DESC LIMIT 20)", []).map_err(|e| e.to_string())?;
            q.ack(id)
        })
    }
    pub fn rejected_count(&self) -> usize {
        self.0
            .query_row("SELECT COUNT(*) FROM rejected", [], |r| r.get(0))
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejected_item_leaves_fifo_and_is_retained() {
        let q = Queue::open(Path::new(":memory:")).unwrap();
        q.push("/api/blocks", &serde_json::json!({"id":"bad"}), Some(&[9]))
            .unwrap();
        q.push("/stop", &serde_json::json!({"id":"next"}), None)
            .unwrap();
        let bad = q.first().unwrap().unwrap();
        q.reject(bad.id, 409).unwrap();
        assert_eq!(q.first().unwrap().unwrap().path, "/stop");
        assert_eq!((q.count(), q.rejected_count()), (1, 1));
        let (status, image): (i64, Vec<u8>) =
            q.0.query_row("SELECT status,image FROM rejected", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!((status, image), (409, vec![9]));
        for _ in 0..120 {
            q.push("/x", &serde_json::json!({}), None).unwrap();
            q.reject(q.first().unwrap().unwrap().id, 400).unwrap();
        }
        assert_eq!(q.rejected_count(), 20);
    }
    #[test]
    fn rollback_keeps_lifecycle_and_queue_together() {
        let q = Queue::open(Path::new(":memory:")).unwrap();
        let result = q.atomic(|q| {
            q.push("/start", &serde_json::json!({"id":"one"}), None)?;
            q.set("active_session", "one")?;
            Err("simulate failure".into())
        });
        assert!(result.is_err());
        assert_eq!(q.count(), 0);
        assert!(q.get("active_session").is_none());
    }
    #[test]
    fn upload_stage_survives_reopen_and_preserves_fifo() {
        let path =
            std::env::temp_dir().join(format!("worktrack-test-{}.sqlite", uuid::Uuid::new_v4()));
        {
            let q = Queue::open(&path).unwrap();
            q.push(
                "/api/blocks",
                &serde_json::json!({"blocks":[{"id":"one"}]}),
                Some(&[1, 2, 3]),
            )
            .unwrap();
            q.push("/stop", &serde_json::json!({"id":"two"}), None)
                .unwrap();
            let item = q.first().unwrap().unwrap();
            q.finalize_upload(
                item.id,
                &serde_json::json!({"blocks":[{"id":"one","screenshot_key":"stable"}]}),
            )
            .unwrap();
        }
        let q = Queue::open(&path).unwrap();
        let item = q.first().unwrap().unwrap();
        assert_eq!(item.image.as_deref(), Some([1, 2, 3].as_slice()));
        assert!(item.json.contains("stable"));
        q.ack(item.id).unwrap();
        assert_eq!(q.first().unwrap().unwrap().path, "/stop");
        drop(q);
        std::fs::remove_file(path).unwrap();
    }
}
