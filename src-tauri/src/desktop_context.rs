// Deliberately exclude window titles, full paths, screen contents and input.
#[cfg(windows)]
pub fn foreground_application() -> Option<String> {
    use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION}, UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId}};
    unsafe {
        let window = GetForegroundWindow();
        if window.is_null() { return None; }
        let mut pid = 0;
        GetWindowThreadProcessId(window, &mut pid);
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() { return None; }
        let mut buffer = vec![0u16; 32768];
        let mut length = buffer.len() as u32;
        let success = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length);
        CloseHandle(process);
        if success == 0 { return None; }
        let full = String::from_utf16_lossy(&buffer[..length as usize]);
        std::path::Path::new(&full).file_name().and_then(|value| value.to_str()).map(str::to_owned)
    }
}

#[cfg(not(windows))]
pub fn foreground_application() -> Option<String> { None }

#[cfg(test)]
mod tests {
    #[test]
    fn current_context_contains_no_title_or_path() {
        if let Some(name) = super::foreground_application() {
            assert!(!name.contains(['/', '\\', ':']));
            assert!(name.to_lowercase().ends_with(".exe"));
        }
    }
}
