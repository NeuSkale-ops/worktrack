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

/// Files a release zip must contain. Only these are extracted, flat, so a
/// crafted archive cannot write outside `dest` or drop extra executables.
pub const PAYLOAD: &[&str] = &["worktrack-svc.exe", "worktrack-session.exe", "install.ps1", "uninstall.ps1", "detect.ps1"];

/// Unpack the payload files from a verified release zip into `dest`.
pub fn unpack(zip: &[u8], dest: &std::path::Path) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip)).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for name in PAYLOAD {
        let mut f = archive.by_name(name).map_err(|e| format!("{name}: {e}"))?;
        let mut out = std::fs::File::create(dest.join(name)).map_err(|e| format!("{name}: {e}"))?;
        std::io::copy(&mut f, &mut out).map_err(|e| format!("{name}: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpack_takes_only_payload_files() {
        use std::io::Write;
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            let o = zip::write::SimpleFileOptions::default();
            for name in PAYLOAD.iter().chain(["../evil.exe", "extra.dll"].iter()) {
                z.start_file(*name, o).unwrap();
                z.write_all(name.as_bytes()).unwrap();
            }
            z.finish().unwrap();
        }
        let dir = std::env::temp_dir().join(format!("wt-unpack-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        unpack(buf.get_ref(), &dir).unwrap();
        let mut got: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        got.sort();
        let mut want: Vec<_> = PAYLOAD.iter().map(|s| s.to_string()).collect();
        want.sort();
        assert_eq!(got, want);
        assert_eq!(std::fs::read(dir.join("install.ps1")).unwrap(), b"install.ps1");
        assert!(unpack(b"not a zip", &dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
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
