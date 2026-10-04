//! Native Wayland: portals for shortcuts/keyboard, compositor identity for focus.
//! No /dev/input, root daemon, shell interpolation, or XWayland injection.
use super::{
    wayland_policy::{self, Focus},
    InputTarget,
};
use ashpd::desktop::{
    clipboard::{Clipboard, SetSelectionOptions},
    global_shortcuts::{GlobalShortcuts, NewShortcut},
    remote_desktop::{DeviceType, KeyState, RemoteDesktop, SelectDevicesOptions},
    Session,
};
use futures_util::StreamExt;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::AsyncWriteExt,
    process::Command,
    sync::{mpsc, Mutex},
};

const BUS: &str = "ai.opencode.VoiceOverlay";
const PATH: &str = "/ai/opencode/VoiceOverlay";
const GNOME_PATH: &str = "/ai/opencode/VoiceOverlay/Focus";
const GNOME_INTERFACE: &str = "ai.opencode.VoiceOverlay.Focus";
const SHORTCUT: &str = "voice-toggle";
const EXTENSION_ID: &str = "voice-input@opencode.ai";
static BACKEND: Mutex<Option<Backend>> = Mutex::const_new(None);

struct Toggle {
    sender: mpsc::UnboundedSender<()>,
}
#[zbus::interface(name = "ai.opencode.VoiceOverlay")]
impl Toggle {
    fn toggle(&self) -> zbus::fdo::Result<()> {
        self.sender
            .send(())
            .map_err(|_| zbus::fdo::Error::Failed("Оверлей остановлен".into()))
    }
}

struct Backend {
    connection: zbus::Connection,
    remote: Option<(RemoteDesktop, Session<RemoteDesktop>)>,
    remote_active: Arc<AtomicBool>,
    clipboard: Option<Clipboard>,
    text: Arc<Mutex<String>>,
    ready: bool,
    error: Option<String>,
}

pub fn is_wayland() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE").ok().as_deref() == Some("wayland")
}

fn error(context: &str, e: impl std::fmt::Display) -> String {
    format!("Wayland: {context}: {e}. Текст сохранён.")
}

async fn output(program: &str, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new(program);
    command.args(args).kill_on_drop(true);
    let result = tokio::time::timeout(Duration::from_secs(3), command.output())
        .await
        .map_err(|_| error(program, "время ожидания истекло"))?
        .map_err(|e| error(program, e))?;
    if !result.status.success() {
        return Err(error(program, String::from_utf8_lossy(&result.stderr)));
    }
    String::from_utf8(result.stdout).map_err(|e| error(program, e))
}

async fn gnome_proxy(connection: &zbus::Connection) -> Result<zbus::Proxy<'_>, String> {
    zbus::Proxy::new(connection, "org.gnome.Shell", GNOME_PATH, GNOME_INTERFACE)
        .await
        .map_err(|e| error("расширение GNOME", e))
}

async fn capture(connection: &zbus::Connection) -> Result<Focus, String> {
    let value = if std::env::var_os("SWAYSOCK").is_some() {
        let raw = output("swaymsg", &["-r", "-t", "get_tree"]).await?;
        wayland_policy::sway_focus(&serde_json::from_str(&raw).map_err(|e| error("swaymsg", e))?)
    } else if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some() {
        let raw = output("hyprctl", &["-j", "activewindow"]).await?;
        wayland_policy::hyprland_focus(
            &serde_json::from_str(&raw).map_err(|e| error("hyprctl", e))?,
        )
    } else if std::env::var("XDG_CURRENT_DESKTOP")
        .unwrap_or_default()
        .to_lowercase()
        .contains("kde")
    {
        // One KWin script returns a consistent window identity (no three-command race).
        let script = "var w=workspace.activeWindow||workspace.activeClient;if(w){output_result(JSON.stringify({backend:'kde',id:String(w.internalId),process:w.pid,title:w.caption,app_id:String(w.resourceClass)}));}";
        let raw = output("kdotool", &["kwinscript", "--inline", script])
            .await
            .map_err(|e| format!("{e} Для KDE установите kdotool."))?;
        serde_json::from_str(&raw).map_err(|e| error("фокус KWin", e))?
    } else if std::env::var("XDG_CURRENT_DESKTOP")
        .unwrap_or_default()
        .to_lowercase()
        .contains("gnome")
    {
        let raw: String = gnome_proxy(connection).await?.call("GetFocus", &()).await
            .map_err(|e| format!("{} Выполните voice-overlay --install-gnome-extension и включите расширение после повторного входа.", error("фокус GNOME", e)))?;
        serde_json::from_str(&raw).map_err(|e| error("фокус GNOME", e))?
    } else {
        return Err("Wayland: поддержаны GNOME, KDE Plasma, Sway и Hyprland. Для другого окружения используйте серверный режим TUI или Web-микрофон.".into());
    };
    value.ok_or_else(|| {
        "Wayland: активное окно не определено. Поставьте курсор в поле OpenCode.".into()
    })
}

