//! A small, non-activating control that follows a foreground Windows window.
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetSnapshot {
    pub enabled: bool,
    pub status: String,
    pub elapsed: u32,
    pub blocked: bool,
    pub pending: bool,
    pub message: Option<String>,
}

#[derive(Default)]
pub struct AttachmentState {
    snapshot: Mutex<WidgetSnapshot>,
    #[cfg(target_os = "windows")]
    target: Mutex<Option<(isize, u32)>>,
}

#[tauri::command]
pub fn voice_widget_snapshot(state: State<'_, AttachmentState>) -> Result<WidgetSnapshot, String> {
    Ok(state.snapshot.lock().map_err(|e| e.to_string())?.clone())
}

#[tauri::command]
pub fn update_voice_widget(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AttachmentState>,
    snapshot: WidgetSnapshot,
) -> Result<(), String> {
    if window.label() != "overlay" {
        return Err("Состоянием записи управляет главное окно.".into());
    }
    *state.snapshot.lock().map_err(|e| e.to_string())? = snapshot.clone();
    app.emit_to("voice-widget", "voice-widget-state", snapshot)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn attach_voice_window(state: State<'_, AttachmentState>) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let target = crate::native_input::windows::capture()?;
        *state.target.lock().map_err(|e| e.to_string())? = Some((target.window, target.process));
        Ok(target.title)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = state;
        Err("Привязка кнопки к окну пока доступна на Windows.".into())
    }
}

