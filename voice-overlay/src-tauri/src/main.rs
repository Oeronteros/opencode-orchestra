use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{watch, Mutex};
mod audio;
mod browser_bridge;
mod native_input;
mod window_attachment;
mod sidecars;
mod whisper_server;
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
    pub model: String,
    pub language: String,
    pub chunks: Arc<Mutex<Vec<String>>>,
    pub consumed: Arc<AtomicU64>,
    pub pump_cancel: watch::Sender<bool>,
    pub pump: tokio::task::JoinHandle<()>,
}

/// Completed recording handed from `stop_recording` to `transcribe`, together
/// with any segments already recognized while the user was speaking.
#[derive(Debug)]
pub struct PendingVoice {
    pub folder: tempfile::TempDir,
    pub model: String,
    pub language: String,
    pub chunks: Vec<String>,
    pub consumed: u64,
}

pub struct AppState {
    pub recording: Mutex<Option<Recording>>,
    pub pending: Mutex<Option<PendingVoice>>,
    pub transcription: Mutex<Option<watch::Sender<bool>>>,
    pub whisper: Mutex<Option<whisper_server::WhisperServer>>,
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

/// Bounded explicit thread override for local whisper inference.
pub fn thread_override(value: Option<&str>) -> Option<usize> {
    let raw = value?.trim();
    if raw.is_empty() {
        return None;
    }
    let parsed: usize = raw.parse().ok()?;
    (1..=128).contains(&parsed).then_some(parsed)
}

/// whisper.cpp defaults to `min(4, logical cores)`; use the physical cores
/// instead so SMT does not slow the encoder down.
pub fn voice_threads() -> usize {
    if let Some(threads) = thread_override(std::env::var("ORCHESTRA_VOICE_THREADS").ok().as_deref()) {
        return threads;
    }
    num_cpus::get_physical().max(1)
}

pub fn parse_accelerator(value: Option<&str>) -> Option<String> {
    match value?.trim() {
        "auto" | "cpu" | "cuda" | "cuda11" | "vulkan" => Some(value?.trim().to_string()),
        _ => None,
    }
}

fn accelerator_preference(app: &AppHandle) -> String {
    if let Some(valid) = parse_accelerator(std::env::var("ORCHESTRA_VOICE_ACCEL").ok().as_deref()) {
        return valid;
    }
    if let Ok(dir) = app.path().app_data_dir() {
        if let Ok(text) = std::fs::read_to_string(dir.join("accelerator.json")) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(valid) = parse_accelerator(json.get("accelerator").and_then(|value| value.as_str())) {
                    return valid;
                }
            }
        }
    }
    "auto".to_string()
}

/// Resolves the optional warm server: accelerator subdirectories first, then
/// the CPU root layout. `None` means "fall back to the one-shot CLI".
fn whisper_server_path(app: &AppHandle) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.to_path_buf();
    let resource = app.path().resource_dir().ok();
    let preference = accelerator_preference(app);
    let accel_dirs: Vec<&str> = match preference.as_str() {
        "auto" => vec!["cuda", "cuda11", "vulkan"],
        "cpu" => Vec::new(),
        other => vec![other],
    };
    for accel in accel_dirs {
        if let Some(path) = sidecars::find("whisper-server", &dir.join(accel), None) {
            return Some(path);
        }
    }
    sidecars::find("whisper-server", &dir, resource.as_deref())
}

/// Reads a data-relative byte range from the WAV being recorded.
async fn read_range(path: &Path, start: u64, end: u64) -> std::io::Result<Vec<u8>> {
    use tokio::io::{AsyncReadExt as _, AsyncSeekExt as _};
    let mut file = tokio::fs::File::open(path).await?;
    file.seek(std::io::SeekFrom::Start(audio::WAV_HEADER_BYTES as u64 + start))
        .await?;
    let mut buffer = vec![0u8; (end - start) as usize];
    file.read_exact(&mut buffer).await?;
    Ok(buffer)
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

/// Recognizes completed 30 s segments while the user is still speaking, so
/// only the tail is left after Stop. `consumed` advances only after a segment
/// was transcribed successfully; interrupted work is retried as the tail.
fn spawn_progressive(
    app: &AppHandle,
    wav: PathBuf,
    model: String,
    language: String,
    chunks: Arc<Mutex<Vec<String>>>,
    consumed: Arc<AtomicU64>,
    mut cancel: watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    let app = app.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel.changed() => break,
                _ = tokio::time::sleep(Duration::from_millis(1500)) => {}
            }
            let Ok(metadata) = tokio::fs::metadata(&wav).await else {
                continue;
            };
            let available = metadata.len().saturating_sub(audio::WAV_HEADER_BYTES as u64);
            let start = consumed.load(Ordering::SeqCst);
            let end = start + audio::SEGMENT_BYTES as u64;
            if available < end {
                continue;
            }
            let Ok(pcm) = read_range(&wav, start, end).await else {
                // ffmpeg has not flushed the segment yet; retry next tick.
                continue;
            };
            let segment = audio::wrap_pcm_as_wav(&pcm);
            match transcribe_bytes(&app, &segment, &model, &language, cancel.clone()).await {
                Ok(text) => {
                    if !text.is_empty() {
                        let mut guard = chunks.lock().await;
                        guard.push(text);
                        let _ = app.emit("voice-partial", audio::merge_segments(&guard, ""));
                    }
                    consumed.store(end, Ordering::SeqCst);
                }
                Err(error) => {
                    if error.starts_with("cancelled:") {
                        break;
                    }
                    // Keep the bytes pending: stop_recording retries them as
                    // the tail instead of losing speech.
                    eprintln!("voice-overlay: segment transcription failed: {error}");
                    break;
                }
            }
        }
    })
}

