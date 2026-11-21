//! Alpha's own commands over Tauri's native window. Tao retains Win32 sizing
//! styles and DPI-aware edge hit tests while suppressing the non-client caption.
use std::io::Write;
use tauri::Manager;

pub fn publish(app: &tauri::AppHandle, window: &tauri::WebviewWindow, error: Option<String>) {
    let event = serde_json::json!({"type":"window-state", "nativeWindow": {
        "available": cfg!(windows), "maximized": window.is_maximized().unwrap_or(false),
        "minimized": window.is_minimized().unwrap_or(false),
        "focused": window.is_focused().unwrap_or(false), "error": error
    }});
    if let Ok(mut service) = app.state::<super::Service>().0.lock() {
        if let Some(stdin) = service.as_mut().and_then(|child| child.stdin.as_mut()) {
            let _ = writeln!(stdin, "{event}");
        }
    }
}

fn title_is_reachable(position: (i32, i32), size: (u32, u32), areas: &[(i32, i32, u32, u32)]) -> bool {
    let (x, y) = (i64::from(position.0), i64::from(position.1));
    areas.iter().any(|&(ax, ay, aw, ah)| {
        let (ax, ay) = (i64::from(ax), i64::from(ay));
        (x + i64::from(size.0)).min(ax + i64::from(aw)) - x.max(ax) >= 80
            && (y + 32).min(ay + i64::from(ah)) - y.max(ay) >= 24
    })
}

pub fn recover(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    if window.is_maximized()? { return Ok(()); }
    let position = window.outer_position()?;
    let size = window.outer_size()?;
    let inner = window.inner_size()?;
    let monitors = window.available_monitors()?;
    let areas: Vec<_> = monitors.iter().map(|monitor| { let area = monitor.work_area(); (area.position.x, area.position.y, area.size.width, area.size.height) }).collect();
    if !title_is_reachable((position.x, position.y), (size.width, size.height), &areas) {
        if let Some(monitor) = window.primary_monitor()? {
            let area = monitor.work_area();
            window.set_position(tauri::PhysicalPosition::new(area.position.x + 16, area.position.y + 16))?;
            let border_width = size.width.saturating_sub(inner.width);
            let border_height = size.height.saturating_sub(inner.height);
            window.set_size(tauri::PhysicalSize::new(inner.width.min(area.size.width.saturating_sub(32 + border_width)), inner.height.min(area.size.height.saturating_sub(32 + border_height))))?;
        }
    }
    Ok(())
}

#[cfg(windows)]
fn system_menu(window: &tauri::WebviewWindow) -> Result<(), String> {
    use windows_sys::Win32::{Foundation::RECT, UI::WindowsAndMessaging::*};
    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as _;
    // The handle belongs to this window on its event-loop thread. The system
    // owns the menu; dispatch its result through the usual close/resize path.
    unsafe {
        let menu = GetSystemMenu(hwnd, 0);
        if menu.is_null() { return Err("Windows system menu is unavailable".into()); }
        let maximized = IsZoomed(hwnd) != 0;
        for (command, enabled) in [(SC_RESTORE, maximized), (SC_MAXIMIZE, !maximized), (SC_SIZE, !maximized), (SC_MOVE, !maximized)] {
            EnableMenuItem(menu, command, MF_BYCOMMAND | if enabled { MF_ENABLED } else { MF_GRAYED });
        }
        let mut rect: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut rect) == 0 { return Err(std::io::Error::last_os_error().to_string()); }
        let command = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON, rect.left + 8, rect.top + 36, 0, hwnd, std::ptr::null());
        if command != 0 { PostMessageW(hwnd, WM_SYSCOMMAND, command as usize, 0); }
    }
    Ok(())
}

pub fn command(app: &tauri::AppHandle, window: tauri::WebviewWindow, action: String) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let result: Result<(), String> = (|| {
            match action.as_str() {
                "drag" => window.start_dragging(),
                "toggle-maximize" => if window.is_maximized().map_err(|e| e.to_string())? { window.unmaximize() } else { window.maximize() },
                "close" => window.close(), // CloseRequested still hides; workers stay alive.
                "state" => Ok(()),
                #[cfg(windows)]
                "system-menu" => return system_menu(&window),
                _ => return Err("Unknown native window command".into()),
            }.map_err(|error| error.to_string())
        })();
        publish(&handle, &window, result.err());
    });
}

#[cfg(test)]
mod tests {
    use super::title_is_reachable;
    #[test]
    fn physical_monitor_geometry_keeps_negative_coordinates_and_recovers_lost_captions() {
        let areas = [(-1920, 0, 1920, 1040), (0, 0, 2560, 1400)];
        assert!(title_is_reachable((-1800, 30), (900, 600), &areas));
        assert!(title_is_reachable((2400, 20), (900, 600), &areas));
        assert!(!title_is_reachable((3000, 20), (900, 600), &areas));
        assert!(!title_is_reachable((20, -800), (900, 1000), &areas));
        assert!(!title_is_reachable((20, 1390), (900, 600), &areas));
    }
}

