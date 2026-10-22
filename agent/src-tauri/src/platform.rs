// No keyboard hooks: Windows exposes only the timestamp of the last input.
#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    #[repr(C)]
    struct LastInput {
        size: u32,
        tick: u32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetLastInputInfo(info: *mut LastInput) -> i32;
        fn GetForegroundWindow() -> *mut c_void;
        fn GetWindowThreadProcessId(window: *mut c_void, process: *mut u32) -> u32;
        fn OpenInputDesktop(flags: u32, inherit: i32, access: u32) -> *mut c_void;
        fn CloseDesktop(desktop: *mut c_void) -> i32;
        fn SwitchDesktop(desktop: *mut c_void) -> i32;
        fn GetUserObjectInformationW(
            handle: *mut c_void,
            index: i32,
            value: *mut c_void,
            len: u32,
            needed: *mut u32,
        ) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetTickCount() -> u32;
        fn OpenProcess(access: u32, inherit: i32, id: u32) -> *mut c_void;
        fn QueryFullProcessImageNameW(
            process: *mut c_void,
            flags: u32,
            path: *mut u16,
            size: *mut u32,
        ) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    // shortcut: hosted UWP/PWA windows share an executable; add package identity if per-package reporting is required.
    pub fn foreground_app() -> Option<String> {
        unsafe {
            let mut pid = 0;
            let window = GetForegroundWindow();
            if window.is_null() || GetWindowThreadProcessId(window, &mut pid) == 0 {
                return None;
            }
            let process = OpenProcess(0x1000, 0, pid); // PROCESS_QUERY_LIMITED_INFORMATION
            if process.is_null() {
                return None;
            }
            let mut path = [0u16; 32768];
            let mut size = path.len() as u32;
            let success = QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut size);
            CloseHandle(process);
            if success == 0 || size as usize > path.len() {
                return None;
            }
            let path = String::from_utf16_lossy(&path[..size as usize]);
            let name: String = path.rsplit(['\\', '/']).next()?.chars().take(64).collect();
            let name = name.trim().to_lowercase();
            (!name.is_empty()
                && name.len() <= 256
                && !name.chars().any(|c| c.is_control() || c == ':'))
            .then_some(name)
        }
    }
    pub fn idle_seconds() -> Option<f64> {
        let mut input = LastInput {
            size: std::mem::size_of::<LastInput>() as u32,
            tick: 0,
        };
        unsafe {
            if GetLastInputInfo(&mut input) == 0 {
                None
            } else {
                Some(GetTickCount().wrapping_sub(input.tick) as f64 / 1000.0)
            }
        }
    }
    pub fn unlocked() -> bool {
        unsafe {
            // DESKTOP_READOBJECTS | DESKTOP_SWITCHDESKTOP. Failure is fail-closed.
            let desktop = OpenInputDesktop(0, 0, 0x0001 | 0x0100);
            if desktop.is_null() {
                return false;
            }
            let mut name = [0u16; 128];
            let mut needed = 0;
            let read =
                GetUserObjectInformationW(desktop, 2, name.as_mut_ptr().cast(), 256, &mut needed);
            let end = name.iter().position(|c| *c == 0).unwrap_or(name.len());
            let safe = read != 0
                && String::from_utf16_lossy(&name[..end]).eq_ignore_ascii_case("Default")
                && SwitchDesktop(desktop) != 0;
            CloseDesktop(desktop);
            safe
        }
    }
}
#[cfg(windows)]
pub use win::{foreground_app, idle_seconds, unlocked};
#[cfg(target_os = "macos")]
#[path = "platform_mac.rs"]
mod mac;
#[cfg(target_os = "macos")]
pub use mac::{
    foreground_app, idle_seconds, request_screen_capture, screen_capture_allowed, unlocked,
};
#[cfg(not(target_os = "macos"))]
pub fn screen_capture_allowed() -> bool {
    cfg!(windows)
}
#[cfg(not(target_os = "macos"))]
pub fn request_screen_capture() -> bool {
    screen_capture_allowed()
}
#[cfg(not(any(windows, target_os = "macos")))]
pub fn foreground_app() -> Option<String> {
    None
}
#[cfg(not(any(windows, target_os = "macos")))]
pub fn unlocked() -> bool {
    false
}
#[cfg(not(any(windows, target_os = "macos")))]
pub fn idle_seconds() -> Option<f64> {
    None
}
