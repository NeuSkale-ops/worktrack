//! WorkTrack managed-device agent core. Platform-independent modules for the
//! disclosed company-laptop monitoring service: capture config, redaction, the
//! durable local buffer, and sync batching/backoff. Windows service and session
//! helper binaries (in `src/bin`) build on top of these and are cfg(windows).

pub mod activity;
pub mod buffer;
pub mod config;
pub mod control;
pub mod ipc;
pub mod redact;
pub mod seal;
pub mod sync;
pub mod update;

pub use config::Config;
