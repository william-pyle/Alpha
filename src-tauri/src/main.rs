#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{fs, io::{BufRead, BufReader, Write}, path::PathBuf, process::{Child, Command, Stdio}, sync::Mutex};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem}, tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState}};
use tauri_plugin_window_state::StateFlags;
mod external_links;
mod project_storage;
mod shared_drive;
mod window_chrome;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

struct Service(Mutex<Option<Child>>);
#[cfg(windows)]
struct ServiceJob(Mutex<Option<OwnedHandle>>);
#[cfg(windows)]
mod window_identity;
#[cfg(windows)]
mod win_key;
#[cfg(target_os = "macos")]
mod mac_key;

// The "recall Alpha" shortcut: a bare Win-key tap on Windows, ⌃⌥Space on macOS.
#[cfg(windows)]
type RecallShortcut = win_key::WinKeyShortcut;
#[cfg(target_os = "macos")]
type RecallShortcut = mac_key::RecallShortcut;
#[cfg(windows)]
const RECALL_LABEL: &str = "Win key";
#[cfg(target_os = "macos")]
const RECALL_LABEL: &str = mac_key::LABEL;

#[cfg(windows)]
fn process_job(child: &Child) -> Result<OwnedHandle, Box<dyn std::error::Error>> {
    use windows_sys::Win32::System::JobObjects::*;
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() { return Err(std::io::Error::last_os_error().into()); }
        let owned = OwnedHandle::from_raw_handle(job);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits as *const _ as *const _, std::mem::size_of_val(&limits) as u32) == 0
            || AssignProcessToJobObject(job, child.as_raw_handle()) == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(owned)
    }
}

fn hidden(command: &mut Command) -> &mut Command {
    #[cfg(windows)] command.creation_flags(0x08000000);
    command
}

#[cfg(windows)]
fn can_relaunch_after_update() -> bool {
    use windows_sys::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows_sys::Win32::System::{RemoteDesktop::ProcessIdToSessionId, Threading::{GetCurrentProcess, OpenProcessToken}};
    let mut session = 0;
    let mut token = std::ptr::null_mut();
    unsafe {
        if ProcessIdToSessionId(std::process::id(), &mut session) == 0 || session == 0
            || OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return false;
        }
        let token = OwnedHandle::from_raw_handle(token);
        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut size = 0;
        GetTokenInformation(token.as_raw_handle(), TokenElevation, (&mut elevation as *mut TOKEN_ELEVATION).cast(),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32, &mut size) != 0 && elevation.TokenIsElevated == 0
    }
}

#[cfg(windows)]
fn configure_cli_profile(command: &mut Command) {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::{System::Com::CoTaskMemFree, UI::Shell::{
        FOLDERID_LocalAppData, FOLDERID_RoamingAppData, KF_FLAG_DONT_VERIFY, SHGetKnownFolderPath,
    }};
    for (variable, folder) in [("ALPHA_WINDOWS_CLI_ROAMING", FOLDERID_RoamingAppData), ("ALPHA_WINDOWS_CLI_LOCAL", FOLDERID_LocalAppData)] {
        command.env_remove(variable);
        let mut value = std::ptr::null_mut();
        // Ask Windows for the current token's registered folder without creating it.
        unsafe {
            let result = SHGetKnownFolderPath(&folder, KF_FLAG_DONT_VERIFY as u32, std::ptr::null_mut(), &mut value);
            if result >= 0 && !value.is_null() {
                let mut len = 0;
                while *value.add(len) != 0 { len += 1; }
                let path = PathBuf::from(std::ffi::OsString::from_wide(std::slice::from_raw_parts(value, len)));
                if path.is_absolute() { command.env(variable, path); }
            }
            CoTaskMemFree(value.cast());
        }
    }
}

fn configuration_folder(app: &tauri::AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Some(root) = std::env::var_os("ALPHA_TEST_DIR") { return Ok(PathBuf::from(root)); }
    Ok(app.path().app_config_dir()?)
}

fn reveal(app: &tauri::AppHandle, label: &str) {
    let label = if label == "chats" { "workspace" } else { label };
    if let Some(window) = app.get_webview_window(label) {
        let _ = window_chrome::recover(&window); let _ = window.show(); let _ = window.unminimize(); let _ = window.set_focus();
    }
}

