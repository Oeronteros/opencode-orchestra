//! Native input integration, shared by OpenCode 2 TUI, Desktop and browsers.
use tauri::AppHandle;
#[cfg(target_os = "windows")]
use tauri::Manager;

#[path = "input_target.rs"]
mod input_target;
pub use input_target::InputTarget;

#[cfg(any(target_os = "linux", test))]
#[path = "linux_input.rs"]
mod linux;

#[cfg(target_os = "linux")]
#[path = "wayland_input.rs"]
pub(crate) mod wayland_input;
#[cfg(any(target_os = "linux", test))]
#[path = "wayland_policy.rs"]
mod wayland_policy;

#[tauri::command]
pub async fn enable_voice_hotkey(app: AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        windows::enable(app)?;
        Ok(true)
    }
    #[cfg(target_os = "linux")]
    {
        use tauri::Emitter;
        if wayland_input::is_wayland() {
            let errors = app.clone();
            wayland_input::enable(
                move |target| {
                    let _ = app.emit("voice-hotkey", target);
                },
                move |message| {
                    let _ = errors.emit("voice-hotkey-error", message);
                },
            )
            .await?;
            return Ok(true);
        }
        linux::enable(move |target| {
            let _ = app.emit("voice-hotkey", target);
        })?;
        Ok(true)
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = app;
        Ok(false)
    }
}

