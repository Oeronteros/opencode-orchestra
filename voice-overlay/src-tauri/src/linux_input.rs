//! X11 uses an independent connection, so a minimized WebView never owns the grab.
//! xclip retains selection ownership after this command finishes. No shell is used.
use super::InputTarget;
use std::{
    io::Write,
    process::{Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};
#[cfg(test)]
use x11rb::wrapper::ConnectionExt as _;
use x11rb::{
    connection::Connection,
    protocol::{
        xproto::{AtomEnum, ConnectionExt, GrabMode, ModMask},
        xtest::ConnectionExt as _,
        Event,
    },
    rust_connection::RustConnection,
};

static ENABLED: Mutex<bool> = Mutex::new(false);
const CONTROL: u32 = 0xffe3;
const SHIFT: u32 = 0xffe1;
const ALT: u32 = 0xffe9;
const SPACE: u32 = 0x20;

fn display() -> Result<(RustConnection, usize), String> {
    if std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE").ok().as_deref() == Some("wayland")
    {
        return Err("Единый хоткей и автовставка требуют сессию Linux X11. В Wayland используйте режим совместимости с TUI через сервер или встроенный микрофон Web. XWayland не даёт доступа к нативным Wayland-окнам.".into());
    }
    x11rb::connect(None).map_err(|e| format!("Не удалось подключиться к X11: {e}"))
}

fn keycode(c: &RustConnection, keysym: u32) -> Result<u8, String> {
    let setup = c.setup();
    let map = c
        .get_keyboard_mapping(setup.min_keycode, setup.max_keycode - setup.min_keycode + 1)
        .map_err(|e| e.to_string())?
        .reply()
        .map_err(|e| e.to_string())?;
    map.keysyms
        .chunks(map.keysyms_per_keycode as usize)
        .position(|row| row.contains(&keysym))
        .map(|index| setup.min_keycode + index as u8)
        .ok_or_else(|| format!("Клавиша {keysym:x} отсутствует в раскладке X11"))
}

fn property(c: &RustConnection, window: u32, name: &str) -> Result<Vec<u8>, String> {
    let atom = c
        .intern_atom(false, name.as_bytes())
        .map_err(|e| e.to_string())?
        .reply()
        .map_err(|e| e.to_string())?
        .atom;
    c.get_property(false, window, atom, AtomEnum::ANY, 0, 4096)
        .map_err(|e| e.to_string())?
        .reply()
        .map(|reply| reply.value)
        .map_err(|e| e.to_string())
}

fn cardinal(bytes: &[u8]) -> Option<u32> {
    Some(u32::from_ne_bytes(bytes.get(..4)?.try_into().ok()?))
}

fn capture(c: &RustConnection, screen: usize) -> Result<InputTarget, String> {
    let root = c.setup().roots[screen].root;
    let window = cardinal(&property(c, root, "_NET_ACTIVE_WINDOW")?)
        .filter(|id| *id > 1)
        .ok_or("X11 не сообщает активное окно. Нужен оконный менеджер с поддержкой EWMH.")?;
    let focus = c
        .get_input_focus()
        .map_err(|e| e.to_string())?
        .reply()
        .map_err(|e| e.to_string())?
        .focus;
    let process = cardinal(&property(c, window, "_NET_WM_PID")?).unwrap_or(0);
    if process == std::process::id() || focus <= 1 {
        return Err("Поставьте курсор в поле ввода OpenCode и нажмите Ctrl+Alt+Space.".into());
    }
    let mut title = property(c, window, "_NET_WM_NAME")?;
    if title.is_empty() {
        title = property(c, window, "WM_NAME")?;
    }
    Ok(InputTarget {
        window: window as isize,
        focus: focus as isize,
        process,
        title: String::from_utf8_lossy(&title).into_owned(),
    })
}

fn down(c: &RustConnection, code: u8) -> Result<bool, String> {
    let keys = c
        .query_keymap()
        .map_err(|e| e.to_string())?
        .reply()
        .map_err(|e| e.to_string())?
        .keys;
    Ok(keys[code as usize / 8] & (1 << (code % 8)) != 0)
}

fn wait_released(c: &RustConnection) -> Result<(), String> {
    // Both left and right variants, including Super, must be released before paste.
    let codes: Vec<_> = [
        SHIFT,
        SHIFT + 1,
        CONTROL,
        CONTROL + 1,
        ALT,
        ALT + 1,
        0xffeb,
        0xffec,
    ]
    .iter()
    .filter_map(|sym| keycode(c, *sym).ok())
    .collect();
    for _ in 0..100 {
        if codes.iter().all(|code| down(c, *code).ok() == Some(false)) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Err("Отпустите клавиши и повторите вставку. Текст сохранён.".into())
}

pub fn enable(emit: impl Fn(Option<InputTarget>) + Send + 'static) -> Result<(), String> {
    let mut enabled = ENABLED.lock().map_err(|e| e.to_string())?;
    if *enabled {
        return Ok(());
    }
    let (c, screen) = display()?;
    c.xtest_get_version(2, 2)
        .map_err(|e| format!("X11: расширение XTEST недоступно: {e}"))?
        .reply()
        .map_err(|e| format!("X11: расширение XTEST недоступно: {e}"))?;
    // Diagnose missing clipboard support before dictation starts.
    let status = Command::new("xclip")
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| {
            "Для Linux X11 установите xclip (например: sudo apt install xclip).".to_string()
        })?;
    if !status.success() {
        return Err("Не удалось запустить xclip.".into());
    }
    let key = keycode(&c, SPACE)?;
    let num = keycode(&c, 0xff7f).ok();
    let mapping = c
        .get_modifier_mapping()
        .map_err(|e| e.to_string())?
        .reply()
        .map_err(|e| e.to_string())?;
    let width = mapping.keycodes.len() / 8;
    let num_mask = num
        .and_then(|code| {
            mapping
                .keycodes
                .chunks(width)
                .position(|row| row.contains(&code))
        })
        .map(|index| 1u16 << index)
        .unwrap_or(0);
    let mut masks = vec![0, 2, num_mask, 2 | num_mask];
    masks.sort_unstable();
    masks.dedup();
    for root in &c.setup().roots {
        for locks in &masks {
            c.grab_key(
                false,
                root.root,
                ModMask::from(4 | 8 | *locks),
                key,
                GrabMode::ASYNC,
                GrabMode::ASYNC,
            )
            .map_err(|e| e.to_string())?
            .check()
            .map_err(|e| {
                format!(
                    "Не удалось зарегистрировать Ctrl+Alt+Space (возможно, сочетание занято): {e}"
                )
            })?;
        }
    }
    c.flush().map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        let mut pending = None;
        while let Ok(event) = c.wait_for_event() {
            match event {
                Event::KeyPress(event) if event.detail == key => {
                    if pending.is_none() {
                        pending = Some(capture(&c, screen).ok());
                    }
                }
                Event::KeyRelease(event) if event.detail == key => {
                    // X11 repeat produces synthetic release/press pairs while Space is down.
                    if down(&c, key).ok() != Some(false) {
                        continue;
                    }
                    if let Some(target) = pending.take() {
                        let _ = wait_released(&c);
                        emit(target);
                    }
                }
                _ => {}
            }
        }
        if let Ok(mut enabled) = ENABLED.lock() {
            *enabled = false;
        }
    });
    *enabled = true;
    Ok(())
}