fn requested_window(args: &[String]) -> Option<&str> {
    args.windows(2).find_map(|pair| {
        if pair[0] == "--show" && matches!(pair[1].as_str(), "chats" | "workspace") { Some("workspace") } else { None }
    })
}

fn recall_open_windows(app: &tauri::AppHandle) {
    reveal(app, "workspace");
}

#[cfg(any(windows, target_os = "macos"))]
fn publish_shortcut(app: &tauri::AppHandle, request_id: Option<&str>, error: Option<String>) {
    let available = app.try_state::<RecallShortcut>().is_some();
    let enabled = app.try_state::<RecallShortcut>().is_some_and(|shortcut| shortcut.enabled());
    if let Some(item) = app.try_state::<CheckMenuItem<tauri::Wry>>() { let _ = item.set_checked(enabled); }
    let event = serde_json::json!({ "type": "native-settings", "requestId": request_id, "available": available, "winKey": enabled && available, "label": RECALL_LABEL, "error": error });
    if let Some(child) = app.state::<Service>().0.lock().unwrap().as_mut() {
        if let Some(stdin) = child.stdin.as_mut() { let _ = writeln!(stdin, "{event}"); }
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn set_shortcut(app: &tauri::AppHandle, enabled: bool, request_id: Option<&str>) {
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let shortcut = app.try_state::<RecallShortcut>().ok_or("Shortcut unavailable")?;
        let folder = configuration_folder(app)?;
        fs::create_dir_all(&folder)?;
        fs::write(folder.join("windows-key.json"), if enabled { "true" } else { "false" })?;
        #[cfg(windows)]
        shortcut.set_enabled(enabled);
        #[cfg(target_os = "macos")]
        shortcut.set_enabled(enabled)?;
        if let Some(item) = app.try_state::<CheckMenuItem<tauri::Wry>>() { item.set_checked(enabled)?; }
        Ok(())
    })();
    publish_shortcut(app, request_id, result.err().map(|error| error.to_string()));
}

#[cfg(any(windows, target_os = "macos"))]
fn start_file_drag(app: &tauri::AppHandle, paths: Vec<PathBuf>) {
    let Some(window) = app.get_webview_window("workspace") else { return };
    let _ = app.run_on_main_thread(move || {
        let callback_window = window.clone();
        let result = drag::start_drag(
            &window, drag::DragItem::Files(paths),
            drag::Image::Raw(include_bytes!("../icons/32x32.png").to_vec()),
            move |result, _| {
                let detail = serde_json::json!({ "dropped": matches!(result, drag::DragResult::Dropped) });
                let _ = callback_window.eval(format!("window.dispatchEvent(new CustomEvent('alpha-native-drag-result',{{detail:{detail}}}))"));
            }, drag::Options::default(),
        );
        if let Err(error) = result {
            let detail = serde_json::json!({ "dropped": false, "error": error.to_string() });
            let _ = window.eval(format!("window.dispatchEvent(new CustomEvent('alpha-native-drag-result',{{detail:{detail}}}))"));
        }
    });
}

