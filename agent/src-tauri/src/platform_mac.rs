//! Native read-only sampling. No event taps, keyboard hooks, Apple Events or consent requests.
use std::ffi::{c_char, c_void, CStr};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

type Ref = *const c_void;
type Object = *mut c_void;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceSecondsSinceLastEventType(state: i32, event: u32) -> f64;
    fn CGSessionCopyCurrentDictionary() -> Ref;
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
    fn CGMainDisplayID() -> u32;
    fn CGDisplayIsActive(display: u32) -> u32;
    fn CGDisplayIsAsleep(display: u32) -> u32;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(value: Ref);
    fn CFGetTypeID(value: Ref) -> usize;
    fn CFBooleanGetTypeID() -> usize;
    fn CFBooleanGetValue(value: Ref) -> u8;
    fn CFNumberGetTypeID() -> usize;
    fn CFNumberGetValue(value: Ref, kind: i32, result: *mut c_void) -> u8;
    fn CFDictionaryGetValue(dictionary: Ref, key: Ref) -> Ref;
    fn CFStringCreateWithCString(allocator: Ref, text: *const c_char, encoding: u32) -> Ref;
}
#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IORegistryGetRootEntry(port: u32) -> u32;
    fn IORegistryEntryCreateCFProperty(entry: u32, key: Ref, allocator: Ref, options: u32) -> Ref;
    fn IOObjectRelease(object: u32) -> i32;
}
#[link(name = "AppKit", kind = "framework")]
extern "C" {}
#[link(name = "objc")]
extern "C" {
    fn objc_getClass(name: *const c_char) -> Object;
    fn sel_registerName(name: *const c_char) -> Object;
    fn objc_msgSend();
    fn objc_autoreleasePoolPush() -> Object;
    fn objc_autoreleasePoolPop(pool: Object);
    fn getuid() -> u32;
}

struct Owned(Ref);
impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) }
        }
    }
}

unsafe fn string(value: &CStr) -> Owned {
    Owned(CFStringCreateWithCString(
        std::ptr::null(),
        value.as_ptr(),
        0x08000100,
    ))
}

unsafe fn session_value(session: Ref, key: &CStr) -> Ref {
    let key = string(key);
    if key.0.is_null() {
        std::ptr::null()
    } else {
        CFDictionaryGetValue(session, key.0)
    }
}

pub fn screen_capture_allowed() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
}

/// Call only after an explicit user action. Unlike the preflight check, this may show consent UI.
pub fn request_screen_capture() -> bool {
    unsafe { CGRequestScreenCaptureAccess() }
}

unsafe fn boolean(value: Ref) -> Option<bool> {
    if value.is_null() || CFGetTypeID(value) != CFBooleanGetTypeID() {
        None
    } else {
        Some(CFBooleanGetValue(value) != 0)
    }
}

fn safe_session(
    locked: Option<bool>,
    on_console: Option<bool>,
    logged_in: Option<bool>,
    own_user: bool,
    awake: bool,
) -> bool {
    locked == Some(false)
        && on_console == Some(true)
        && logged_in == Some(true)
        && own_user
        && awake
}

// macOS monotonic uptime may exclude system sleep. A wall/uptime divergence
// therefore closes the gate briefly on wake even when the display is already on.
// Clock adjustments also pause sampling, which is the safe direction.
fn sampling_gap(elapsed: Duration, wall_elapsed: Option<Duration>) -> bool {
    elapsed > Duration::from_secs(2)
        || wall_elapsed
            .map(|delta| delta.abs_diff(elapsed) > Duration::from_millis(250))
            .unwrap_or(true)
}

fn awake_since_last_sample() -> bool {
    static SAMPLE: Mutex<Option<(Instant, SystemTime, Option<Instant>)>> = Mutex::new(None);
    let Ok(mut sample) = SAMPLE.lock() else {
        return false;
    };
    let now = Instant::now();
    let wall = SystemTime::now();
    let mut blocked_until = None;
    if let Some((last, last_wall, blocked)) = *sample {
        blocked_until = blocked;
        let elapsed = now.duration_since(last);
        if sampling_gap(elapsed, wall.duration_since(last_wall).ok()) {
            blocked_until = Some(now + Duration::from_secs(2));
        }
    }
    *sample = Some((now, wall, blocked_until));
    blocked_until.map(|until| now >= until).unwrap_or(true)
}

