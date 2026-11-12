//! Encryption-at-rest boundary for the local buffer. The buffer seals every
//! payload before writing and unseals on read. On Windows the real sealer wraps
//! the data with machine-scope DPAPI (key never leaves the machine, bound to the
//! device). Tests use `Identity`.
//!
//! Honest limit: machine DPAPI plus file ACLs stops a standard user and casual
//! copying, not an offline disk-image attack. Full-disk protection is BitLocker,
//! enforced by Intune compliance policy, not by this layer.

pub trait Sealer {
    fn seal(&self, plain: &[u8]) -> Vec<u8>;
    fn unseal(&self, sealed: &[u8]) -> Result<Vec<u8>, String>;
}

/// No-op sealer for unit tests and non-Windows builds of the core library.
pub struct Identity;

impl Sealer for Identity {
    fn seal(&self, plain: &[u8]) -> Vec<u8> {
        plain.to_vec()
    }
    fn unseal(&self, sealed: &[u8]) -> Result<Vec<u8>, String> {
        Ok(sealed.to_vec())
    }
}

#[cfg(windows)]
pub use dpapi::Dpapi;

#[cfg(windows)]
mod dpapi {
    use super::Sealer;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_LOCAL_MACHINE, CRYPT_INTEGER_BLOB,
    };

    /// Machine-scope DPAPI. Any process on this machine can unseal, which is why
    /// the buffer file and its directory must deny read to non-admin users.
    pub struct Dpapi;

    impl Sealer for Dpapi {
        fn seal(&self, plain: &[u8]) -> Vec<u8> {
            unsafe {
                let input = CRYPT_INTEGER_BLOB {
                    cbData: plain.len() as u32,
                    pbData: plain.as_ptr() as *mut u8,
                };
                let mut out = CRYPT_INTEGER_BLOB::default();
                if CryptProtectData(
                    &input,
                    None,
                    None,
                    None,
                    None,
                    CRYPTPROTECT_LOCAL_MACHINE,
                    &mut out,
                )
                .is_ok()
                {
                    let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
                    let _ = LocalFree(Some(HLOCAL(out.pbData as *mut _)));
                    v
                } else {
                    // Fail closed: never store plaintext if protection fails.
                    Vec::new()
                }
            }
        }

        fn unseal(&self, sealed: &[u8]) -> Result<Vec<u8>, String> {
            if sealed.is_empty() {
                return Err("sealed payload is empty (seal failed at write time)".into());
            }
            unsafe {
                let input = CRYPT_INTEGER_BLOB {
                    cbData: sealed.len() as u32,
                    pbData: sealed.as_ptr() as *mut u8,
                };
                let mut out = CRYPT_INTEGER_BLOB::default();
                CryptUnprotectData(&input, None, None, None, None, 0, &mut out)
                    .map_err(|e| e.to_string())?;
                let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
                let _ = LocalFree(Some(HLOCAL(out.pbData as *mut _)));
                Ok(v)
            }
        }
    }
}