pub async fn toggle_existing() -> Result<(), String> {
    let connection = zbus::Connection::session()
        .await
        .map_err(|e| error("D-Bus", e))?;
    let proxy = zbus::Proxy::new(&connection, BUS, PATH, BUS)
        .await
        .map_err(|e| error("D-Bus", e))?;
    proxy.call::<_, _, ()>("Toggle", &()).await.map_err(|e| {
        format!(
            "{} Сначала запустите окно voice-overlay.",
            error("хоткей", e)
        )
    })
}

pub async fn enable(
    emit: impl Fn(Option<InputTarget>) + Send + Sync + 'static,
    notify: impl Fn(String) + Send + Sync + 'static,
) -> Result<(), String> {
    let mut state = BACKEND.lock().await;
    if let Some(backend) = state.as_mut() {
        let focus = capture(&backend.connection).await?;
        if focus.backend == "kde" {
            prepare_input(backend).await?;
        }
        if backend.ready {
            return Ok(());
        }
        // An external binding/extension can be installed while the overlay is open.
        if focus.backend == "gnome" {
            return Ok(());
        }
        return Err(backend.error.clone().unwrap_or_default());
    }
    let (sender, mut receiver) = mpsc::unbounded_channel();
    let connection = zbus::connection::Builder::session()
        .map_err(|e| error("D-Bus", e))?
        .name(BUS)
        .map_err(|e| error("D-Bus", e))?
        .serve_at(PATH, Toggle { sender })
        .map_err(|e| error("D-Bus", e))?
        .build()
        .await
        .map_err(|e| error("D-Bus (другое окно уже запущено?)", e))?;
    let emit = Arc::new(emit);
    let notify = Arc::new(notify);
    let callback_connection = connection.clone();
    tokio::spawn(async move {
        let mut last = std::time::Instant::now() - Duration::from_secs(1);
        while receiver.recv().await.is_some() {
            if last.elapsed() < Duration::from_millis(250) {
                continue;
            }
            last = std::time::Instant::now();
            // External desktop bindings launch on press; allow modifier release.
            tokio::time::sleep(Duration::from_millis(150)).await;
            match capture(&callback_connection).await.and_then(|f| f.target()) {
                Ok(target) => emit(Some(target)),
                Err(e) => notify(e),
            }
        }
    });
    let focus = capture(&connection).await;
    if focus.as_ref().is_ok_and(|f| f.backend == "gnome") {
        *state = Some(Backend {
            connection,
            remote: None,
            remote_active: Arc::new(AtomicBool::new(false)),
            clipboard: None,
            text: Arc::new(Mutex::new(String::new())),
            ready: true,
            error: None,
        });
        return Ok(());
    }
    // Preserve external --toggle even if the desktop has no GlobalShortcuts portal.
    let shortcut_result = bind_portal(connection.clone()).await;
    let ready = shortcut_result.is_ok();
    let registration_error = shortcut_result.err().map(|e| format!("{e} Привяжите Ctrl+Alt+Space к команде voice-overlay --toggle в настройках рабочего окружения."));
    *state = Some(Backend {
        connection,
        remote: None,
        remote_active: Arc::new(AtomicBool::new(false)),
        clipboard: None,
        text: Arc::new(Mutex::new(String::new())),
        ready,
        error: registration_error.clone(),
    });
    if let Some(e) = registration_error {
        return Err(e);
    }
    // Validate focus adapter during setup, not after the first dictation.
    let focus = focus?;
    if focus.backend == "kde" {
        prepare_input(state.as_mut().unwrap()).await?;
    }
    Ok(())
}

