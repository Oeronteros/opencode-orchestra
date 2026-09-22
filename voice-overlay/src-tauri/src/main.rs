use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use tokio::sync::{watch, Mutex};
mod browser_bridge;
mod sidecars;
pub use sidecars::sidecar_file;

pub const MAX_SECONDS: u64 = 120;
pub const MIN_WAV_BYTES: u64 = 16000;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
}

#[derive(Debug)]
pub struct Recording {
    pub wav: PathBuf,
    pub child: tokio::process::Child,
    pub folder: tempfile::TempDir,
}

pub struct AppState {
    pub recording: Mutex<Option<Recording>>,
    pub pending: Mutex<Option<tempfile::TempDir>>,
    pub transcription: Mutex<Option<watch::Sender<bool>>>,
    pub app_dir: PathBuf,
}

pub fn append_url(host: &str, port: u16) -> String {
    format!("http://{host}:{port}/tui/append-prompt")
}

pub fn submit_url(host: &str, port: u16) -> String {
    format!("http://{host}:{port}/tui/submit-prompt")
}

pub fn basic_auth_value(username: &str, password: &str) -> Option<String> {
    if username.is_empty() {
        return None;
    }
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    Some(format!(
        "Basic {}",
        STANDARD.encode(format!("{username}:{password}"))
    ))
}

/// Maps HTTP status + server ack to the TS `AppendOutcome` contract.
pub fn append_outcome(status: u16, ack: bool) -> &'static str {
    if status == 401 || status == 403 {
        return "unauthorized";
    }
    if status == 200 && ack {
        return "inserted";
    }
    "fallback"
}

pub fn parse_dshow_devices(stderr: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut rest = stderr;
    while let Some(q1) = rest.find('"') {
        let after_open = &rest[q1 + 1..];
        let Some(q2) = after_open.find('"') else {
            break;
        };
        let name = &after_open[..q2];
        let after_close = &after_open[q2 + 1..];
        if after_close.trim_start().starts_with("(audio)") && !out.iter().any(|n| n == name) {
            out.push(name.to_string());
        }
        rest = after_close;
    }
    out
}

/// Parse `ffmpeg -sources pulse`, excluding sink monitor/loopback sources.
pub fn parse_pulse_sources(output: &str) -> Vec<String> {
    let mut devices = Vec::new();
    for line in output.lines() {
        let entry = line.trim().strip_prefix('*').unwrap_or(line.trim()).trim();
        let Some((name, description)) = entry.split_once(char::is_whitespace) else {
            continue;
        };
        if !description.trim_start().starts_with('[')
            || !description.trim_end().ends_with(')')
            || name.ends_with(".monitor")
            || devices.iter().any(|device| device == name)
        {
            continue;
        }
        devices.push(name.to_string());
    }
    devices
}

pub fn ffmpeg_input_args(os: &str, device: Option<&str>) -> Result<Vec<String>, String> {
    match (os, device) {
        ("linux", d) => Ok(vec![
            "-f".to_string(),
            "pulse".to_string(),
            "-i".to_string(),
            d.unwrap_or("default").to_string(),
        ]),
        (_, Some(d)) => Ok(vec![
            "-f".to_string(),
            "dshow".to_string(),
            "-i".to_string(),
            format!("audio={d}"),
        ]),
        _ => Err("no-mic: выбери микрофон DirectShow в настройках.".to_string()),
    }
}

fn command(program: impl AsRef<std::ffi::OsStr>) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(program);
    command.kill_on_drop(true);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    command
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("server-unreachable: {e}"))
}

fn sidecar_path(app: &AppHandle, base: &str) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("transcribe-failed: {e}"))?;
    let dir = exe
        .parent()
        .ok_or("transcribe-failed: executable directory missing")?;
    sidecars::resolve(base, dir, app.path().resource_dir().ok().as_deref())
}

