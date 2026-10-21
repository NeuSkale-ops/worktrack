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
pub use win::{idle_seconds, unlocked};
#[cfg(not(windows))]
pub fn unlocked() -> bool {
    false
}
#[cfg(not(windows))]
pub fn idle_seconds() -> Option<f64> {
    None
}