#[tauri::command]
pub async fn paste_voice_text(
    app: AppHandle,
    target: Option<InputTarget>,
    text: String,
) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let owner = app
            .get_webview_window("overlay")
            .ok_or("Окно оверлея недоступно")?
            .hwnd()
            .map_err(|e| e.to_string())?
            .0 as isize;
        tauri::async_runtime::spawn_blocking(move || windows::paste(owner, target, text))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        if wayland_input::is_wayland() {
            return wayland_input::paste(target, text).await;
        }
        tauri::async_runtime::spawn_blocking(move || linux::paste(target, text))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = (app, target, text);
        Err("Единый глобальный хоткей поддерживается на Windows и Linux.".into())
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use super::*;
    use std::{
        ffi::c_void,
        mem::{size_of, zeroed},
        ptr::null_mut,
        sync::{mpsc, Mutex},
        time::Duration,
    };
    use tauri::Emitter;

    type Handle = *mut c_void;
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Point {
        x: i32,
        y: i32,
    }
    #[repr(C)]
    struct Message {
        window: Handle,
        message: u32,
        wparam: usize,
        lparam: isize,
        time: u32,
        point: Point,
        private: u32,
    }
    #[repr(C)]
    struct GuiInfo {
        size: u32,
        flags: u32,
        active: Handle,
        focus: Handle,
        capture: Handle,
        menu: Handle,
        move_size: Handle,
        caret: Handle,
        rect: [i32; 4],
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct KeyInput {
        key: u16,
        scan: u16,
        flags: u32,
        time: u32,
        extra: usize,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct MouseInput {
        x: i32,
        y: i32,
        data: u32,
        flags: u32,
        time: u32,
        extra: usize,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    union InputData {
        key: KeyInput,
        mouse: MouseInput,
    }
    #[repr(C)]
    struct Input {
        kind: u32,
        data: InputData,
    }

    #[link(name = "user32")]
    extern "system" {
        fn RegisterHotKey(window: Handle, id: i32, modifiers: u32, key: u32) -> i32;
        fn UnregisterHotKey(window: Handle, id: i32) -> i32;
        fn GetMessageW(message: *mut Message, window: Handle, min: u32, max: u32) -> i32;
        fn GetForegroundWindow() -> Handle;
        fn GetWindowThreadProcessId(window: Handle, process: *mut u32) -> u32;
        fn GetWindowTextW(window: Handle, text: *mut u16, max: i32) -> i32;
        fn GetGUIThreadInfo(thread: u32, info: *mut GuiInfo) -> i32;
        fn GetAsyncKeyState(key: i32) -> i16;
        fn OpenClipboard(window: Handle) -> i32;
        fn CloseClipboard() -> i32;
        fn EmptyClipboard() -> i32;
        fn SetClipboardData(format: u32, data: Handle) -> Handle;
        fn SendInput(count: u32, inputs: *const Input, size: i32) -> u32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalAlloc(flags: u32, bytes: usize) -> Handle;
        fn GlobalLock(memory: Handle) -> Handle;
        fn GlobalUnlock(memory: Handle) -> i32;
        fn GlobalFree(memory: Handle) -> Handle;
    }

    static ENABLED: Mutex<bool> = Mutex::new(false);
    fn error(action: &str) -> String {
        format!("{action}: {}", std::io::Error::last_os_error())
    }

    fn capture() -> Result<InputTarget, String> {
        unsafe {
            let window = GetForegroundWindow();
            let mut process = 0;
            let thread = GetWindowThreadProcessId(window, &mut process);
            if window.is_null() || thread == 0 || process == std::process::id() {
                return Err(
                    "Поставьте курсор в поле ввода OpenCode и нажмите Ctrl+Alt+Space.".into(),
                );
            }
            let mut info: GuiInfo = zeroed();
            info.size = size_of::<GuiInfo>() as u32;
            if GetGUIThreadInfo(thread, &mut info) == 0 {
                return Err(error("Не удалось определить поле ввода"));
            }
            let mut title = [0u16; 1024];
            let count = GetWindowTextW(window, title.as_mut_ptr(), title.len() as i32);
            Ok(InputTarget {
                window: window as isize,
                focus: info.focus as isize,
                process,
                title: String::from_utf16_lossy(&title[..count.max(0) as usize]),
            })
        }
    }

    fn modifiers_released() -> bool {
        [0x10, 0x11, 0x12, 0x5b, 0x5c]
            .iter()
            .all(|key| unsafe { GetAsyncKeyState(*key) >= 0 })
    }

    pub fn enable(app: AppHandle) -> Result<(), String> {
        let mut enabled = ENABLED.lock().map_err(|e| e.to_string())?;
        if *enabled {
            return Ok(());
        }
        let (sender, receiver) = mpsc::sync_channel(1);
        std::thread::spawn(move || unsafe {
            // MOD_CONTROL | MOD_ALT | MOD_NOREPEAT; VK_SPACE.
            if RegisterHotKey(null_mut(), 1, 0x4003, 0x20) == 0 {
                let _ = sender.send(Err(error("Ctrl+Alt+Space занят другим приложением")));
                return;
            }
            let _ = sender.send(Ok(()));
            let mut message: Message = zeroed();
            while GetMessageW(&mut message, null_mut(), 0, 0) > 0 {
                if message.message != 0x0312 || message.wparam != 1 {
                    continue;
                }
                // Capture before waiting: the global hotkey never focuses the overlay.
                let target = capture().ok();
                for _ in 0..100 {
                    if modifiers_released() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                let _ = app.emit("voice-hotkey", target);
            }
            UnregisterHotKey(null_mut(), 1);
        });
        receiver
            .recv_timeout(Duration::from_secs(3))
            .map_err(|e| e.to_string())??;
        *enabled = true;
        Ok(())
    }

    fn clipboard(owner: isize, text: &str) -> Result<(), String> {
        let wide: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
        unsafe {
            let memory = GlobalAlloc(0x0002, wide.len() * 2);
            if memory.is_null() {
                return Err(error("Не удалось подготовить текст"));
            }
            let destination = GlobalLock(memory);
            if destination.is_null() {
                GlobalFree(memory);
                return Err(error("Не удалось подготовить текст"));
            }
            std::ptr::copy_nonoverlapping(wide.as_ptr(), destination as *mut u16, wide.len());
            GlobalUnlock(memory);
            let mut opened = false;
            for _ in 0..20 {
                if OpenClipboard(owner as Handle) != 0 {
                    opened = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            if !opened {
                GlobalFree(memory);
                return Err(error("Буфер обмена занят"));
            }
            let result = if EmptyClipboard() == 0 || SetClipboardData(13, memory).is_null() {
                let reason = error("Не удалось скопировать текст");
                GlobalFree(memory);
                Err(reason)
            } else {
                Ok(())
            }; // Windows owns the allocation after SetClipboardData.
            CloseClipboard();
            result
        }
    }

    pub fn paste(owner: isize, target: Option<InputTarget>, text: String) -> Result<bool, String> {
        if text.trim().is_empty() {
            return Err("Распознанный текст пуст.".into());
        }
        clipboard(owner, &text)?;
        let Some(target) = target else {
            return Ok(false);
        };
        for _ in 0..100 {
            if modifiers_released() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if !modifiers_released() {
            return Err("Отпустите клавиши и повторите вставку. Текст сохранён в буфере.".into());
        }
        if capture().ok().as_ref() != Some(&target) {
            return Err("Окно или поле ввода изменилось. Вернитесь в исходное поле и нажмите Ctrl+Alt+Space для вставки. Текст сохранён в буфере.".into());
        }
        let key = |key, flags| Input {
            kind: 1,
            data: InputData {
                key: KeyInput {
                    key,
                    scan: 0,
                    flags,
                    time: 0,
                    extra: 0,
                },
            },
        };
        let inputs = [key(0x11, 0), key(0x56, 0), key(0x56, 2), key(0x11, 2)];
        let sent = unsafe {
            SendInput(
                inputs.len() as u32,
                inputs.as_ptr(),
                size_of::<Input>() as i32,
            )
        };
        if sent != inputs.len() as u32 {
            // Release any modifiers even after a partial injection.
            let releases = [key(0x56, 2), key(0x11, 2)];
            unsafe {
                SendInput(2, releases.as_ptr(), size_of::<Input>() as i32);
            }
            return Err(
                "Windows заблокировал вставку. Текст сохранён; вставьте его вручную через Ctrl+V."
                    .into(),
            );
        }
        Ok(true)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[link(name = "user32")]
        extern "system" {
            fn SetForegroundWindow(window: Handle) -> i32;
        }

        #[test]
        fn win32_structures_match_the_x64_abi() {
            assert_eq!(size_of::<Input>(), 40);
            assert_eq!(size_of::<GuiInfo>(), 72);
            assert_eq!(size_of::<Message>(), 48);
        }

        /// Run only against the dedicated textbox created by scripts/voice-native-smoke.ps1.
        #[test]
        #[ignore = "requires a foreground Windows textbox fixture"]
        fn paste_into_foreign_windows_textbox() {
            let file = std::env::var("ORCHESTRA_NATIVE_SMOKE_FILE").expect("native fixture file");
            let fixture: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
            let fixture_window = fixture["window"].as_i64().unwrap() as isize;
            let mut fixture_title = [0u16; 1024];
            let count = unsafe {
                GetWindowTextW(
                    fixture_window as Handle,
                    fixture_title.as_mut_ptr(),
                    fixture_title.len() as i32,
                )
            };
            assert_eq!(
                String::from_utf16_lossy(&fixture_title[..count as usize]),
                "Orchestra native voice test"
            );
            unsafe {
                SetForegroundWindow(fixture_window as Handle);
            }
            // Background test runners may not activate a window. Allow a person
            // to focus the fixture; never inject into whichever window won focus.
            for _ in 0..100 {
                if capture()
                    .ok()
                    .is_some_and(|target| target.window == fixture_window)
                {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            let target = capture().expect("foreground fixture");
            assert_eq!(
                target.window as i64,
                fixture["window"].as_i64().unwrap(),
                "refuse to inject into another window"
            );
            assert_eq!(
                target.focus as i64,
                fixture["focus"].as_i64().unwrap(),
                "refuse to inject into another control"
            );
            assert_eq!(target.title, "Orchestra native voice test");
            let mut changed = target.clone();
            changed.process += 1;
            assert!(paste(target.window, Some(changed), "wrong destination".into()).is_err());
            assert_eq!(
                paste(target.window, Some(target.clone()), "голосовой ввод".into()),
                Ok(true)
            );
            std::thread::sleep(Duration::from_millis(300));
            let mut text = [0u16; 1024];
            let count = unsafe {
                GetWindowTextW(target.focus as Handle, text.as_mut_ptr(), text.len() as i32)
            };
            assert_eq!(
                String::from_utf16_lossy(&text[..count as usize]),
                "Черновик голосовой ввод"
            );
        }

        #[test]
        fn empty_result_never_touches_the_clipboard_or_keyboard() {
            assert!(paste(0, None, " \n".into()).unwrap_err().contains("пуст"));
        }
    }
}