async fn recording_ffmpeg(app: &AppHandle, needs_pulse: bool) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(path) = sidecar_path(app, "ffmpeg") {
        candidates.push(path);
    }
    candidates.push(PathBuf::from("ffmpeg"));
    let mut details = Vec::new();
    for path in candidates {
        let probe = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            command(&path).args(["-hide_banner", "-devices"]).output(),
        )
        .await;
        match probe {
            Ok(Ok(output)) if output.status.success() => {
                let devices = format!(
                    "{}\n{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
                let input = if needs_pulse {
                    "pulse"
                } else if cfg!(target_os = "windows") {
                    "dshow"
                } else {
                    "lavfi"
                };
                if sidecars::supports_input(&devices, input) {
                    return Ok(path);
                }
                details.push(format!(
                    "{}: нет входа {input}; установи ffmpeg с поддержкой {input}",
                    path.display()
                ));
            }
            Ok(Ok(output)) => details.push(format!(
                "{}: {}",
                path.display(),
                String::from_utf8_lossy(&output.stderr).trim()
            )),
            Ok(Err(error)) => details.push(format!("{}: {error}", path.display())),
            Err(_) => details.push(format!("{}: проверка превысила 5 секунд", path.display())),
        }
    }
    Err(format!("no-ffmpeg: {}", details.join("; ")))
}