async fn bind_portal(connection: zbus::Connection) -> Result<(), String> {
    let proxy = GlobalShortcuts::with_connection(connection)
        .await
        .map_err(|e| error("портал GlobalShortcuts", e))?;
    let session = proxy
        .create_session(Default::default())
        .await
        .map_err(|e| error("сеанс хоткея", e))?;
    let mut released = proxy
        .receive_deactivated()
        .await
        .map_err(|e| error("сигнал хоткея", e))?;
    let mut activated = proxy
        .receive_activated()
        .await
        .map_err(|e| error("сигнал хоткея", e))?;
    let response = proxy
        .bind_shortcuts(
            &session,
            &[
                NewShortcut::new(SHORTCUT, "OpenCode: начать / остановить диктовку")
                    .preferred_trigger("CTRL+ALT+space"),
            ],
            None,
            Default::default(),
        )
        .await
        .map_err(|e| error("настройка хоткея", e))?
        .response()
        .map_err(|e| error("разрешение хоткея", e))?;
    if !response.shortcuts().iter().any(|s| s.id() == SHORTCUT) {
        return Err("Wayland: рабочее окружение не назначило горячую клавишу.".into());
    }
    let connection = proxy.connection().clone();
    let session_path = proxy_session_path(&session)?;
    tokio::spawn(async move {
        let mut down = false;
        loop {
            tokio::select! {
                biased;
                event = activated.next() => {
                    let Some(event) = event else { break; };
                    if event.shortcut_id() == SHORTCUT && event.session_handle().as_str() == session_path { down = true; }
                }
                event = released.next() => {
                    let Some(event) = event else { break; };
                    if event.shortcut_id() != SHORTCUT || event.session_handle().as_str() != session_path || !down { continue; }
                    down = false;
                    if let Ok(proxy) = zbus::Proxy::new(&connection, BUS, PATH, BUS).await {
                        let _ = proxy.call::<_, _, ()>("Toggle", &()).await;
                    }
                }
            }
        }
        let _ = session.close().await;
        drop(proxy);
    });
    Ok(())
}

fn proxy_session_path<T: ashpd::desktop::SessionPortal>(
    session: &Session<T>,
) -> Result<String, String> {
    // ashpd deliberately hides the path but serializes Session as its D-Bus path.
    serde_json::to_value(session)
        .map_err(|e| e.to_string())?
        .as_str()
        .map(String::from)
        .ok_or("Неверный путь сеанса Wayland".into())
}

