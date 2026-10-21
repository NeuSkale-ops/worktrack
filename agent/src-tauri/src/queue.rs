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
                "UPDATE queue SET json=?1,image=NULL WHERE id=?2",
                params![payload.to_string(), id],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    pub fn open(path: &Path) -> Result<Self, String> {
        let c = Connection::open(path).map_err(|e| e.to_string())?;
        c.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA max_page_count=73728; CREATE TABLE IF NOT EXISTS queue(id INTEGER PRIMARY KEY, path TEXT NOT NULL, json TEXT NOT NULL, image BLOB); CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);").map_err(|e| e.to_string())?;
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
}

#[cfg(test)]
mod tests {
    use super::*;
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
        assert!(item.image.is_none());
        assert!(item.json.contains("stable"));
        q.ack(item.id).unwrap();
        assert_eq!(q.first().unwrap().unwrap().path, "/stop");
        drop(q);
        std::fs::remove_file(path).unwrap();
    }
}