#[tauri::command]
async fn start_recording(
    app: AppHandle,
    state: State<'_, AppState>,
    device: Option<String>,
    model: String,
    language: Option<String>,
) -> Result<bool, String> {
    // Hold the async lock through initialization so two starts cannot open the mic.
    let mut slot = state.recording.lock().await;
    let transcribing = state.transcription.lock().await.is_some();
    let pending = state.pending.lock().await.is_some();
    if slot.is_some() || pending || transcribing {
        return Err("busy: предыдущая запись ещё обрабатывается".to_string());
    }
    model_path(&app, &model)?;
    let language = allowed_language(language.as_deref().unwrap_or("ru"))?.to_string();
    // The warm server replaces the one-shot CLI when installed; keep requiring
    // a whisper binary of either kind so older installs still work.
    if whisper_server_path(&app).is_none() {
        sidecar_path(&app, "whisper")?;
    }
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
    let chunks: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let consumed = Arc::new(AtomicU64::new(0));
    let (pump_cancel, pump_cancel_rx) = watch::channel(false);
    let pump = spawn_progressive(
        &app,
        wav.clone(),
        model.clone(),
        language.clone(),
        chunks.clone(),
        consumed.clone(),
        pump_cancel_rx,
    );
    // Report failed audio-device initialization instead of pretending to record.
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    if let Some(exit) = child.try_wait().map_err(|e| format!("no-mic: {e}"))? {
        if !exit.success() {
            let _ = pump_cancel.send(true);
            pump.abort();
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
    *slot = Some(Recording {
        wav,
        child,
        folder,
        model,
        language,
        chunks,
        consumed,
        pump_cancel,
        pump,
    });
    Ok(true)
}

#[tauri::command]
async fn stop_recording(state: State<'_, AppState>) -> Result<String, String> {
    let mut slot = state.recording.lock().await;
    let mut rec = slot
        .take()
        .ok_or_else(|| "idle: запись не запущена".to_string())?;
    // No more audio will be appended: stop progressive work first. A segment
    // that was interrupted stays pending because `consumed` only advances on
    // success, and it will be retried as the tail below.
    let _ = rec.pump_cancel.send(true);
    rec.pump.abort();
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
    let _ = rec.pump.await;
    let chunks = rec.chunks.lock().await.clone();
    let consumed = rec.consumed.load(Ordering::SeqCst);
    *state.pending.lock().await = Some(PendingVoice {
        folder: rec.folder,
        model: rec.model.clone(),
        language: rec.language.clone(),
        chunks,
        consumed,
    });
    Ok(rec.wav.to_string_lossy().into_owned())
}

pub fn allowed_model_file(model: &str) -> Result<String, String> {
    match model {
        "base" => Ok("ggml-base.bin".to_string()),
        "small" => Ok("ggml-small.bin".to_string()),
        "large-v3-turbo-q5_0" => Ok("ggml-large-v3-turbo-q5_0.bin".to_string()),
        _ => Err(
            "transcribe-failed: неизвестная модель. Выбери base, small или large-v3-turbo-q5_0."
                .to_string(),
        ),
    }
}

pub fn allowed_language(language: &str) -> Result<&str, String> {
    match language {
        "ru" | "en" | "zh" | "auto" => Ok(language),
        _ => Err("transcribe-failed: неизвестный язык. Выбери ru, en, zh или auto.".to_string()),
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
        return Err(format!(
            "model-missing: нет {}. Запусти opencode-orchestra voice-model {model}.",
            model_path.display()
        ));
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
    language: Option<String>,
) -> Result<String, String> {
    allowed_language(language.as_deref().unwrap_or("ru"))?;
    allowed_model_file(&model)?;
    let mut slot = state.transcription.lock().await;
    if slot.is_some() {
        return Err("busy: распознавание уже выполняется".to_string());
    }
    let mut pending = state.pending.lock().await;
    if pending
        .as_ref()
        .map(|voice| voice.folder.path().join("audio.wav"))
        != Some(PathBuf::from(&wav))
    {
        return Err("transcribe-failed: неизвестная запись".to_string());
    }
    let voice = pending.take().unwrap();
    drop(pending);
    let (sender, receiver) = watch::channel(false);
    *slot = Some(sender);
    drop(slot);
    let result = transcribe_pending(&app, &voice, receiver).await;
    // The process has exited before TempDir removes WAV, stderr and transcript.
    drop(voice);
    *state.transcription.lock().await = None;
    result
}

/// Transcribes what is left: recognized progressive segments plus the tail.
async fn transcribe_pending(
    app: &AppHandle,
    voice: &PendingVoice,
    cancel: watch::Receiver<bool>,
) -> Result<String, String> {
    let wav = voice.folder.path().join("audio.wav");
    let bytes = tokio::fs::read(&wav)
        .await
        .map_err(|e| format!("transcribe-failed: {e}"))?;
    if voice.consumed == 0 && voice.chunks.is_empty() {
        let text = transcribe_bytes(app, &bytes, &voice.model, &voice.language, cancel).await?;
        if text.is_empty() {
            return Err(
                "empty-transcript: речь не распознана. Попробуй говорить громче и ближе к микрофону."
                    .to_string(),
            );
        }
        return Ok(text);
    }
    let tail = match audio::parse_pcm_wav(&bytes) {
        Some((_, data_bytes)) => {
            let from = (voice.consumed as usize).min(data_bytes) & !1;
            let to = data_bytes & !1;
            if to > from {
                audio::slice_wav(&bytes, from, to)
            } else {
                Vec::new()
            }
        }
        None => Vec::new(),
    };
    let tail_text = if tail.len() > audio::WAV_HEADER_BYTES {
        transcribe_bytes(app, &tail, &voice.model, &voice.language, cancel).await?
    } else {
        String::new()
    };
    let text = audio::merge_segments(&voice.chunks, &tail_text);
    if text.is_empty() {
        return Err(
            "empty-transcript: речь не распознана. Попробуй говорить громче и ближе к микрофону."
                .to_string(),
        );
    }
    Ok(text)
}

/// Trims silence, then prefers the warm whisper-server and falls back to the
/// one-shot CLI with an explicit physical-core thread count.
async fn transcribe_bytes(
    app: &AppHandle,
    wav: &[u8],
    model: &str,
    language: &str,
    cancel: watch::Receiver<bool>,
) -> Result<String, String> {
    let model_path = model_path(app, model)?;
    let trimmed = audio::trim_silence(wav);
    if let Some(server) = whisper_server_path(app) {
        return transcribe_via_server(app, &server, &model_path, trimmed, language, cancel).await;
    }
    transcribe_via_cli(app, &trimmed, &model_path, language, cancel).await
}

async fn transcribe_via_cli(
    app: &AppHandle,
    wav: &[u8],
    model_path: &Path,
    language: &str,
    mut cancel: watch::Receiver<bool>,
) -> Result<String, String> {
    let whisper = sidecar_path(app, "whisper")?;
    let state = app.state::<AppState>();
    let folder = tempfile::Builder::new()
        .prefix("transcribe-")
        .tempdir_in(&state.app_dir)
        .map_err(|e| format!("transcribe-failed: {e}"))?;
    let file = folder.path().join("audio.wav");
    tokio::fs::write(&file, wav)
        .await
        .map_err(|e| format!("transcribe-failed: {e}"))?;
    let out_base = folder.path().join("result");
    let args = vec![
        "-m".to_string(),
        model_path.to_string_lossy().into_owned(),
        "-l".to_string(),
        language.to_string(),
        "-f".to_string(),
        file.to_string_lossy().into_owned(),
        "-otxt".to_string(),
        "-of".to_string(),
        out_base.to_string_lossy().into_owned(),
        "-t".to_string(),
        voice_threads().to_string(),
    ];
    let mut child = command(whisper)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
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
    let text = std::fs::read_to_string(format!("{}.txt", out_base.to_string_lossy()))
        .map_err(|e| format!("transcribe-failed: нет результата: {e}"))?
        .trim()
        .to_string();
    Ok(text)
}

async fn transcribe_via_server(
    app: &AppHandle,
    server_path: &Path,
    model_path: &Path,
    wav: Vec<u8>,
    language: &str,
    mut cancel: watch::Receiver<bool>,
) -> Result<String, String> {
    let state = app.state::<AppState>();
    let mut guard = state.whisper.lock().await;
    let needs_restart = guard
        .as_ref()
        .map(|server| server.model() != model_path)
        .unwrap_or(true);
    if needs_restart {
        if let Some(mut previous) = guard.take() {
            previous.kill().await;
        }
        let threads = voice_threads();
        *guard = Some(whisper_server::WhisperServer::start(server_path, model_path, threads).await?);
    }
    let mut cancelled = false;
    let result = {
        let server = guard
            .as_mut()
            .ok_or_else(|| "transcribe-failed: whisper-server недоступен".to_string())?;
        tokio::select! {
            result = server.transcribe(&wav, language) => result,
            _ = cancel.changed() => {
                cancelled = true;
                Err("cancelled: распознавание отменено".to_string())
            }
        }
    };
    if cancelled {
        // The server may still be busy with the aborted request; restart it
        // for the next dictation instead of queueing behind dead work.
        if let Some(mut server) = guard.take() {
            server.kill().await;
        }
    }
    result
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

/// Restores the overlay from the tray (also used by the tray menu).
fn show_overlay_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("overlay") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Kills the warm whisper server before leaving, then exits the process.
fn exit_voice_app(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::block_on(async {
        let state = app.state::<AppState>();
        let server = { state.whisper.lock().await.take() };
        if let Some(mut server) = server {
            server.kill().await;
        }
    });
    app.exit(0);
}

/// Tray icon: left click restores the window, the menu can restore or quit.
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Открыть окно", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut builder = TrayIconBuilder::with_id("voice-overlay")
        .tooltip("Голосовой ввод OpenCode")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_overlay_window(app),
            "quit" => exit_voice_app(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_overlay_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Custom title-bar minimize: hide to the tray instead of the taskbar so the
/// global hotkey and an in-progress recording keep running.
#[tauri::command]
async fn minimize_to_tray(window: tauri::WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|error| error.to_string())
}

fn main() {
    #[cfg(target_os = "linux")]
    if let Some(action) = std::env::args().nth(1) {
        let result = match action.as_str() {
            "--toggle" => Some(
                tauri::async_runtime::block_on(native_input::wayland_input::toggle_existing())
                    .map(|_| String::new()),
            ),
            "--install-gnome-extension" => {
                Some(native_input::wayland_input::install_gnome_extension())
            }
            _ => None,
        };
        if let Some(result) = result {
            match result {
                Ok(message) => println!("{message}"),
                Err(message) => {
                    eprintln!("{message}");
                    std::process::exit(1);
                }
            }
            return;
        }
    }
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
                whisper: Mutex::new(None),
                app_dir,
            });
            window_attachment::setup(app.handle())?;
            setup_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "overlay" && matches!(event, tauri::WindowEvent::Destroyed) {
                // The hidden widget must not keep the recorder/hotkey process alive.
                exit_voice_app(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            native_input::enable_voice_hotkey,
            native_input::paste_voice_text,
            window_attachment::voice_widget_snapshot,
            window_attachment::update_voice_widget,
            window_attachment::attach_voice_window,
            window_attachment::toggle_voice_widget,
            browser_bridge::browser_target,
            browser_bridge::insert_in_browser,
            health_check,
            append_to_prompt,
            submit_prompt,
            list_microphones,
            start_recording,
            stop_recording,
            minimize_to_tray,
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
    fn thread_override_is_bounded_and_parses_env_values() {
        assert_eq!(thread_override(Some("8")), Some(8));
        assert_eq!(thread_override(Some(" 6 ")), Some(6));
        assert_eq!(thread_override(Some("0")), None);
        assert_eq!(thread_override(Some("-2")), None);
        assert_eq!(thread_override(Some("9999")), None);
        assert_eq!(thread_override(Some("half")), None);
        assert_eq!(thread_override(None), None);
        assert!(voice_threads() >= 1);
    }

    #[test]
    fn accelerator_preference_accepts_known_values_only() {
        for value in ["auto", "cpu", "cuda", "cuda11", "vulkan"] {
            assert_eq!(parse_accelerator(Some(value)), Some(value.to_string()));
        }
        assert_eq!(parse_accelerator(Some(" vulkan ")), Some("vulkan".to_string()));
        for value in ["", "cuda12", "../evil"] {
            assert_eq!(parse_accelerator(Some(value)), None);
        }
        assert_eq!(parse_accelerator(None), None);
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
        assert_eq!(
            allowed_model_file("large-v3-turbo-q5_0"),
            Ok("ggml-large-v3-turbo-q5_0.bin".to_string())
        );
    }

    #[test]
    fn speech_language_allowlist_supports_multilingual_dictation() {
        for language in ["ru", "en", "zh", "auto"] {
            assert_eq!(allowed_language(language), Ok(language));
        }
        for language in ["", "fr", "--translate", "../../secret"] {
            assert!(allowed_language(language).is_err());
        }
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