async fn prepare_input(backend: &mut Backend) -> Result<(), String> {
    if backend.remote.is_some() && backend.remote_active.load(Ordering::SeqCst) {
        return Ok(());
    }
    backend.remote = None;
    backend.clipboard = None;
    let remote = RemoteDesktop::with_connection(backend.connection.clone())
        .await
        .map_err(|e| error("портал RemoteDesktop", e))?;
    let session = remote
        .create_session(Default::default())
        .await
        .map_err(|e| error("сеанс клавиатуры", e))?;
    let active = Arc::new(AtomicBool::new(true));
    backend.remote_active = active.clone();
    let session_path = proxy_session_path(&session)?;
    let connection = backend.connection.clone();
    let (watch_ready, watching) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let proxy = match zbus::Proxy::new(
            &connection,
            "org.freedesktop.portal.Desktop",
            session_path.as_str(),
            "org.freedesktop.portal.Session",
        )
        .await
        {
            Ok(proxy) => proxy,
            Err(e) => {
                let _ = watch_ready.send(Err(error("сеанс клавиатуры", e)));
                return;
            }
        };
        let mut closed = match proxy.receive_signal("Closed").await {
            Ok(stream) => stream,
            Err(e) => {
                let _ = watch_ready.send(Err(error("сеанс клавиатуры", e)));
                return;
            }
        };
        let _ = watch_ready.send(Ok(()));
        let _ = closed.next().await;
        active.store(false, Ordering::SeqCst);
    });
    watching.await.map_err(|e| error("сеанс клавиатуры", e))??;
    let clipboard = Clipboard::with_connection(backend.connection.clone())
        .await
        .ok();
    let clipboard = if let Some(clipboard) = clipboard {
        if clipboard
            .request(&session, Default::default())
            .await
            .is_ok()
        {
            Some(clipboard)
        } else {
            None
        }
    } else {
        None
    };
    remote
        .select_devices(
            &session,
            SelectDevicesOptions::default().set_devices(Some(DeviceType::Keyboard.into())),
        )
        .await
        .map_err(|e| error("выбор клавиатуры", e))?;
    let granted = remote
        .start(&session, None, Default::default())
        .await
        .map_err(|e| error("разрешение вставки", e))?
        .response()
        .map_err(|e| error("разрешение вставки", e))?;
    if !granted.devices().contains(DeviceType::Keyboard)
        || !backend.remote_active.load(Ordering::SeqCst)
    {
        let _ = session.close().await;
        return Err("Wayland: доступ к клавиатуре не разрешён. Текст сохранён.".into());
    }
    if granted.is_clipboard_enabled() {
        if let Some(clipboard) = clipboard {
            let clipboard_worker = Clipboard::with_connection(backend.connection.clone())
                .await
                .map_err(|e| error("буфер", e))?;
            let text = backend.text.clone();
            let clipboard_session_path = proxy_session_path(&session)?;
            let (ready_sender, ready_receiver) = tokio::sync::oneshot::channel();
            tokio::spawn(async move {
                let mut transfers = match clipboard_worker
                    .receive_selection_transfer::<RemoteDesktop>()
                    .await
                {
                    Ok(stream) => {
                        let _ = ready_sender.send(Ok(()));
                        stream.boxed()
                    }
                    Err(e) => {
                        let _ = ready_sender.send(Err(error("буфер", e)));
                        return;
                    }
                };
                while let Some((session, mime, serial)) = transfers.next().await {
                    if proxy_session_path(&session).ok().as_deref()
                        != Some(clipboard_session_path.as_str())
                    {
                        continue;
                    }
                    if mime != "text/plain;charset=utf-8" && mime != "text/plain" {
                        continue;
                    }
                    let success = match clipboard_worker.selection_write(&session, serial).await {
                        Ok(fd) => {
                            let bytes = text.lock().await.clone().into_bytes();
                            let file = std::fs::File::from(std::os::fd::OwnedFd::from(fd));
                            tokio::time::timeout(Duration::from_secs(3), async {
                                let mut file = tokio::fs::File::from_std(file);
                                file.write_all(&bytes).await?;
                                file.shutdown().await
                            })
                            .await
                            .is_ok_and(|r| r.is_ok())
                        }
                        Err(_) => false,
                    };
                    let _ = clipboard_worker
                        .selection_write_done(&session, serial, success)
                        .await;
                }
            });
            ready_receiver.await.map_err(|e| error("буфер", e))??;
            backend.clipboard = Some(clipboard);
        }
    }
    backend.remote = Some((remote, session));
    Ok(())
}

