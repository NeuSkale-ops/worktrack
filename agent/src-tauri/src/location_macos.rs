use super::Fix;
use chrono::DateTime;
use std::time::{Duration, Instant};

extern "C" {
    fn wt_location_start(permission_only: bool) -> u64;
    fn wt_location_poll(identifier: u64, values: *mut f64) -> i32;
    fn wt_location_cancel(identifier: u64);
}
struct Request(u64);
impl Request {
    fn poll(&self, values: *mut f64) -> i32 {
        unsafe { wt_location_poll(self.0, values) }
    }
}
impl Drop for Request {
    fn drop(&mut self) {
        unsafe { wt_location_cancel(self.0) }
    }
}
pub(super) fn request_access(done: impl FnOnce(bool) + Send + 'static) -> Result<(), ()> {
    // The caller is on the main thread. Never wait for user consent there.
    let request = Request(unsafe { wt_location_start(true) });
    std::thread::spawn(move || {
        let started = Instant::now();
        loop {
            let state = request.poll(std::ptr::null_mut());
            if state != 0 || started.elapsed() >= Duration::from_secs(60) {
                done(state == 1);
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    });
    Ok(())
}
pub(super) fn position(allowed: impl Fn() -> bool) -> Option<Fix> {
    if !allowed() {
        return None;
    }
    let started = Instant::now();
    let request = Request(unsafe { wt_location_start(false) });
    loop {
        if !allowed() || started.elapsed() >= Duration::from_secs(5) {
            return None;
        }
        let mut values = [0.0; 4];
        match request.poll(values.as_mut_ptr()) {
            0 => std::thread::sleep(Duration::from_millis(100)),
            1 if allowed() => {
                return Some(Fix {
                    coords: (
                        values[0],
                        values[1],
                        values[2],
                        DateTime::from_timestamp_millis((values[3] * 1000.0) as i64)?,
                    ),
                    // CoreLocation does not expose Windows-style Wi-Fi/GPS/IP source labels.
                    source: "unknown".into(),
                    is_remote_source: None,
                });
            }
            _ => return None,
        }
    }
}