#[tauri::command]
async fn health_check(host: String, port: u16) -> Result<bool, String> {
    let resp = http_client()?
        .get(format!("http://{host}:{port}/global/health"))
        .send()
        .await
        .map_err(|e| format!("server-unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("server-unreachable: http {}", resp.status()));
    }
    Ok(true)
}

#[tauri::command]
async fn append_to_prompt(cfg: ServerConfig, text: String) -> Result<bool, String> {
    let mut req = http_client()?
        .post(append_url(&cfg.host, cfg.port))
        .json(&serde_json::json!({ "text": text }));
    if let Some(auth) = basic_auth_value(&cfg.username, &cfg.password) {
        req = req.header("Authorization", auth);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("server-unreachable: {e}"))?;
    let status = resp.status().as_u16();
    if status == 401 || status == 403 {
        return Err("unauthorized: проверь пароль сервера (OPENCODE_SERVER_PASSWORD)".to_string());
    }
    if !resp.status().is_success() {
        return Err(format!("fallback: http {}", resp.status()));
    }
    let ack = resp
        .json::<bool>()
        .await
        .map_err(|e| format!("fallback: {e}"))?;
    if append_outcome(status, ack) != "inserted" {
        return Err("fallback: сервер не подтвердил вставку".to_string());
    }
    Ok(true)
}

#[tauri::command]
async fn submit_prompt(cfg: ServerConfig) -> Result<bool, String> {
    let mut req = http_client()?.post(submit_url(&cfg.host, cfg.port));
    if let Some(auth) = basic_auth_value(&cfg.username, &cfg.password) {
        req = req.header("Authorization", auth);
    }
    let resp = req
        .send()
        .await
        .map_err(|_| "server-unreachable: отправка не подтверждена".to_string())?;
    if !resp.status().is_success() {
        return Err(format!("submit-failed: http {}", resp.status()));
    }
    if !resp.json::<bool>().await.unwrap_or(false) {
        return Err("submit-failed: сервер не подтвердил отправку".to_string());
    }
    Ok(true)
}

#[tauri::command]
async fn list_microphones(app: AppHandle) -> Result<Vec<String>, String> {
    if std::env::consts::OS != "windows" && std::env::consts::OS != "linux" {
        return Ok(Vec::new());
    }
    let linux = std::env::consts::OS == "linux";
    let ffmpeg = recording_ffmpeg(&app, linux).await?;
    let args: &[&str] = if linux {
        &["-hide_banner", "-sources", "pulse"]
    } else {
        &["-list_devices", "true", "-f", "dshow", "-i", "dummy"]
    };
    let out = tokio::time::timeout(Duration::from_secs(5), command(ffmpeg).args(args).output())
        .await
        .map_err(|_| "no-mic: превышено время поиска микрофонов".to_string())?
        .map_err(|e| format!("no-mic: {e}"))?;
    let output = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let devices = if linux {
        parse_pulse_sources(&output)
    } else {
        parse_dshow_devices(&output)
    };
    if devices.is_empty() {
        return Err(
            "no-mic: микрофон не найден. Подключи устройство и попробуй снова.".to_string(),
        );
    }
    Ok(devices)
}

#[tauri::command]
async fn start_recording(
    app: AppHandle,
    state: State<'_, AppState>,
    device: Option<String>,
    model: String,
) -> Result<bool, String> {
    // Hold the async lock through initialization so two starts cannot open the mic.
    let mut slot = state.recording.lock().await;
    let transcribing = state.transcription.lock().await.is_some();
    let pending = state.pending.lock().await.is_some();
    if slot.is_some() || pending || transcribing {
        return Err("busy: предыдущая запись ещё обрабатывается".to_string());
    }
    model_path(&app, &model)?;
    sidecar_path(&app, "whisper")?;
    let device = if cfg!(target_os = "windows")
        && device.as_deref().unwrap_or("").is_empty()
        && std::env::var("VOICE_FFMPEG_TEST_INPUT").is_err()
    {
        Some(
            list_microphones(app.clone())
                .await?
                .into_iter()
                .next()
                .ok_or("no-mic: микрофон не найден")?,
        )
    } else {
        device
    };
    std::fs::create_dir_all(&state.app_dir)
        .map_err(|e| format!("transcribe-failed: нет доступа к каталогу данных: {e}"))?;
    let folder = tempfile::Builder::new()
        .prefix("record-")
        .tempdir_in(&state.app_dir)
        .map_err(|e| format!("transcribe-failed: {e}"))?;
    let wav = folder.path().join("audio.wav");
    let mut args = if let Ok(test_input) = std::env::var("VOICE_FFMPEG_TEST_INPUT") {
        vec![
            "-f".to_string(),
            "lavfi".to_string(),
            "-i".to_string(),
            test_input,
        ]
    } else {
        ffmpeg_input_args(std::env::consts::OS, device.as_deref())?
    };
    args.extend(
        [
            "-t",
            "120",
            "-ar",
            "16000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            "-y",
        ]
        .into_iter()
        .map(str::to_string),
    );
    args.push(wav.to_string_lossy().into_owned());
    let needs_pulse =
        std::env::consts::OS == "linux" && std::env::var("VOICE_FFMPEG_TEST_INPUT").is_err();
    let ffmpeg = recording_ffmpeg(&app, needs_pulse).await?;
    let stderr_file = std::fs::File::create(wav.with_extension("stderr"))
        .map_err(|e| format!("no-ffmpeg: {e}"))?;
    let mut child = command(ffmpeg)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr_file))
        .spawn()
        .map_err(|e| format!("no-ffmpeg: не удалось запустить ffmpeg: {e}"))?;
    // Report failed audio-device initialization instead of pretending to record.
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    if let Some(exit) = child.try_wait().map_err(|e| format!("no-mic: {e}"))? {
        if !exit.success() {
            let detail = std::fs::read_to_string(wav.with_extension("stderr")).unwrap_or_default();
            return Err(format!(
                "{}: {}",
                if needs_pulse {
                    "no-audio-server"
                } else {
                    "no-mic"
                },
                detail.trim()
            ));
        }
    }
    // FFmpeg owns the duration limit and finalizes the WAV itself (-t).
    *slot = Some(Recording { wav, child, folder });
    Ok(true)
}

