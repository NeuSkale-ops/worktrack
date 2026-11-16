//! Self-update decision logic. The dashboard serves `/managed-agent/latest.json`
//! (version + SHA-256 pinned at deploy time) next to the release zip. The
//! service polls it, and only a strictly newer, well-formed release is taken.
//! A downgrade or malformed manifest is ignored, so a bad feed cannot roll
//! devices back to an older build.

use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Release {
    pub version: String,
    pub sha256: String,
}

fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let mut it = v.split('.').map(|p| p.parse::<u64>().ok());
    let r = (it.next()??, it.next()??, it.next()??);
    it.next().is_none().then_some(r)
}

impl Release {
    /// Zip path relative to the server origin.
    pub fn zip_path(&self) -> String {
        format!("/managed-agent/worktrack-managed-agent-{}.zip", self.version)
    }
}

/// Returns the release to install, or None when the feed is not newer than
/// `current` or is malformed.
pub fn pick(current: &str, feed: &[u8]) -> Option<Release> {
    let r: Release = serde_json::from_slice(feed).ok()?;
    let ok_hash = r.sha256.len() == 64 && r.sha256.bytes().all(|b| b.is_ascii_hexdigit());
    (ok_hash && parse_version(&r.version)? > parse_version(current)?).then_some(r)
}

/// True when `zip` hashes to the release's pinned SHA-256.
pub fn verify(r: &Release, zip: &[u8]) -> bool {
    use sha2::Digest;
    let hex: String = sha2::Sha256::digest(zip).iter().map(|b| format!("{b:02x}")).collect();
    hex.eq_ignore_ascii_case(&r.sha256)
}

#[cfg(test)]
mod tests {
    use super::*;
    const H: &str = "921b995c1a6b2ea8d21df4eab83b8954f6b0edc29836b636ec4fd74858b579ee";

    fn feed(v: &str, h: &str) -> Vec<u8> {
        serde_json::json!({ "version": v, "sha256": h }).to_string().into_bytes()
    }

    #[test]
    fn only_newer_valid_releases() {
        assert_eq!(pick("0.2.0", &feed("0.10.0", H)).unwrap().zip_path(), "/managed-agent/worktrack-managed-agent-0.10.0.zip");
        assert!(pick("0.2.0", &feed("0.2.0", H)).is_none());
        assert!(pick("0.2.0", &feed("0.1.9", H)).is_none(), "no downgrade");
        assert!(pick("0.2.0", &feed("1.0", H)).is_none());
        assert!(pick("0.2.0", &feed("1.0.0/../x", H)).is_none());
        assert!(pick("0.2.0", &feed("1.0.0", "abc")).is_none());
        assert!(pick("0.2.0", b"<html>").is_none());
    }

    #[test]
    fn verify_hash() {
        let empty = "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855";
        let r = Release { version: "1.0.0".into(), sha256: empty.into() };
        assert!(verify(&r, b""));
        assert!(!verify(&r, b"x"));
    }
}