#[tauri::command]
pub fn toggle_voice_widget(
    app: AppHandle,
    state: State<'_, AttachmentState>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let snapshot = state.snapshot.lock().map_err(|e| e.to_string())?.clone();
        if !snapshot.enabled || snapshot.blocked {
            return Ok(());
        }
        // Re-capture on the click: never paste into a stale focus from the tracker.
        let target = crate::native_input::windows::capture()?;
        if *state.target.lock().map_err(|e| e.to_string())? != Some((target.window, target.process))
        {
            return Err("Выберите привязанное окно OpenCode.".into());
        }
        app.emit_to("overlay", "voice-hotkey", Some(target))
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, state);
        Err("Привязка кнопки к окну пока доступна на Windows.".into())
    }
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    app.manage(AttachmentState::default());
    #[cfg(target_os = "windows")]
    {
        let widget = tauri::WebviewWindowBuilder::new(
            app,
            "voice-widget",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("Микрофон OpenCode")
        .inner_size(204.0, 76.0)
        .decorations(false)
        .resizable(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .visible(false)
        .build()?;
        windows::prepare(&widget)?;
        let app = app.clone();
        std::thread::spawn(move || windows::track(app, widget));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
mod windows {
    use super::*;
    use std::{ffi::c_void, time::Duration};

    #[repr(C)]
    #[derive(Default)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetWindowRect(window: *mut c_void, rect: *mut Rect) -> i32;
        fn IsIconic(window: *mut c_void) -> i32;
        fn IsWindow(window: *mut c_void) -> i32;
        fn GetWindowThreadProcessId(window: *mut c_void, process: *mut u32) -> u32;
        fn GetDpiForWindow(window: *mut c_void) -> u32;
        fn ShowWindowAsync(window: *mut c_void, command: i32) -> i32;
        fn GetWindowLongPtrW(window: *mut c_void, index: i32) -> isize;
        fn SetWindowLongPtrW(window: *mut c_void, index: i32, value: isize) -> isize;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, process: u32) -> *mut c_void;
        fn QueryFullProcessImageNameW(
            process: *mut c_void,
            flags: u32,
            name: *mut u16,
            size: *mut u32,
        ) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    pub fn prepare(widget: &WebviewWindow) -> tauri::Result<()> {
        let hwnd = widget.hwnd()?.0 as *mut c_void;
        unsafe {
            // Native non-activating shows bypass Tao's ITaskbarList::DeleteTab.
            // TOOLWINDOW also keeps this small control out of Alt+Tab.
            let style = GetWindowLongPtrW(hwnd, -20);
            if SetWindowLongPtrW(hwnd, -20, (style & !0x00040000) | 0x00000080 | 0x08000000) == 0 {
                return Err(tauri::Error::Io(std::io::Error::last_os_error()));
            }
        }
        Ok(())
    }

    fn process_name(process: u32) -> Option<String> {
        unsafe {
            let handle = OpenProcess(0x1000, 0, process); // PROCESS_QUERY_LIMITED_INFORMATION
            if handle.is_null() {
                return None;
            }
            let mut buffer = [0u16; 32768];
            let mut size = buffer.len() as u32;
            let ok = QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size);
            CloseHandle(handle);
            if ok == 0 {
                return None;
            }
            let path = String::from_utf16_lossy(&buffer[..size as usize]);
            Some(path.rsplit('\\').next()?.to_ascii_lowercase())
        }
    }

    fn is_opencode(process: &str, title: &str) -> bool {
        if matches!(process, "opencode.exe" | "opencode-desktop.exe") {
            return true;
        }
        matches!(
            process,
            "windowsterminal.exe"
                | "conhost.exe"
                | "wezterm-gui.exe"
                | "alacritty.exe"
                | "mintty.exe"
                | "msrdc.exe" // WSLg GUI windows exported to the Windows desktop.
        ) && title
            .to_ascii_lowercase()
            .split(|c: char| !c.is_alphanumeric() && c != '-' && c != '_')
            .any(|word| word == "opencode")
    }

    pub fn track(app: AppHandle, widget: WebviewWindow) {
        let Ok(hwnd) = widget.hwnd() else {
            return;
        };
        let widget_hwnd = hwnd.0 as *mut c_void;
        let mut shown = false;
        let mut last_position = None;
        let mut last_process: Option<(u32, String)> = None;
        loop {
            std::thread::sleep(Duration::from_millis(150));
            if app.get_webview_window("overlay").is_none() {
                break;
            }
            let state = app.state::<AttachmentState>();
            let enabled = state.snapshot.lock().map(|s| s.enabled).unwrap_or(false);
            let position = enabled
                .then(|| crate::native_input::windows::capture().ok())
                .flatten()
                .and_then(|target| {
                    let mut bound = state.target.lock().ok()?;
                    if bound.is_none() {
                        let process = if let Some((pid, name)) = &last_process {
                            if *pid == target.process {
                                name.clone()
                            } else {
                                process_name(target.process)?
                            }
                        } else {
                            process_name(target.process)?
                        };
                        last_process = Some((target.process, process.clone()));
                        if is_opencode(&process, &target.title) {
                            *bound = Some((target.window, target.process));
                        }
                    }
                    if *bound != Some((target.window, target.process)) {
                        // A closed window's handle can be reused; also validate its process on each capture.
                        if bound.is_some_and(|(window, process)| unsafe {
                            let mut actual_process = 0;
                            IsWindow(window as *mut c_void) == 0
                                || GetWindowThreadProcessId(
                                    window as *mut c_void,
                                    &mut actual_process,
                                ) == 0
                                || actual_process != process
                        }) {
                            *bound = None;
                        }
                        return None;
                    }
                    // Window queries synchronously reach the UI thread. Never hold
                    // a mutex that a command on that thread could also acquire.
                    drop(bound);
                    let hwnd = target.window as *mut c_void;
                    let mut rect = Rect::default();
                    if unsafe { IsIconic(hwnd) != 0 || GetWindowRect(hwnd, &mut rect) == 0 } {
                        return None;
                    }
                    let scale = unsafe { GetDpiForWindow(hwnd).max(96) } as f64 / 96.0;
                    // The widget uses its actual physical size when crossing monitors with different DPI.
                    let size = widget.outer_size().ok()?;
                    if rect.right - rect.left < size.width as i32
                        || rect.bottom - rect.top < size.height as i32
                    {
                        return None;
                    }
                    let x = (rect.right - size.width as i32 - (24.0 * scale) as i32).max(rect.left);
                    let y =
                        (rect.bottom - size.height as i32 - (24.0 * scale) as i32).max(rect.top);
                    Some((x, y))
                });
            match position {
                Some((x, y)) => {
                    if last_position != Some((x, y)) {
                        if widget
                            .set_position(tauri::PhysicalPosition::new(x, y))
                            .is_err()
                        {
                            continue;
                        }
                        last_position = Some((x, y));
                    }
                    if !shown {
                        // SW_SHOWNOACTIVATE on every show, including after an Alt+Tab.
                        // The generic window show API can activate on subsequent shows.
                        shown = unsafe { ShowWindowAsync(widget_hwnd, 4) != 0 };
                    }
                }
                None if shown => {
                    unsafe {
                        ShowWindowAsync(widget_hwnd, 0);
                    }
                    shown = false;
                }
                None => {}
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn detects_desktop_and_terminal_without_matching_projects_or_other_apps() {
            assert!(is_opencode("opencode.exe", "Сессия"));
            assert!(is_opencode("windowsterminal.exe", "OpenCode | project"));
            assert!(!is_opencode(
                "windowsterminal.exe",
                "opencode-orchestra — PowerShell"
            ));
            assert!(!is_opencode("msedge.exe", "OpenCode"));
            assert!(!is_opencode("notepad.exe", "OpenCode"));
            assert!(is_opencode("msrdc.exe", "OpenCode | Linux project"));
            assert!(!is_opencode("msrdc.exe", "Other Linux application"));
        }
    }
}