#[tauri::command]
async fn stop_recording(state: State<'_, AppState>) -> Result<String, String> {
    let mut slot = state.recording.lock().await;
    let mut rec = slot
        .take()
        .ok_or_else(|| "idle: запись не запущена".to_string())?;
    let finished = tokio::time::timeout(Duration::from_secs(5), async {
        if let Some(mut stdin) = rec.child.stdin.take() {
            use tokio::io::AsyncWriteExt as _;
            let _ = stdin.write_all(b"q\n").await;
            let _ = stdin.shutdown().await;
        }
        rec.child.wait().await
    })
    .await;
    if finished.is_err() {
        let _ = rec.child.kill().await;
        let _ = rec.child.wait().await;
        return Err(
            "empty-recording: ffmpeg не завершил запись вовремя. Попробуй снова.".to_string(),
        );
    }
    let exit = finished.unwrap().map_err(|e| format!("no-mic: {e}"))?;
    if !exit.success() {
        let detail = std::fs::read_to_string(rec.wav.with_extension("stderr")).unwrap_or_default();
        return Err(format!("no-mic: {}", detail.trim()));
    }
    let size = std::fs::metadata(&rec.wav).map(|m| m.len()).unwrap_or(0);
    if size < MIN_WAV_BYTES {
        return Err("empty-recording: запись пустая (короче полсекунды). Нажми Record, дождись и потом Stop.".to_string());
    }
    *state.pending.lock().await = Some(rec.folder);
    Ok(rec.wav.to_string_lossy().into_owned())
}

pub fn allowed_model_file(model: &str) -> Result<String, String> {
    match model {
        "base" => Ok("ggml-base.bin".to_string()),
        "small" => Ok("ggml-small.bin".to_string()),
        _ => Err("transcribe-failed: неизвестная модель. Выбери base или small.".to_string()),
    }
}

fn model_path(app: &AppHandle, model: &str) -> Result<PathBuf, String> {
    let file = allowed_model_file(model)?;
    let model_path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("model-missing: {e}"))?
        .join("models")
        .join(&file);
    if !model_path.is_file() {
        return Err(format!("model-missing: нет {}. Для base запусти opencode-orchestra install; для small см. инструкцию в voice-overlay/README.md.", model_path.display()));
    }
    Ok(model_path)
}

#[tauri::command]
async fn cancel_transcription(state: State<'_, AppState>) -> Result<(), String> {
    // Keep the slot occupied until the process has actually exited.
    let slot = state.transcription.lock().await;
    if let Some(sender) = slot.as_ref() {
        let _ = sender.send(true);
    }
    Ok(())
}

#[tauri::command]
async fn transcribe(
    app: AppHandle,
    state: State<'_, AppState>,
    wav: String,
    model: String,
) -> Result<String, String> {
    let mut slot = state.transcription.lock().await;
    if slot.is_some() {
        return Err("busy: распознавание уже выполняется".to_string());
    }
    let mut pending = state.pending.lock().await;
    if pending
        .as_ref()
        .map(|folder| folder.path().join("audio.wav"))
        != Some(PathBuf::from(&wav))
    {
        return Err("transcribe-failed: неизвестная запись".to_string());
    }
    let folder = pending.take().unwrap();
    drop(pending);
    let (sender, receiver) = watch::channel(false);
    *slot = Some(sender);
    drop(slot);
    let result = transcribe_file(&app, &wav, &model, receiver).await;
    // The process has exited before TempDir removes WAV, stderr and transcript.
    drop(folder);
    *state.transcription.lock().await = None;
    result
}