async fn wl_copy(text: &str) -> Result<(), String> {
    let mut child = Command::new("wl-copy")
        .args(["--type", "text/plain;charset=utf-8"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("{} Установите wl-clipboard.", error("wl-copy", e)))?;
    let mut stdin = child.stdin.take().ok_or("wl-copy: stdin недоступен")?;
    tokio::time::timeout(Duration::from_secs(3), async {
        stdin.write_all(text.as_bytes()).await?;
        drop(stdin);
        child.wait().await
    })
    .await
    .map_err(|_| error("wl-copy", "время ожидания истекло"))?
    .map_err(|e| error("wl-copy", e))?
    .success()
    .then_some(())
    .ok_or_else(|| error("wl-copy", "не удалось скопировать текст"))
}

pub async fn paste(target: Option<InputTarget>, text: String) -> Result<bool, String> {
    if text.trim().is_empty() {
        return Err("Распознанный текст пуст.".into());
    }
    let mut state = BACKEND.lock().await;
    let backend = state
        .as_mut()
        .ok_or("Wayland: сначала включите горячую клавишу.")?;
    let Some(target) = target else {
        if capture(&backend.connection)
            .await
            .is_ok_and(|f| f.backend == "gnome")
        {
            let _: bool = gnome_proxy(&backend.connection)
                .await?
                .call("Copy", &(text,))
                .await
                .map_err(|e| error("буфер GNOME", e))?;
        } else {
            wl_copy(&text).await?;
        }
        return Ok(false);
    };
    let expected = Focus::from_target(&target)?;
    let current = capture(&backend.connection).await?;
    if current != expected {
        return Err("Окно или вкладка изменились. Вернитесь в исходное поле и нажмите Ctrl+Alt+Space. Текст сохранён.".into());
    }
    if expected.backend == "gnome" {
        // GNOME extension owns clipboard and keyboard and repeats the focus guard.
        return gnome_proxy(&backend.connection)
            .await?
            .call("Paste", &(target.title, text))
            .await
            .map_err(|e| error("вставка GNOME", e));
    }
    if expected.backend == "sway" || expected.backend == "hyprland" {
        wl_copy(&text).await?;
        if capture(&backend.connection).await? != expected {
            return Err("Окно изменилось. Текст сохранён.".into());
        }
        let args = if expected.terminal() {
            vec![
                "-M", "ctrl", "-M", "shift", "-k", "v", "-m", "shift", "-m", "ctrl",
            ]
        } else {
            vec!["-M", "ctrl", "-k", "v", "-m", "ctrl"]
        };
        output("wtype", &args).await.map_err(|e| {
            format!("{e} Установите wtype; композитор должен поддерживать virtual-keyboard.")
        })?;
        return Ok(true);
    }
    // Permissions are acquired once, before injection; recheck focus after any dialog.
    prepare_input(backend).await?;
    *backend.text.lock().await = text.clone();
    if let Some(clipboard) = &backend.clipboard {
        let (_, session) = backend.remote.as_ref().unwrap();
        clipboard
            .set_selection(
                session,
                SetSelectionOptions::default()
                    .set_mime_types(&["text/plain;charset=utf-8", "text/plain"]),
            )
            .await
            .map_err(|e| error("буфер Wayland", e))?;
    } else {
        wl_copy(&text).await?;
    }
    if capture(&backend.connection).await? != expected {
        return Err("Окно изменилось после системного диалога. Вернитесь в исходное поле и нажмите хоткей. Текст сохранён.".into());
    }
    let (remote, session) = backend.remote.as_ref().unwrap();
    let keys = if expected.terminal() {
        vec![29, 42, 47]
    } else {
        vec![29, 47]
    }; // Linux evdev Ctrl, Shift, V; never Enter.
    let mut failure = None;
    for key in &keys {
        if !backend.remote_active.load(Ordering::SeqCst) {
            failure = Some("Wayland: разрешение клавиатуры отозвано. Текст сохранён.".into());
            break;
        }
        if let Err(e) = remote
            .notify_keyboard_keycode(session, *key, KeyState::Pressed, Default::default())
            .await
        {
            failure = Some(error("клавиатура", e));
            break;
        }
    }
    // Release all planned keys, including a press whose D-Bus reply was lost.
    for key in keys.into_iter().rev() {
        if let Err(e) = remote
            .notify_keyboard_keycode(session, key, KeyState::Released, Default::default())
            .await
        {
            failure = Some(error("освобождение клавиш", e));
        }
    }
    if !backend.remote_active.load(Ordering::SeqCst) {
        failure = Some("Wayland: сеанс клавиатуры закрыт. Текст сохранён.".into());
    }
    if let Some(e) = failure {
        if let Some((_, session)) = backend.remote.take() {
            let _ = session.close().await;
        }
        backend.clipboard = None;
        return Err(e);
    }
    Ok(true)
}

pub fn install_gnome_extension() -> Result<String, String> {
    let result = std::process::Command::new("gnome-shell")
        .arg("--version")
        .output()
        .map_err(|e| error("gnome-shell", e))?;
    let version = String::from_utf8_lossy(&result.stdout)
        .split_whitespace()
        .last()
        .unwrap_or_default()
        .split('.')
        .next()
        .unwrap_or_default()
        .to_string();
    let major = version
        .parse::<u32>()
        .map_err(|_| "Не удалось определить версию GNOME Shell")?;
    if major < 45 {
        return Err("Расширение требует GNOME Shell 45 или новее.".into());
    }
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".local/share"))
        })
        .ok_or("Нет HOME/XDG_DATA_HOME")?;
    let directory = data.join("gnome-shell/extensions").join(EXTENSION_ID);
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    std::fs::write(
        directory.join("extension.js"),
        include_str!("../../linux/gnome/extension.js"),
    )
    .map_err(|e| e.to_string())?;
    let metadata = serde_json::json!({"uuid": EXTENSION_ID, "name": "OpenCode Voice Input",
        "description": "Ctrl+Alt+Space и вставка диктовки с проверкой исходного окна", "shell-version": [version], "version": 1});
    std::fs::write(
        directory.join("metadata.json"),
        serde_json::to_vec_pretty(&metadata).unwrap(),
    )
    .map_err(|e| e.to_string())?;
    let _ = std::process::Command::new("gnome-extensions")
        .args(["enable", EXTENSION_ID])
        .status();
    Ok(format!("Расширение установлено: {}. Если GNOME ещё не видит его, выйдите и войдите в сессию, затем выполните gnome-extensions enable {EXTENSION_ID}.", directory.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Clone)]
    struct GnomeFixture {
        focus: Arc<std::sync::Mutex<Focus>>,
        writes: Arc<std::sync::Mutex<Vec<(bool, String)>>>,
    }
    #[zbus::interface(name = "ai.opencode.VoiceOverlay.Focus")]
    impl GnomeFixture {
        fn get_focus(&self) -> String {
            serde_json::to_string(&*self.focus.lock().unwrap()).unwrap()
        }
        fn copy(&self, text: String) -> bool {
            self.writes.lock().unwrap().push((false, text));
            true
        }
        fn paste(&self, expected: String, text: String) -> zbus::fdo::Result<bool> {
            if self.get_focus() != expected {
                return Err(zbus::fdo::Error::Failed("focus changed".into()));
            }
            self.writes.lock().unwrap().push((true, text));
            Ok(true)
        }
    }

    /// A fresh dbus-run-session is mandatory; never substitute the user's desktop bus.
    #[tokio::test]
    #[ignore = "requires ORCHESTRA_WAYLAND_SMOKE=1 in a dedicated dbus-run-session"]
    async fn wayland_gnome_dbus_focus_clipboard_and_toggle() {
        assert_eq!(std::env::var("ORCHESTRA_WAYLAND_SMOKE").as_deref(), Ok("1"));
        std::env::remove_var("SWAYSOCK");
        std::env::remove_var("HYPRLAND_INSTANCE_SIGNATURE");
        std::env::set_var("XDG_CURRENT_DESKTOP", "GNOME");
        let fixture = GnomeFixture {
            focus: Arc::new(std::sync::Mutex::new(Focus {
                backend: "gnome".into(),
                id: "23".into(),
                process: std::process::id() + 1,
                title: "OpenCode 中文".into(),
                app_id: "org.gnome.Terminal".into(),
            })),
            writes: Arc::new(std::sync::Mutex::new(Vec::new())),
        };
        let _shell = zbus::connection::Builder::session()
            .unwrap()
            .name("org.gnome.Shell")
            .unwrap()
            .serve_at(GNOME_PATH, fixture.clone())
            .unwrap()
            .build()
            .await
            .unwrap();
        let (events, mut received) = mpsc::unbounded_channel();
        enable(
            move |target| {
                events.send(target).unwrap();
            },
            |e| panic!("{e}"),
        )
        .await
        .unwrap();
        toggle_existing().await.unwrap();
        let target = tokio::time::timeout(Duration::from_secs(3), received.recv())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(
            paste(Some(target.clone()), "Русский English 中文 🐧".into())
                .await
                .unwrap()
        );
        assert!(!paste(None, "copy only 中文".into()).await.unwrap());
        fixture.focus.lock().unwrap().title = "different tab".into();
        assert!(paste(Some(target.clone()), "must not paste".into())
            .await
            .unwrap_err()
            .contains("изменились"));
        let mut stale = target;
        stale.window = 123;
        assert!(paste(Some(stale), "must not paste".into()).await.is_err());
        assert_eq!(
            *fixture.writes.lock().unwrap(),
            vec![
                (true, "Русский English 中文 🐧".into()),
                (false, "copy only 中文".into())
            ]
        );
    }
}