fn repo_path(app: &tauri::AppHandle, node: &PathBuf, resolver: &PathBuf, app_dir: &PathBuf) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let mut supplied = args.iter().position(|v| v == "--repo").and_then(|i| args.get(i + 1)).map(PathBuf::from);
    let config = configuration_folder(app)?;
    let documents = app.path().document_dir().or_else(|_| app.path().home_dir().map(|root| root.join("Documents")))?;
    let default_root = documents.join("Alpha");
    let legacy = app.path().app_data_dir()?.join("Workspace");
    // The MSI uses the standard WiX setup wizard. Select the data folder on
    // first launch, outside the elevated installer, so it belongs to this user.
    if supplied.is_none() && node.is_file() && std::env::var_os("ALPHA_TEST_DIR").is_none()
        && !config.join("repository.json").exists() && !legacy.join("workspace.json").exists() && !legacy.join("workspace/workspace.json").exists() {
        let choice = rfd::MessageDialog::new().set_title("Choose Alpha Workspace")
            .set_description(format!("Use {} for your Workspace? Choose No to select another folder. Your files stay there across updates.", default_root.display()))
            .set_buttons(rfd::MessageButtons::YesNo).show();
        if choice == rfd::MessageDialogResult::No {
            supplied = Some(rfd::FileDialog::new().set_title("Choose an empty folder or existing Alpha Workspace")
                .set_directory(&documents).pick_folder().ok_or("Workspace selection cancelled")?);
        }
    }
    loop {
        let mut command = Command::new(node);
        command.arg(resolver).arg("--config").arg(&config).arg("--default").arg(&default_root)
            .arg("--legacy").arg(&legacy).arg("--app-dir").arg(app_dir);
        if let Some(ref root) = supplied { command.arg("--repo").arg(root); }
        let result = hidden(&mut command).output()?;
        if result.status.success() {
            let response: serde_json::Value = serde_json::from_slice(&result.stdout)?;
            let root = response["root"].as_str().ok_or("Workspace location was not returned")?;
            return Ok(normalize_node_path(PathBuf::from(root)));
        }
        let message = String::from_utf8_lossy(&result.stderr);
        let choice = rfd::MessageDialog::new().set_title("Alpha Workspace could not open")
            .set_description(format!("{message}\nYour original files have been kept. Choose OK to select another Workspace folder, or Cancel to quit."))
            .set_buttons(rfd::MessageButtons::OkCancel).show();
        if choice != rfd::MessageDialogResult::Ok { return Err("Workspace selection cancelled".into()); }
        supplied = rfd::FileDialog::new().set_title("Choose the Alpha Workspace root").pick_folder();
        if supplied.is_none() { return Err("Workspace selection cancelled".into()); }
    }
}

fn normalize_node_path(path: PathBuf) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = value.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path
}

mod desktop_context;

fn make_windows(app: &tauri::AppHandle, workspace: &str, _chats: &str) -> Result<(), Box<dyn std::error::Error>> {
    let (mut x, mut y, mut width, mut height) = (0.0, 0.0, 1440.0, 900.0);
    if let Some(monitor) = app.primary_monitor()? {
        let scale = monitor.scale_factor();
        let area = monitor.work_area();
        x = area.position.x as f64 / scale; y = area.position.y as f64 / scale;
        width = area.size.width as f64 / scale; height = area.size.height as f64 / scale;
    }
    let workspace_window = WebviewWindowBuilder::new(app, "workspace", WebviewUrl::External(workspace.parse()?))
        .on_new_window(|url, _| external_links::open_popup(url))
        .visible(false)
        .decorations(!cfg!(windows)).resizable(true)
        .title(app.config().product_name.as_deref().unwrap_or("Alpha")).inner_size((width - 6.0).max(750.0), (height - 6.0).max(500.0))
        .position(x + 2.0, y + 2.0).min_inner_size(700.0, 500.0)
        .theme(Some(tauri::Theme::Dark)).background_color(tauri::webview::Color(12, 13, 16, 255)).build()?;
    // Native drops expose original file and folder paths to the embedded Chats pane.
    let drop_window = workspace_window.clone();
    workspace_window.on_window_event(move |event| {
        if let tauri::WindowEvent::DragDrop(event) = event {
            let scale = drop_window.scale_factor().unwrap_or(1.0);
            let detail = match event {
                tauri::DragDropEvent::Enter { paths, position } => serde_json::json!({ "phase": "enter", "paths": paths, "x": position.x / scale, "y": position.y / scale }),
                tauri::DragDropEvent::Over { position } => serde_json::json!({ "phase": "over", "x": position.x / scale, "y": position.y / scale }),
                tauri::DragDropEvent::Drop { paths, position } => serde_json::json!({ "phase": "drop", "paths": paths, "x": position.x / scale, "y": position.y / scale }),
                tauri::DragDropEvent::Leave => serde_json::json!({ "phase": "leave" }),
                _ => return,
            };
            let _ = drop_window.eval(format!("window.dispatchEvent(new CustomEvent('alpha-file-drop',{{detail:{detail}}}))"));
        }
    });
    #[cfg(windows)]
    window_identity::set_window(&workspace_window)?;
    let handle = workspace_window.clone();
    workspace_window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close(); let _ = handle.hide();
        }
    });
    let chrome_window = workspace_window.clone();
    let chrome_app = app.clone();
    workspace_window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(_) | tauri::WindowEvent::ScaleFactorChanged { .. }) { window_chrome::publish(&chrome_app, &chrome_window, None); }
    });
    window_chrome::recover(&workspace_window)?;
    workspace_window.show()?;
    window_chrome::publish(app, &workspace_window, None);
    #[cfg(debug_assertions)]
    window_chrome::self_test(app);
    #[cfg(windows)]
    window_identity::refresh_shortcuts(app);
    Ok(())
}