async fn transcribe_file(
    app: &AppHandle,
    wav: &str,
    model: &str,
    mut cancel: watch::Receiver<bool>,
) -> Result<String, String> {
    let model_path = model_path(app, model)?;
    let whisper = sidecar_path(app, "whisper")?;
    let out_base = format!("{wav}.out");
    let args = vec![
        "-m".to_string(),
        model_path.to_string_lossy().into_owned(),
        "-l".to_string(),
        "ru".to_string(),
        "-f".to_string(),
        wav.to_string(),
        "-otxt".to_string(),
        "-of".to_string(),
        out_base.clone(),
    ];
    // Redirect output to files: wait() must not deadlock on full stderr pipes.
    let stderr = std::fs::File::create(format!("{wav}.whisper.stderr"))
        .map_err(|e| format!("transcribe-failed: {e}"))?;
    let mut child = command(whisper)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(stderr)
        .spawn()
        .map_err(|e| format!("transcribe-failed: не удалось запустить whisper: {e}"))?;
    let status = tokio::select! {
        status = child.wait() => status.map_err(|e| format!("transcribe-failed: {e}"))?,
        _ = cancel.changed() => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err("cancelled: распознавание отменено".to_string());
        }
        _ = tokio::time::sleep(Duration::from_secs(600)) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err("transcribe-failed: превышено время ожидания распознавания".to_string());
        }
    };
    if !status.success() {
        return Err(format!(
            "transcribe-failed: whisper завершился с кодом {}",
            status.code().unwrap_or(-1)
        ));
    }
    let text = std::fs::read_to_string(format!("{out_base}.txt"))
        .map_err(|e| format!("transcribe-failed: нет результата: {e}"))?
        .trim()
        .to_string();
    if text.is_empty() {
        return Err(
            "empty-transcript: речь не распознана. Попробуй говорить громче и ближе к микрофону."
                .to_string(),
        );
    }
    Ok(text)
}

pub fn session_url(host: &str, port: u16) -> String {
    format!("http://{host}:{port}/experimental/session?roots=true&limit=1000")
}

// NOTE: `session_id` is inserted raw — the TS side `encodeURIComponent`s it
// in `sessionMessageRequest` before invoking `send_to_session`.
pub fn message_url(host: &str, port: u16, session_id: &str) -> String {
    format!("http://{host}:{port}/session/{session_id}/prompt_async")
}

pub fn send_outcome(status: u16) -> &'static str {
    if status == 401 || status == 403 {
        return "unauthorized";
    }
    if status == 404 {
        return "session-not-found";
    }
    if (200..300).contains(&status) {
        return "sent";
    }
    "fallback"
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub title: String,
    pub directory: Option<String>,
}

#[tauri::command]
async fn list_sessions(cfg: ServerConfig) -> Result<Vec<SessionInfo>, String> {
    let mut req = http_client()?.get(session_url(&cfg.host, cfg.port));
    if let Some(auth) = basic_auth_value(&cfg.username, &cfg.password) {
        req = req.header("Authorization", auth);
    }
    let mut resp = req
        .send()
        .await
        .map_err(|e| format!("server-unreachable: {e}"))?;
    // Older servers do not expose the cross-project session API.
    if resp.status().as_u16() == 404 {
        let mut req = http_client()?.get(format!(
            "http://{}:{}/session?roots=true&limit=1000",
            cfg.host, cfg.port
        ));
        if let Some(auth) = basic_auth_value(&cfg.username, &cfg.password) {
            req = req.header("Authorization", auth);
        }
        resp = req
            .send()
            .await
            .map_err(|e| format!("server-unreachable: {e}"))?;
    }
    let status = resp.status().as_u16();
    if status == 401 || status == 403 {
        return Err("unauthorized: проверь пароль сервера (OPENCODE_SERVER_PASSWORD)".to_string());
    }
    if !resp.status().is_success() {
        return Err(format!("fallback: http {}", resp.status()));
    }
    let mut items = resp
        .json::<Vec<serde_json::Value>>()
        .await
        .map_err(|e| format!("fallback: {e}"))?;
    items.sort_by_key(|item| {
        std::cmp::Reverse(
            item.pointer("/time/updated")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
        )
    });
    let mut out: Vec<SessionInfo> = Vec::new();
    for item in &items {
        if item
            .get("parentID")
            .and_then(|v| v.as_str())
            .is_some_and(|id| !id.is_empty())
            || item
                .pointer("/time/archived")
                .and_then(|v| v.as_u64())
                .is_some_and(|time| time > 0)
        {
            continue;
        }
        let Some(id) = item.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        if id.is_empty() || out.iter().any(|s: &SessionInfo| s.id == id) {
            continue;
        }
        let title = item
            .get("title")
            .and_then(|v| v.as_str())
            .filter(|t| !t.is_empty())
            .unwrap_or(id)
            .to_string();
        out.push(SessionInfo {
            id: id.to_string(),
            title,
            directory: item
                .get("directory")
                .and_then(|v| v.as_str())
                .map(str::to_string),
        });
    }
    Ok(out)
}

