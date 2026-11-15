//! Local IPC between the session helper (user) and the service (SYSTEM) over a
//! named pipe. One request and one reply per connection. Each message is a
//! length-prefixed JSON frame followed by a length-prefixed binary attachment
//! (empty unless the request carries a screenshot JPEG).

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};

pub const PIPE_NAME: &str = r"\\.\pipe\WorkTrackAgent";
pub const MAX_JSON: u32 = 256 * 1024;
pub const MAX_ATTACHMENT: u32 = 5 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    /// Poll for the current capture state and config.
    State,
    /// Store one event. `kind` is limited by the service to helper kinds.
    Event {
        event_id: String,
        kind: String,
        occurred_at: String,
        payload: serde_json::Value,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Reply {
    pub ok: bool,
    /// Capture allowed right now (enabled, not paused, not uninstalling).
    pub capture: bool,
    pub config: crate::Config,
    #[serde(default)]
    pub error: Option<String>,
}

/// Kinds a helper may submit. Session lifecycle events come from the service.
pub const HELPER_KINDS: &[&str] = &["activity", "screenshot", "acknowledged"];

pub fn write_msg<W: Write, T: Serialize>(w: &mut W, msg: &T, attachment: &[u8]) -> std::io::Result<()> {
    let json = serde_json::to_vec(msg)?;
    if json.len() as u64 > MAX_JSON as u64 || attachment.len() as u64 > MAX_ATTACHMENT as u64 {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "message too large"));
    }
    let mut buf = Vec::with_capacity(8 + json.len() + attachment.len());
    buf.extend_from_slice(&(json.len() as u32).to_le_bytes());
    buf.extend_from_slice(&json);
    buf.extend_from_slice(&(attachment.len() as u32).to_le_bytes());
    buf.extend_from_slice(attachment);
    w.write_all(&buf)?;
    w.flush()
}

fn read_len<R: Read>(r: &mut R, max: u32) -> std::io::Result<usize> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len)?;
    let n = u32::from_le_bytes(len);
    if n > max {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame exceeds limit"));
    }
    Ok(n as usize)
}

pub fn read_msg<R: Read, T: for<'de> Deserialize<'de>>(r: &mut R) -> std::io::Result<(T, Vec<u8>)> {
    let n = read_len(r, MAX_JSON)?;
    let mut json = vec![0u8; n];
    r.read_exact(&mut json)?;
    let msg = serde_json::from_slice(&json)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let n = read_len(r, MAX_ATTACHMENT)?;
    let mut att = vec![0u8; n];
    r.read_exact(&mut att)?;
    Ok((msg, att))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_with_attachment() {
        let req = Request::Event {
            event_id: "e".into(),
            kind: "screenshot".into(),
            occurred_at: "2026-01-01T00:00:00Z".into(),
            payload: serde_json::json!({"a":1}),
        };
        let mut buf = Vec::new();
        write_msg(&mut buf, &req, &[0xFF, 0xD8, 0xFF]).unwrap();
        let (back, att): (Request, Vec<u8>) = read_msg(&mut buf.as_slice()).unwrap();
        assert_eq!(back, req);
        assert_eq!(att, vec![0xFF, 0xD8, 0xFF]);
    }

    #[test]
    fn rejects_oversized_frame_header() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&(MAX_JSON + 1).to_le_bytes());
        assert!(read_msg::<_, Request>(&mut buf.as_slice()).is_err());
    }

    #[test]
    fn state_request_is_tagged() {
        assert_eq!(serde_json::to_string(&Request::State).unwrap(), r#"{"op":"state"}"#);
    }
}