fn clipboard(text: &str) -> Result<(), String> {
    let mut child = Command::new("xclip")
        .args([
            "-selection",
            "clipboard",
            "-in",
            "-silent",
            "-target",
            "UTF8_STRING",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Не удалось запустить xclip: {e}"))?;
    let write = child
        .stdin
        .take()
        .ok_or("xclip: stdin недоступен")
        .and_then(|mut stdin| {
            stdin
                .write_all(text.as_bytes())
                .map_err(|_| "xclip: не удалось записать текст")
        });
    if let Err(error) = write {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error.into());
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return if status.success() {
                Ok(())
            } else {
                Err("xclip не смог записать текст в буфер.".into())
            };
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("xclip: время ожидания истекло.".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

pub(crate) fn terminal_class(class: &[u8]) -> bool {
    String::from_utf8_lossy(class).split('\0').any(|part| {
        let part = part.to_ascii_lowercase();
        [
            "xterm",
            "uxterm",
            "gnome-terminal",
            "gnome-terminal-server",
            "org.gnome.terminal",
            "konsole",
            "org.kde.konsole",
            "yakuake",
            "org.kde.yakuake",
            "guake",
            "xfce4-terminal",
            "alacritty",
            "org.alacritty.alacritty",
            "kitty",
            "wezterm",
            "org.wezfurlong.wezterm",
            "terminator",
            "tilix",
            "foot",
            "st",
            "urxvt",
            "rxvt",
            "mate-terminal",
            "lxterminal",
            "ghostty",
            "com.mitchellh.ghostty",
            "org.gnome.ptyxis",
            "org.gnome.console",
            "kgx",
        ]
        .contains(&part.as_str())
    })
}

pub fn paste(target: Option<InputTarget>, text: String) -> Result<bool, String> {
    if text.trim().is_empty() {
        return Err("Распознанный текст пуст.".into());
    }
    let (c, screen) = display()?;
    clipboard(&text)?;
    let Some(target) = target else {
        return Ok(false);
    };
    wait_released(&c)?;
    if capture(&c, screen).ok().as_ref() != Some(&target) {
        return Err("Окно или поле ввода изменилось. Вернитесь в исходное поле и нажмите Ctrl+Alt+Space. Текст сохранён в оверлее и буфере.".into());
    }
    let shift = terminal_class(&property(&c, target.window as u32, "WM_CLASS")?);
    let ctrl = keycode(&c, CONTROL)?;
    let shift_key = keycode(&c, SHIFT)?;
    let v = keycode(&c, u32::from(b'v'))?;
    // Ctrl+Shift+V for terminal emulators; Ctrl+V for Desktop and browsers. No Enter.
    let mut events = vec![(2, ctrl)];
    if shift {
        events.push((2, shift_key));
    }
    events.extend([(2, v), (3, v)]);
    if shift {
        events.push((3, shift_key));
    }
    events.push((3, ctrl));
    let result = events.into_iter().try_for_each(|(kind, code)| {
        c.xtest_fake_input(kind, code, 0, 0, 0, 0, 0)
            .map_err(|e| e.to_string())?
            .check()
            .map_err(|e| e.to_string())
    });
    if let Err(error) = result {
        for code in [v, shift_key, ctrl] {
            if let Ok(cookie) = c.xtest_fake_input(3, code, 0, 0, 0, 0, 0) {
                let _ = cookie.check();
            }
        }
        return Err(format!(
            "X11 заблокировал вставку: {error}. Текст сохранён."
        ));
    }
    c.flush().map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn terminal_paste_does_not_send_ctrl_v_to_the_tui() {
        assert!(terminal_class(b"gnome-terminal-server\0Gnome-terminal\0"));
        assert!(terminal_class(b"kitty\0kitty\0"));
        assert!(terminal_class(
            b"com.mitchellh.ghostty\0com.mitchellh.ghostty\0"
        ));
        assert!(!terminal_class(b"opencode\0OpenCode\0"));
        assert!(!terminal_class(b"Navigator\0Firefox\0"));
    }
    #[test]
    fn empty_transcript_never_connects_to_a_display() {
        assert!(paste(None, " \n".into()).unwrap_err().contains("пуст"));
    }
    #[test]
    fn truncated_window_property_is_not_an_input_target() {
        assert_eq!(cardinal(&[]), None);
        assert_eq!(cardinal(&[1, 2, 3]), None);
        assert_eq!(cardinal(&123u32.to_ne_bytes()), Some(123));
    }

    /// Run in a dedicated Xvfb server; never inject into a user's desktop.
    #[test]
    #[ignore = "requires ORCHESTRA_X11_SMOKE=1, a dedicated Xvfb display and xclip"]
    fn x11_shortcut_clipboard_focus_guard_and_paste() {
        assert_eq!(std::env::var("ORCHESTRA_X11_SMOKE").as_deref(), Ok("1"));
        use x11rb::protocol::xproto::{
            CreateWindowAux, EventMask, InputFocus, PropMode, WindowClass,
        };
        let (c, screen) = display().unwrap();
        let root = &c.setup().roots[screen];
        let window = c.generate_id().unwrap();
        c.create_window(
            root.root_depth,
            window,
            root.root,
            0,
            0,
            200,
            100,
            0,
            WindowClass::INPUT_OUTPUT,
            root.root_visual,
            &CreateWindowAux::new().event_mask(
                EventMask::KEY_PRESS | EventMask::KEY_RELEASE | EventMask::PROPERTY_CHANGE,
            ),
        )
        .unwrap()
        .check()
        .unwrap();
        let atom = |name: &[u8]| c.intern_atom(false, name).unwrap().reply().unwrap().atom;
        c.change_property32(
            PropMode::REPLACE,
            root.root,
            atom(b"_NET_ACTIVE_WINDOW"),
            AtomEnum::WINDOW,
            &[window],
        )
        .unwrap()
        .check()
        .unwrap();
        c.change_property32(
            PropMode::REPLACE,
            window,
            atom(b"_NET_WM_PID"),
            AtomEnum::CARDINAL,
            &[std::process::id() + 1],
        )
        .unwrap()
        .check()
        .unwrap();
        c.change_property8(
            PropMode::REPLACE,
            window,
            atom(b"_NET_WM_NAME"),
            atom(b"UTF8_STRING"),
            b"Orchestra X11 smoke fixture",
        )
        .unwrap()
        .check()
        .unwrap();
        c.change_property8(
            PropMode::REPLACE,
            window,
            AtomEnum::WM_CLASS,
            AtomEnum::STRING,
            b"opencode\0OpenCode\0",
        )
        .unwrap()
        .check()
        .unwrap();
        c.map_window(window).unwrap().check().unwrap();
        c.set_input_focus(InputFocus::PARENT, window, x11rb::CURRENT_TIME)
            .unwrap()
            .check()
            .unwrap();
        let target = capture(&c, screen).unwrap();

        let (sender, receiver) = std::sync::mpsc::channel();
        enable(move |target| {
            let _ = sender.send(target);
        })
        .unwrap();
        let ctrl = keycode(&c, CONTROL).unwrap();
        let alt = keycode(&c, ALT).unwrap();
        let space = keycode(&c, SPACE).unwrap();
        for (kind, key) in [
            (2, ctrl),
            (2, alt),
            (2, space),
            (3, space),
            (3, alt),
            (3, ctrl),
        ] {
            c.xtest_fake_input(kind, key, 0, 0, 0, 0, 0)
                .unwrap()
                .check()
                .unwrap();
        }
        assert_eq!(
            receiver.recv_timeout(Duration::from_secs(3)).unwrap(),
            Some(target.clone())
        );
        assert!(receiver.try_recv().is_err(), "one activation per shortcut");

        let mut changed = target.clone();
        changed.process += 1;
        assert!(paste(Some(changed), "must not paste".into()).is_err());
        while c.poll_for_event().unwrap().is_some() {}
        let text = "Черновик голосовой ввод 🐧";
        assert_eq!(paste(Some(target.clone()), text.into()), Ok(true));
        let v = keycode(&c, u32::from(b'v')).unwrap();
        let mut pasted = false;
        while let Some(event) = c.poll_for_event().unwrap() {
            if let Event::KeyPress(event) = event {
                if event.detail == v {
                    assert_eq!(u16::from(event.state) & 5, 4);
                    pasted = true;
                }
            }
        }
        assert!(pasted, "Desktop paste is Ctrl+V without Enter");
        let clipboard_atom = atom(b"CLIPBOARD");
        let result_atom = atom(b"ORCHESTRA_SMOKE_CLIPBOARD");
        c.convert_selection(
            window,
            clipboard_atom,
            atom(b"UTF8_STRING"),
            result_atom,
            x11rb::CURRENT_TIME,
        )
        .unwrap()
        .check()
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(Event::SelectionNotify(event)) = c.poll_for_event().unwrap() {
                assert_ne!(event.property, 0);
                let value = c
                    .get_property(false, window, result_atom, AtomEnum::ANY, 0, 4096)
                    .unwrap()
                    .reply()
                    .unwrap()
                    .value;
                assert_eq!(String::from_utf8(value).unwrap(), text);
                break;
            }
            assert!(
                Instant::now() < deadline,
                "clipboard selection response timed out"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        c.change_property8(
            PropMode::REPLACE,
            window,
            AtomEnum::WM_CLASS,
            AtomEnum::STRING,
            b"kitty\0kitty\0",
        )
        .unwrap()
        .check()
        .unwrap();
        assert_eq!(paste(Some(target), text.into()), Ok(true));
        let mut terminal_paste = false;
        while let Some(event) = c.poll_for_event().unwrap() {
            if let Event::KeyPress(event) = event {
                if event.detail == v {
                    assert_eq!(u16::from(event.state) & 5, 5);
                    terminal_paste = true;
                }
            }
        }
        assert!(terminal_paste, "TUI paste is Ctrl+Shift+V");
        c.destroy_window(window).unwrap().check().unwrap();
    }
}