#[tauri::command]
async fn send_to_session(
    cfg: ServerConfig,
    session_id: String,
    text: String,
) -> Result<bool, String> {
    if session_id.is_empty() {
        return Err("session-not-found: выбери сессию в настройках.".to_string());
    }
    // Resolve afresh, including when the selection was restored from settings.
    // Session lookup is global; prompt execution needs the session's directory.
    let mut lookup = http_client()?.get(format!(
        "http://{}:{}/session/{}",
        cfg.host, cfg.port, session_id
    ));
    if let Some(auth) = basic_auth_value(&cfg.username, &cfg.password) {
        lookup = lookup.header("Authorization", auth);
    }
    let response = lookup
        .send()
        .await
        .map_err(|e| format!("server-unreachable: {e}"))?;
    match send_outcome(response.status().as_u16()) {
        "unauthorized" => return Err("unauthorized: проверь пароль сервера".to_string()),
        "session-not-found" => return Err("session-not-found: обнови список сессий".to_string()),
        "sent" => {}
        _ => return Err(format!("fallback: http {}", response.status())),
    }
    let session: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("fallback: {e}"))?;
    let directory = session
        .get("directory")
        .and_then(|v| v.as_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "fallback: сервер не вернул каталог сессии".to_string())?;
    let mut req = http_client()?
        .post(message_url(&cfg.host, cfg.port, &session_id))
        .query(&[("directory", directory)])
        .json(&serde_json::json!({ "parts": [{ "type": "text", "text": text }] }));
    if let Some(auth) = basic_auth_value(&cfg.username, &cfg.password) {
        req = req.header("Authorization", auth);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("server-unreachable: {e}"))?;
    let status = resp.status().as_u16();
    if send_outcome(status) != "sent" {
        if status == 401 || status == 403 {
            return Err(
                "unauthorized: проверь пароль сервера (OPENCODE_SERVER_PASSWORD)".to_string(),
            );
        }
        if status == 404 {
            return Err(
                "session-not-found: сессия не найдена (удалена?). Обнови список и выбери снова."
                    .to_string(),
            );
        }
        return Err(format!("fallback: http {}", resp.status()));
    }
    Ok(true)
}