#[cfg(unix)]
mod login_path;

#[cfg(target_os = "macos")]
fn recall_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri_plugin_global_shortcut::ShortcutState;
    tauri_plugin_global_shortcut::Builder::new().with_handler(|app, _, event| {
        if event.state() == ShortcutState::Pressed { recall_all_windows(app); }
    }).build()
}

// Windows and Linux have nothing to register here; keep the builder chain uniform.
#[cfg(not(target_os = "macos"))]
fn recall_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> { tauri::plugin::Builder::new("alpha-recall").build() }

// macOS: the recall shortcut and a Dock-icon click bring back both windows,
// since closing a window there only hides it.
#[cfg(target_os = "macos")]
fn recall_all_windows(app: &tauri::AppHandle) {
    recall_open_windows(app);
}

// macOS: the web view never receives Cmd+1…9 (the native window consumes them
// before the page), so chat switching lives in a Chats menu, as in other Mac
// apps. Selecting an item shows Chats and asks the page to open that tab.
#[cfg(target_os = "macos")]
fn install_chats_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::Submenu;
    let menu = Menu::default(app)?;
    let items = (1..=9).map(|n| MenuItem::with_id(app, format!("chat-{n}"), format!("Chat {n}"), true, Some(format!("CmdOrCtrl+{n}"))))
        .collect::<tauri::Result<Vec<_>>>()?;
    let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = items.iter().map(|item| item as &dyn tauri::menu::IsMenuItem<tauri::Wry>).collect();
    menu.append(&Submenu::with_items(app, "Chats", true, &refs)?)?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        let Some(index) = event.id.as_ref().strip_prefix("chat-").and_then(|n| n.parse::<u8>().ok()) else { return };
        reveal(app, "workspace");
        if let Some(window) = app.get_webview_window("workspace") {
            let _ = window.eval(format!("window.dispatchEvent(new CustomEvent('alpha-select-chat',{{detail:{{index:{index}}}}}))"));
        }
    });
    Ok(())
}