// Native integration checks are compiled into development builds only and run
// only in an explicitly isolated fixture. They exercise our own window API;
// pointer hit-testing and screenshots still need interactive verification.
#[cfg(debug_assertions)]
pub fn self_test(app: &tauri::AppHandle) {
    if std::env::var("ALPHA_NATIVE_WINDOW_TEST").as_deref() != Ok("1") { return; }
    let Some(root) = std::env::var_os("ALPHA_TEST_DIR") else { return; };
    if app.config().identifier == "com.jazcosolutions.alpha" { return; }
    let app = app.clone();
    std::thread::spawn(move || {
        use std::{sync::mpsc, time::Duration};
        let mut evidence = Vec::new();
        for action in ["initial", "resize", "maximize", "restore", "minimize", "show", "offscreen", "close", "show"] {
            let (tx, rx) = mpsc::channel();
            let handle = app.clone();
            let scheduled = app.run_on_main_thread(move || {
                let result = (|| -> Result<(), String> {
                    let window = handle.get_webview_window("workspace").ok_or("Missing isolated window")?;
                    match action {
                        "resize" => window.set_size(tauri::LogicalSize::new(960.0, 640.0)),
                        "maximize" => window.maximize(),
                        "restore" => window.unmaximize(),
                        "minimize" => window.minimize(),
                        "show" => { window.show().map_err(|e| e.to_string())?; window.unminimize() },
                        "offscreen" => { window.set_position(tauri::PhysicalPosition::new(50000, 50000)).map_err(|e| e.to_string())?; recover(&window) },
                        "close" => window.close(),
                        _ => Ok(()),
                    }.map_err(|e| e.to_string())
                })();
                let _ = tx.send(result);
            });
            if scheduled.is_err() || !matches!(rx.recv_timeout(Duration::from_secs(3)), Ok(Ok(()))) {
                evidence.push(serde_json::json!({"action":action,"passed":false,"error":"Native command did not complete"})); break;
            }
            std::thread::sleep(Duration::from_millis(350));
            let Some(window) = app.get_webview_window("workspace") else { break; };
            let position = window.outer_position().ok(); let size = window.outer_size().ok();
            let inner_position = window.inner_position().ok(); let inner_size = window.inner_size().ok();
            let maximized = window.is_maximized().unwrap_or(false);
            let minimized = window.is_minimized().unwrap_or(false);
            let visible = window.is_visible().unwrap_or(false);
            let decorated = window.is_decorated().unwrap_or(true);
            let reachable = match (position, size, window.available_monitors()) {
                (Some(p), Some(s), Ok(monitors)) => title_is_reachable((p.x,p.y),(s.width,s.height), &monitors.iter().map(|m| { let a=m.work_area(); (a.position.x,a.position.y,a.size.width,a.size.height) }).collect::<Vec<_>>()),
                _ => false,
            };
            let worker_service_alive = app.state::<super::Service>().0.lock().ok().and_then(|mut service| service.as_mut().map(|child| matches!(child.try_wait(), Ok(None)))).unwrap_or(false);
            let work_area = window.current_monitor().ok().flatten().map(|m|m.work_area().clone());
            let fits_work_area = match (inner_position, inner_size, work_area.as_ref()) { (Some(p),Some(s),Some(a)) => p.x >= a.position.x && p.y >= a.position.y && i64::from(p.x)+i64::from(s.width) <= i64::from(a.position.x)+i64::from(a.size.width) && i64::from(p.y)+i64::from(s.height) <= i64::from(a.position.y)+i64::from(a.size.height), _ => false };
            let passed = worker_service_alive && match action { "initial" => !decorated && visible, "resize" => size.is_some_and(|s| s.width >= 960 && s.height >= 640), "maximize" => maximized && fits_work_area, "restore" => !maximized, "minimize" => minimized, "show" => visible && !minimized, "offscreen" => reachable && fits_work_area, "close" => !visible, _ => false };
            evidence.push(serde_json::json!({"action":action,"passed":passed,"decorated":decorated,"maximized":maximized,"minimized":minimized,"visible":visible,"position":position,"outerSize":size,"innerPosition":inner_position,"innerSize":inner_size,"fitsWorkArea":fits_work_area,"captionReachable":reachable,"serviceAlive":worker_service_alive,"scaleFactor":window.scale_factor().ok(),"workArea":work_area}));
        }
        let passed = evidence.len() == 9 && evidence.iter().all(|item|item["passed"] == true);
        let result = serde_json::json!({"passed":passed,"source":"Isolated development Tauri window on Windows","checks":evidence,"unverified":["physical pointer drag and edge/corner hit tests","Windows snap shortcuts","taskbar click restore","physical DPI and multi-monitor transitions","visual frame screenshot"]});
        let _ = std::fs::write(std::path::PathBuf::from(root).join("native-self-test.json"), serde_json::to_vec_pretty(&result).unwrap());
    });
}