pub fn unlocked() -> bool {
    let stable_awake = awake_since_last_sample();
    unsafe {
        let session = Owned(CGSessionCopyCurrentDictionary());
        if session.0.is_null() {
            return false;
        }
        let root = IORegistryGetRootEntry(0); // kIOMainPortDefault
        if root == 0 {
            return false;
        }
        let key = Owned(CFStringCreateWithCString(
            std::ptr::null(),
            c"IOConsoleLocked".as_ptr(),
            0x08000100,
        ));
        if key.0.is_null() {
            IOObjectRelease(root);
            return false;
        }
        // shortcut: IOConsoleLocked is an undocumented WindowServer property. Require an
        // explicit typed false; missing/changed properties disable collection. Replace
        // with a public lock-state API if Apple provides one.
        let locked = Owned(IORegistryEntryCreateCFProperty(
            root,
            key.0,
            std::ptr::null(),
            0,
        ));
        IOObjectRelease(root);
        let user = session_value(session.0, c"kCGSSessionUserIDKey");
        let mut uid: i64 = -1;
        let own_user = !user.is_null()
            && CFGetTypeID(user) == CFNumberGetTypeID()
            && CFNumberGetValue(user, 4, (&mut uid as *mut i64).cast()) != 0
            && uid == i64::from(getuid());
        let display = CGMainDisplayID();
        safe_session(
            boolean(locked.0),
            boolean(session_value(session.0, c"kCGSSessionOnConsoleKey")),
            boolean(session_value(session.0, c"kCGSessionLoginDoneKey")),
            own_user,
            stable_awake
                && display != 0
                && CGDisplayIsActive(display) != 0
                && CGDisplayIsAsleep(display) == 0,
        )
    }
}

pub fn idle_seconds() -> Option<f64> {
    // Combined session state, any input event. Reads elapsed time only, never event data.
    let seconds = unsafe { CGEventSourceSecondsSinceLastEventType(0, u32::MAX) };
    (seconds.is_finite() && seconds >= 0.0).then_some(seconds)
}

unsafe fn send(receiver: Object, selector: &CStr) -> Object {
    let call: unsafe extern "C" fn(Object, Object) -> Object =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    call(receiver, sel_registerName(selector.as_ptr()))
}

pub fn foreground_app() -> Option<String> {
    if !unlocked() {
        return None;
    }
    unsafe {
        // Collector runs off the main thread. Bound autoreleased AppKit objects to this call.
        let pool = objc_autoreleasePoolPush();
        let result = (|| {
            let workspace = send(objc_getClass(c"NSWorkspace".as_ptr()), c"sharedWorkspace");
            let app = send(workspace, c"frontmostApplication");
            if app.is_null() {
                return None;
            }
            // Bundle identity avoids collecting window titles, URLs, or document paths.
            let identifier = send(app, c"bundleIdentifier");
            let bytes = send(identifier, c"UTF8String").cast::<c_char>();
            if bytes.is_null() {
                return None;
            }
            let name = CStr::from_ptr(bytes).to_str().ok()?.trim().to_lowercase();
            (!name.is_empty()
                && name.len() <= 256
                && !name.chars().any(|c| c.is_control() || c == ':'))
            .then_some(name)
        })();
        objc_autoreleasePoolPop(pool);
        // Discard identity if the session changed while sampling.
        if unlocked() {
            result
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wake_and_clock_changes_close_gate() {
        let tick = Duration::from_millis(100);
        assert!(!sampling_gap(tick, Some(tick)));
        assert!(sampling_gap(tick, Some(Duration::from_secs(60))));
        assert!(sampling_gap(tick, None));
        assert!(sampling_gap(
            Duration::from_secs(3),
            Some(Duration::from_secs(3))
        ));
    }

    #[test]
    fn uncertain_or_inactive_session_is_closed() {
        assert!(safe_session(
            Some(false),
            Some(true),
            Some(true),
            true,
            true
        ));
        for lock in [None, Some(true)] {
            assert!(!safe_session(lock, Some(true), Some(true), true, true));
        }
        for state in [None, Some(false)] {
            assert!(!safe_session(Some(false), state, Some(true), true, true));
            assert!(!safe_session(Some(false), Some(true), state, true, true));
        }
        assert!(!safe_session(
            Some(false),
            Some(true),
            Some(true),
            false,
            true
        ));
        assert!(!safe_session(
            Some(false),
            Some(true),
            Some(true),
            true,
            false
        ));
        unsafe { assert_eq!(boolean(std::ptr::null()), None) };
    }

    #[test]
    #[ignore = "requires an unlocked physical Mac console with a foreground bundled app"]
    fn live_console_is_usable() {
        assert!(
            unlocked(),
            "current unlocked console must pass native gates"
        );
        assert!(
            foreground_app().is_some(),
            "NSWorkspace must return an app identity"
        );
        assert!(idle_seconds().is_some());
        let _ = screen_capture_allowed(); // Preflight only. Never request consent in tests.
    }

    #[test]
    fn native_read_only_smoke() {
        let idle = idle_seconds().expect("native idle query must return valid seconds");
        assert!(idle.is_finite() && idle >= 0.0);
        let open = unlocked();
        let app = foreground_app();
        if !open {
            assert!(app.is_none());
        }
        if let Some(app) = app {
            assert!(!app.is_empty() && app.len() <= 256);
        }
        // Do not print application identity or session/user data in test output.
    }
}