fn main() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if args.iter().any(|arg| arg == "--quit") { app.exit(0); }
            else if let Some(label) = requested_window(&args) { reveal(app, label); }
            else { reveal(app, "workspace"); }
        }))
        .plugin(recall_plugin())
        .plugin(tauri_plugin_window_state::Builder::default().with_filename(std::env::var_os("ALPHA_TEST_DIR").map(|root| PathBuf::from(root).join("window-state.json").to_string_lossy().into_owned()).unwrap_or_else(|| ".window-state.json".to_owned())).with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED).build())
        .manage(Service(Mutex::new(None)))
        .setup(|app| {
            if std::env::args().any(|arg| arg == "--quit") { app.handle().exit(0); return Ok(()); }
            #[cfg(windows)]
            window_identity::initialize(app.handle())?;
            let resource_dir = app.path().resource_dir()?;
            let runtime = resource_dir.join("runtime");
            let runtime_node = if cfg!(windows) { runtime.join("node.exe") } else { runtime.join("node") };
            let (node, script, ui) = if runtime_node.is_file() {
                (runtime_node, runtime.join("service/main.mjs"), runtime.join("ui"))
            } else {
                (PathBuf::from("node"), PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../desktop/service/main.mjs"), PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist"))
            };
            let script = normalize_node_path(script);
            let repo = repo_path(app.handle(), &node, &script.with_file_name("workspace-location.mjs"), &resource_dir)?;
            let logs = app.path().app_log_dir()?; fs::create_dir_all(&logs)?;
            let log = fs::OpenOptions::new().create(true).append(true).open(logs.join("service.log"))?;
            let mut command = Command::new(node);
            let library_root = if let Some(root) = std::env::var_os("ALPHA_TEST_DIR") { PathBuf::from(root).join("SharedLibrary") } else { app.path().app_data_dir()?.join("SharedLibrary") };
            command.arg(script).arg("--repo").arg(&repo).arg("--ui").arg(ui).current_dir(&repo)
                .arg("--library-root").arg(library_root)
                .arg("--config").arg(configuration_folder(app.handle())?).arg("--app-dir").arg(&resource_dir)
                .env("ALPHA_PARENT_PID", std::process::id().to_string())
                .env("ALPHA_APP_VERSION", app.package_info().version.to_string())
                .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::from(log));
            #[cfg(windows)]
            configure_cli_profile(&mut command);
            #[cfg(target_os = "macos")]
            command.env("PATH", login_path::discover());
            let mut child = hidden(&mut command).spawn()?;
            // The job contains only this app's service and descendants. Quitting
            // or a host crash cannot leave managed CLI/MCP processes behind.
            #[cfg(windows)]
            app.manage(ServiceJob(Mutex::new(Some(process_job(&child)?))));
            let stdout = child.stdout.take().ok_or("Service output unavailable")?;
            *app.state::<Service>().0.lock().unwrap() = Some(child);
            let app_handle = app.handle().clone();
            #[cfg(windows)]
            let update_script = runtime.join("install-msi-update.ps1");
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                    match event["type"].as_str().unwrap_or("") {
                        "update-install" => {
                            let handle = app_handle.clone();
                            let file = event["file"].as_str().unwrap_or("").to_owned();
                            let sha256 = event["sha256"].as_str().unwrap_or("").to_owned();
                            let version = event["version"].as_str().unwrap_or("").to_owned();
                            let count = event["activeCount"].as_u64().unwrap_or(0);
                            #[cfg(windows)]
                            let script = update_script.clone();
                            let _ = app_handle.run_on_main_thread(move || {
                                #[cfg(windows)]
                                if !can_relaunch_after_update() {
                                    rfd::MessageDialog::new().set_title("Alpha update could not start")
                                        .set_description("Open Alpha normally from the signed-in Windows account to install the update.").show();
                                    return;
                                }
                                let confirmed = rfd::MessageDialog::new().set_title("Update Alpha")
                                    .set_description(format!("Install Alpha {version}? This closes Alpha and stops {count} running terminal(s). Saved workspace files and history are retained."))
                                    .set_buttons(rfd::MessageButtons::YesNo).show();
                                if confirmed == rfd::MessageDialogResult::Yes {
                                    #[cfg(windows)]
                                    let launched = hidden(Command::new("powershell.exe")
                                        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
                                        .arg(script).arg("-Installer").arg(&file).arg("-Sha256").arg(&sha256)
                                        .arg("-ParentPid").arg(std::process::id().to_string())).spawn();
                                    #[cfg(not(windows))]
                                    let launched = Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "Windows MSI updates only"));
                                    match launched {
                                        Ok(_) => handle.exit(0),
                                        Err(error) => { rfd::MessageDialog::new().set_title("Alpha update could not start").set_description(error.to_string()).show(); }
                                    }
                                }
                            });
                        },
                        #[cfg(any(windows, target_os = "macos"))]
                        "native-settings" => {
                            if let Some(enabled) = event["winKey"].as_bool() {
                                let handle = app_handle.clone();
                                let request_id = event["requestId"].as_str().map(str::to_owned);
                                let _ = app_handle.run_on_main_thread(move || set_shortcut(&handle, enabled, request_id.as_deref()));
                            }
                        },
                        "desktop-context" => {
                            let reply = serde_json::json!({ "type": "desktop-context", "application": desktop_context::foreground_application() });
                            if let Some(child) = app_handle.state::<Service>().0.lock().unwrap().as_mut() {
                                if let Some(stdin) = child.stdin.as_mut() { let _ = writeln!(stdin, "{reply}"); }
                            }
                        },
                        "project-storage-capabilities" => {
                            let reply = serde_json::json!({
                                "type": "project-storage-capabilities",
                                "requestId": event.get("requestId").cloned().unwrap_or(serde_json::Value::Null),
                                "available": project_storage::available(),
                            });
                            if let Some(child) = app_handle.state::<Service>().0.lock().unwrap().as_mut() {
                                if let Some(stdin) = child.stdin.as_mut() { let _ = writeln!(stdin, "{reply}"); }
                            }
                        },
                        "project-storage" => {
                            let handle = app_handle.clone();
                            let request_id = event.get("requestId").cloned().unwrap_or(serde_json::Value::Null);
                            let path = event.get("path").and_then(serde_json::Value::as_str).map(str::to_owned);
                            std::thread::spawn(move || {
                                let reply = project_storage::response(request_id, path.as_deref());
                                if let Some(child) = handle.state::<Service>().0.lock().unwrap().as_mut() {
                                    if let Some(stdin) = child.stdin.as_mut() { let _ = writeln!(stdin, "{reply}"); }
                                }
                            });
                        },
                        "shared-drive-original" => {
                            let handle = app_handle.clone();
                            let workspace = repo.clone();
                            std::thread::spawn(move || {
                                let reply = shared_drive::response(event, &workspace);
                                if let Some(child) = handle.state::<Service>().0.lock().unwrap().as_mut() {
                                    if let Some(stdin) = child.stdin.as_mut() { let _ = writeln!(stdin, "{reply}"); }
                                }
                            });
                        },
                        "ready" => {
                            let handle = app_handle.clone();
                            let workspace = event["workspace"].as_str().unwrap_or("").to_owned();
                            let chats = event["chats"].as_str().unwrap_or("").to_owned();
                            let _ = app_handle.run_on_main_thread(move || {
                                if let Err(error) = make_windows(&handle, &workspace, &chats) {
                                    rfd::MessageDialog::new().set_title("Alpha could not open").set_description(error.to_string()).show(); handle.exit(1);
                                }
                            });
                        },
                        "window" => {
                            let label = event["window"].as_str().unwrap_or("");
                            if let Some(window) = app_handle.get_webview_window(if label == "chats" { "workspace" } else { label }) {
                                match event["action"].as_str().unwrap_or("") {
                                    "show" => reveal(&app_handle, label),
                                    "drag" | "toggle-maximize" | "close" | "system-menu" | "state" => window_chrome::command(&app_handle, window.clone(), event["action"].as_str().unwrap_or("").to_owned()),
                                    "hide" => { let _ = window.hide(); },
                                    "minimize" => { let _ = window.minimize(); },
                                    "pin" => { let _ = window.set_always_on_top(event["value"].as_bool().unwrap_or(false)); },
                                    _ => {}
                                }
                            }
                        },
                        "recycle-file" => {
                            if let Some(file) = event["path"].as_str() {
                                if let Some(window) = app_handle.get_webview_window("workspace") {
                                    let file = file.to_owned();
                                    std::thread::spawn(move || {
                                        let detail = match trash::delete(&file) {
                                            Ok(()) => serde_json::json!({ "path": file, "recycled": true }),
                                            Err(error) => serde_json::json!({ "path": file, "recycled": false, "error": error.to_string() }),
                                        };
                                        let _ = window.eval(format!("window.dispatchEvent(new CustomEvent('alpha-recycle-result',{{detail:{detail}}}))"));
                                    });
                                }
                            }
                        },
                        #[cfg(any(windows, target_os = "macos"))]
                        "drag-files" => {
                            if let Some(paths) = event["paths"].as_array() {
                                let paths: Vec<PathBuf> = paths.iter().filter_map(|p| p.as_str().map(PathBuf::from)).collect();
                                if !paths.is_empty() { start_file_drag(&app_handle, paths); }
                            }
                        },
                        "pick-workspace-folder" => {
                            let handle = app_handle.clone();
                            let request_id = event["requestId"].as_str().unwrap_or("").to_owned();
                            let start = event["path"].as_str().unwrap_or("").to_owned();
                            std::thread::spawn(move || {
                                let mut dialog = rfd::FileDialog::new().set_title("Choose the Alpha Workspace root").set_directory(start);
                                if let Some(window) = handle.get_webview_window("workspace") { dialog = dialog.set_parent(&window); }
                                let selected = dialog.pick_folder();
                                let reply = serde_json::json!({ "type": "workspace-folder-picked", "requestId": request_id, "path": selected });
                                if let Some(child) = handle.state::<Service>().0.lock().unwrap().as_mut() {
                                    if let Some(stdin) = child.stdin.as_mut() { let _ = writeln!(stdin, "{reply}"); }
                                }
                            });
                        },
                        "pick-files" => {
                            if let (Some(window), Some(request_id)) = (app_handle.get_webview_window("workspace"), event["requestId"].as_str()) {
                                let request_id = request_id.to_owned();
                                std::thread::spawn(move || {
                                    let paths = rfd::FileDialog::new().set_parent(&window).set_title("Attach file paths").pick_files().unwrap_or_default();
                                    let detail = serde_json::json!({ "requestId": request_id, "paths": paths });
                                    let _ = window.eval(format!("window.dispatchEvent(new CustomEvent('alpha-picked-files',{{detail:{detail}}}))"));
                                });
                            }
                        },
                        "reveal" => { if let Some(file) = event["path"].as_str() { let _ = external_links::reveal_path(file); } },
                        "open-target" => { if let (Some(kind), Some(target)) = (event["kind"].as_str(), event["target"].as_str()) { let _ = external_links::open_target(kind, target); } },
                        _ => {}
                    }
                }
                if app_handle.get_webview_window("workspace").is_none() {
                    rfd::MessageDialog::new().set_title("Alpha service did not start").set_description("The local service stopped before opening the windows. See the Alpha service.log in your local application data.").show();
                    app_handle.exit(1);
                }
            });
            #[cfg(target_os = "macos")]
            install_chats_menu(app.handle())?;
            let workspace_item = MenuItem::with_id(app, "workspace", "Show Alpha", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit Alpha and stop terminals", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&workspace_item, &separator, &quit_item])?;
            #[cfg(any(windows, target_os = "macos"))]
            {
                let preference = configuration_folder(app.handle())?.join("windows-key.json");
                let enabled = fs::read_to_string(&preference).ok().and_then(|text| serde_json::from_str::<bool>(&text).ok()).unwrap_or(false);
                let shortcut = RecallShortcut::start(app.handle(), enabled);
                let available = shortcut.is_ok();
                if let Ok(shortcut) = shortcut { app.manage(shortcut); }
                let item = CheckMenuItem::with_id(app, "win-key", format!("{RECALL_LABEL} shows Alpha"), available, enabled && available, None::<&str>)?;
                menu.insert(&item, 1)?;
                app.manage(item);
                publish_shortcut(app.handle(), None, if available { None } else { Some(format!("The system could not register {RECALL_LABEL}.")) });
            }
            TrayIconBuilder::new().icon(app.default_window_icon().unwrap().clone()).tooltip("Alpha — your agents, close at hand")
                .menu(&menu).show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "workspace" => reveal(app, "workspace"), "quit" => app.exit(0),
                    #[cfg(any(windows, target_os = "macos"))]
                    "win-key" => {
                        if let Some(item) = app.try_state::<CheckMenuItem<tauri::Wry>>() {
                            if let Ok(enabled) = item.is_checked() {
                                set_shortcut(app, enabled, None);
                            }
                        }
                    },
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| { if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event { reveal(tray.app_handle(), "workspace"); } })
                .build(app)?;
            Ok(())
        }).build(tauri::generate_context!());
    match result {
        Ok(app) => app.run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { has_visible_windows: false, .. } = event { recall_all_windows(app); }
            if let tauri::RunEvent::Exit = event {
                #[cfg(windows)]
                if let Some(shortcut) = app.try_state::<win_key::WinKeyShortcut>() { shortcut.shutdown(); }
                if let Some(mut child) = app.state::<Service>().0.lock().unwrap().take() {
                    if let Some(mut stdin) = child.stdin.take() { let _ = stdin.write_all(b"quit\n"); }
                    for _ in 0..80 { if child.try_wait().ok().flatten().is_some() { break; } std::thread::sleep(std::time::Duration::from_millis(100)); }
                    let _ = child.kill(); let _ = child.wait();
                }
                #[cfg(windows)]
                if let Some(job) = app.try_state::<ServiceJob>() { job.0.lock().unwrap().take(); }
            }
        }),
        Err(error) => { rfd::MessageDialog::new().set_title("Alpha could not start").set_description(error.to_string()).show(); }
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_node_path;
    use std::path::PathBuf;

    #[test]
    fn normalize_node_path_removes_windows_extended_prefixes() {
        assert_eq!(normalize_node_path(PathBuf::from(r"\\?\C:\Alpha\service\main.mjs")), PathBuf::from(r"C:\Alpha\service\main.mjs"));
        assert_eq!(normalize_node_path(PathBuf::from(r"\\?\UNC\server\share\service\main.mjs")), PathBuf::from(r"\\server\share\service\main.mjs"));
        assert_eq!(normalize_node_path(PathBuf::from(r"C:\Alpha\service\main.mjs")), PathBuf::from(r"C:\Alpha\service\main.mjs"));
    }
}