fn main() {
    // This small overlay needs no DMA-BUF acceleration. Avoid broken GPU paths
    // on WSL/VMs, while honoring an explicit user override. Set before threads.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    tauri::Builder::default()
        .setup(|app| {
            let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            app.manage(AppState {
                recording: Mutex::new(None),
                pending: Mutex::new(None),
                transcription: Mutex::new(None),
                app_dir,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            browser_bridge::browser_target,
            browser_bridge::insert_in_browser,
            health_check,
            append_to_prompt,
            submit_prompt,
            list_microphones,
            start_recording,
            stop_recording,
            transcribe,
            cancel_transcription,
            list_sessions,
            send_to_session
        ])
        .run(tauri::generate_context!())
        .expect("voice-overlay failed to run");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session_server(
        responses: Vec<(&'static str, u16, &'static str)>,
    ) -> (ServerConfig, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            for (route, status, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                loop {
                    let mut buf = [0; 4096];
                    let count = stream.read(&mut buf).unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&buf[..count]);
                    if request.windows(4).any(|part| part == b"\r\n\r\n") {
                        break;
                    }
                }
                let request = String::from_utf8_lossy(&request);
                assert!(request.starts_with(route), "{request}");
                assert!(request
                    .to_ascii_lowercase()
                    .contains("authorization: basic"));
                write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        (
            ServerConfig {
                host: "127.0.0.1".into(),
                port,
                username: "test".into(),
                password: "test".into(),
            },
            server,
        )
    }

    #[tokio::test]
    async fn discovers_recent_root_sessions_across_projects() {
        let (cfg, server) = session_server(vec![(
            "GET /experimental/session?roots=true&limit=1000 ",
            200,
            r#"[{"id":"old","directory":"/home/oe","time":{"updated":1}},
                {"id":"child","parentID":"new","time":{"updated":5}},
                {"id":"archived","time":{"updated":4,"archived":4}},
                {"id":"new","title":"Current project","directory":"/project","time":{"updated":3}},
                {"id":"new","time":{"updated":2}},{"title":"invalid"}]"#,
        )]);
        let sessions = list_sessions(cfg).await.unwrap();
        server.join().unwrap();
        assert_eq!(
            sessions.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            vec!["new", "old"]
        );
        assert_eq!(sessions[0].directory.as_deref(), Some("/project"));
        assert_eq!(sessions[0].title, "Current project");
        assert_eq!(sessions[1].title, "old");
    }

    #[tokio::test]
    async fn legacy_session_api_fallback_preserves_auth() {
        let (cfg, server) = session_server(vec![
            (
                "GET /experimental/session?roots=true&limit=1000 ",
                404,
                "{}",
            ),
            (
                "GET /session?roots=true&limit=1000 ",
                200,
                r#"[{"id":"legacy"}]"#,
            ),
        ]);
        assert_eq!(list_sessions(cfg).await.unwrap()[0].id, "legacy");
        server.join().unwrap();
    }

    #[tokio::test]
    async fn session_auth_failure_is_not_hidden_by_fallback() {
        let (cfg, server) = session_server(vec![(
            "GET /experimental/session?roots=true&limit=1000 ",
            401,
            "{}",
        )]);
        assert!(list_sessions(cfg)
            .await
            .unwrap_err()
            .starts_with("unauthorized:"));
        server.join().unwrap();
    }

    #[tokio::test]
    async fn sends_in_selected_session_directory() {
        let (cfg, server) = session_server(vec![
            (
                "GET /session/ses_project ",
                200,
                r#"{"directory":"/project with spaces"}"#,
            ),
            (
                "POST /session/ses_project/prompt_async?directory=%2Fproject+with+spaces ",
                204,
                "",
            ),
        ]);
        assert!(send_to_session(cfg, "ses_project".into(), "hello".into())
            .await
            .unwrap());
        server.join().unwrap();
    }

    #[tokio::test]
    async fn missing_session_directory_prevents_wrong_project_send() {
        let (cfg, server) = session_server(vec![("GET /session/ses_project ", 200, "{}")]);
        assert!(send_to_session(cfg, "ses_project".into(), "hello".into())
            .await
            .is_err());
        server.join().unwrap();
    }

    #[test]
    fn url_matches_live_verified_contract() {
        assert_eq!(
            append_url("127.0.0.1", 4096),
            "http://127.0.0.1:4096/tui/append-prompt"
        );
        assert_eq!(
            submit_url("127.0.0.1", 4096),
            "http://127.0.0.1:4096/tui/submit-prompt"
        );
    }

    #[tokio::test]
    async fn tui_submission_checks_server_acknowledgement() {
        use std::io::{Read, Write};
        for (body, expected) in [("true", true), ("false", false)] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = [0; 4096];
                let size = stream.read(&mut request).unwrap();
                let request = String::from_utf8_lossy(&request[..size]).to_ascii_lowercase();
                assert!(request.starts_with("post /tui/submit-prompt "));
                assert!(request.contains("authorization: basic"));
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            });
            let cfg = ServerConfig {
                host: "127.0.0.1".into(),
                port,
                username: "test".into(),
                password: "test".into(),
            };
            assert_eq!(submit_prompt(cfg).await.is_ok(), expected);
            server.join().unwrap();
        }
    }

    #[test]
    fn basic_auth_encodes_user_pass() {
        assert_eq!(
            basic_auth_value("opencode", "s3cret"),
            Some("Basic b3BlbmNvZGU6czNjcmV0".to_string())
        );
        assert_eq!(basic_auth_value("", "x"), None);
    }

    #[test]
    fn outcome_mirrors_ts_contract() {
        assert_eq!(append_outcome(200, true), "inserted");
        assert_eq!(append_outcome(401, false), "unauthorized");
        assert_eq!(append_outcome(403, true), "unauthorized");
        assert_eq!(append_outcome(500, false), "fallback");
        assert_eq!(append_outcome(200, false), "fallback");
        assert_eq!(append_outcome(0, false), "fallback");
    }

    #[test]
    fn dshow_parser_mirrors_ts() {
        let sample = "[dshow @ 0x123] DirectShow audio devices\n[dshow @ 0x123]  \"Microphone (Realtek Audio)\" (audio)\n[dshow @ 0x123]  \"Integrated Camera\" (video)\n";
        assert_eq!(
            parse_dshow_devices(sample),
            vec!["Microphone (Realtek Audio)".to_string()]
        );
        assert!(parse_dshow_devices("dummy").is_empty());
    }

    #[test]
    fn pulse_parser_lists_inputs_but_not_sink_monitors() {
        let sample = "Auto-detected sources for pulse:\n  RDPSink.monitor [Monitor of RDP Sink] (none)\n* RDPSource [RDP Source] (none)\n  alsa_input.usb-GK50 [GK50 microphone] (none)\n";
        assert_eq!(
            parse_pulse_sources(sample),
            vec!["RDPSource".to_string(), "alsa_input.usb-GK50".to_string()]
        );
    }

    #[test]
    fn ffmpeg_args_mirror_ts() {
        assert_eq!(
            ffmpeg_input_args("linux", None).unwrap(),
            vec!["-f", "pulse", "-i", "default"]
        );
        assert_eq!(
            ffmpeg_input_args("windows", Some("Mic")).unwrap(),
            vec!["-f", "dshow", "-i", "audio=Mic"]
        );
        assert!(ffmpeg_input_args("windows", None)
            .unwrap_err()
            .starts_with("no-mic:"));
    }

    #[test]
    fn sidecar_name_carries_base_and_triple() {
        let name = sidecar_file("binaries/ffmpeg").unwrap();
        assert!(name.starts_with("binaries/ffmpeg-"), "{name}");
    }

    #[test]
    fn model_allowlist_maps_to_ggml_files() {
        assert_eq!(allowed_model_file("base"), Ok("ggml-base.bin".to_string()));
        assert_eq!(
            allowed_model_file("small"),
            Ok("ggml-small.bin".to_string())
        );
        assert!(allowed_model_file("../../etc/passwd").is_err());
        assert!(allowed_model_file("large").is_err());
    }

    #[test]
    fn session_urls_match_docs_contract() {
        assert_eq!(
            session_url("127.0.0.1", 4096),
            "http://127.0.0.1:4096/experimental/session?roots=true&limit=1000"
        );
        assert_eq!(
            message_url("127.0.0.1", 4096, "ses_123"),
            "http://127.0.0.1:4096/session/ses_123/prompt_async"
        );
    }

    #[test]
    fn send_outcome_mirrors_ts_contract() {
        assert_eq!(send_outcome(204), "sent");
        assert_eq!(send_outcome(200), "sent");
        assert_eq!(send_outcome(401), "unauthorized");
        assert_eq!(send_outcome(404), "session-not-found");
        assert_eq!(send_outcome(500), "fallback");
    }
}
