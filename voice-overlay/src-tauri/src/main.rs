use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
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
    pub id: u64,
    pub wav: PathBuf,
    pub child: tokio::process::Child,
    pub started: std::time::Instant,
}

pub struct AppState {
    pub recording: Mutex<Option<Recording>>,
    pub next_id: Mutex<u64>,
    pub app_dir: PathBuf,
}

pub fn append_url(host: &str, port: u16) -> String {
    format!("http://{host}:{port}/tui/append-prompt")
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
        let Some(q2) = after_open.find('"') else { break };
        let name = &after_open[..q2];
        let after_close = &after_open[q2 + 1..];
        if after_close.trim_start().starts_with("(audio)") && !out.iter().any(|n| n == name) {
            out.push(name.to_string());
        }
        rest = after_close;
    }
    out
}

pub fn ffmpeg_input_args(os: &str, device: Option<&str>) -> Vec<String> {
    match (os, device) {
        ("linux", d) => vec!["-f".to_string(), "pulse".to_string(), "-i".to_string(), d.unwrap_or("default").to_string()],
        (_, Some(d)) => vec!["-f".to_string(), "dshow".to_string(), "-i".to_string(), format!("audio={d}")],
        _ => vec!["-f".to_string(), "wasapi".to_string(), "-i".to_string(), "default".to_string()],
    }
}

fn sidecar_path(app: &AppHandle, base: &str) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("transcribe-failed: {e}"))?;
    let dir = exe.parent().ok_or("transcribe-failed: executable directory missing")?;
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
        let probe = tokio::time::timeout(std::time::Duration::from_secs(5),
            tokio::process::Command::new(&path).kill_on_drop(true).args(["-hide_banner", "-devices"]).output()).await;
        match probe {
            Ok(Ok(output)) if output.status.success() => {
                let devices = format!("{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
                if !needs_pulse || sidecars::supports_pulse(&devices) {
                    return Ok(path);
                }
                details.push(format!("{}: нет входа PulseAudio; установи системный ffmpeg с поддержкой PulseAudio", path.display()));
            }
            Ok(Ok(output)) => details.push(format!("{}: {}", path.display(), String::from_utf8_lossy(&output.stderr).trim())),
            Ok(Err(error)) => details.push(format!("{}: {error}", path.display())),
            Err(_) => details.push(format!("{}: проверка превысила 5 секунд", path.display())),
        }
    }
    Err(format!("no-ffmpeg: {}", details.join("; ")))
}

#[tauri::command]
async fn health_check(host: String, port: u16) -> Result<bool, String> {
    let resp = reqwest::get(format!("http://{host}:{port}/global/health"))
        .await
        .map_err(|e| format!("server-unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("server-unreachable: http {}", resp.status()));
    }
    Ok(true)
}

#[tauri::command]
async fn append_to_prompt(cfg: ServerConfig, text: String) -> Result<bool, String> {
    let mut req = reqwest::Client::new()
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
    let ack = resp.json::<bool>().await.map_err(|e| format!("fallback: {e}"))?;
    if append_outcome(status, ack) != "inserted" {
        return Err("fallback: сервер не подтвердил вставку".to_string());
    }
    Ok(true)
}

#[tauri::command]
async fn list_microphones(app: AppHandle) -> Result<Vec<String>, String> {
    if std::env::consts::OS != "windows" {
        return Ok(Vec::new());
    }
    let ffmpeg = recording_ffmpeg(&app, false).await?;
    let out = tokio::process::Command::new(ffmpeg)
        .args(["-list_devices", "true", "-f", "dshow", "-i", "dummy"])
        .output()
        .await
        .map_err(|e| format!("no-mic: {e}"))?;
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    let devices = parse_dshow_devices(&stderr);
    if devices.is_empty() {
        return Err("no-mic: микрофон не найден. Подключи устройство и попробуй снова.".to_string());
    }
    Ok(devices)
}

#[tauri::command]
async fn start_recording(
    app: AppHandle,
    state: State<'_, AppState>,
    device: Option<String>,
) -> Result<bool, String> {
    let id = {
        let slot = state.recording.lock().map_err(|e| e.to_string())?;
        if slot.is_some() {
            return Err("busy: запись уже идёт".to_string());
        }
        let mut next = state.next_id.lock().map_err(|e| e.to_string())?;
        let id = *next;
        *next += 1;
        id
    };
    let wav = state.app_dir.join(format!("record-{id}.wav"));
    std::fs::create_dir_all(&state.app_dir)
        .map_err(|e| format!("transcribe-failed: нет доступа к каталогу данных: {e}"))?;
    let mut args = if let Ok(test_input) = std::env::var("VOICE_FFMPEG_TEST_INPUT") {
        vec!["-f".to_string(), "lavfi".to_string(), "-i".to_string(), test_input]
    } else {
        ffmpeg_input_args(std::env::consts::OS, device.as_deref())
    };
    args.extend(
        ["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-y"]
            .into_iter()
            .map(str::to_string),
    );
    args.push(wav.to_string_lossy().into_owned());
    let needs_pulse = std::env::consts::OS == "linux" && std::env::var("VOICE_FFMPEG_TEST_INPUT").is_err();
    let ffmpeg = recording_ffmpeg(&app, needs_pulse).await?;
    let stderr_file = std::fs::File::create(wav.with_extension("stderr"))
        .map_err(|e| format!("no-ffmpeg: {e}"))?;
    let mut child = tokio::process::Command::new(ffmpeg)
        .kill_on_drop(true)
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
            return Err(format!("{}: {}", if needs_pulse { "no-audio-server" } else { "no-mic" }, detail.trim()));
        }
    }
    let rec = Recording {
        id,
        wav,
        child,
        started: std::time::Instant::now(),
    };
    *state.recording.lock().map_err(|e| e.to_string())? = Some(rec);
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(MAX_SECONDS)).await;
        // No .await while the std lock is held: MutexGuard over Recording
        // (owns a tokio Child) is !Send, so `child.kill().await` under the
        // lock breaks Send. `start_kill()` is sync — same force-kill semantics.
        if let Ok(mut slot) = app_clone.state::<AppState>().recording.lock() {
            if let Some(rec) = slot.as_mut() {
                if rec.id == id {
                    let _ = rec.child.start_kill();
                }
            }
        }
    });
    Ok(true)
}

#[tauri::command]
async fn stop_recording(state: State<'_, AppState>) -> Result<String, String> {
    let mut rec = state
        .recording
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .ok_or_else(|| "idle: запись не запущена".to_string())?;
    if let Some(mut stdin) = rec.child.stdin.take() {
        use tokio::io::AsyncWriteExt as _;
        let _ = stdin.write_all(b"q\n").await;
        let _ = stdin.shutdown().await;
    }
    let finished = tokio::time::timeout(std::time::Duration::from_secs(5), rec.child.wait()).await;
    if finished.is_err() {
        let _ = rec.child.kill().await;
        let _ = rec.child.wait().await;
    }
    let size = std::fs::metadata(&rec.wav)
        .map(|m| m.len())
        .unwrap_or(0);
    if size < MIN_WAV_BYTES {
        let detail = std::fs::read_to_string(rec.wav.with_extension("stderr")).unwrap_or_default();
        if matches!(finished, Ok(Ok(exit)) if !exit.success()) {
            return Err(format!("no-mic: {}", detail.trim()));
        }
        return Err("empty-recording: запись пустая (короче полсекунды). Нажми Record, дождись и потом Stop.".to_string());
    }
    Ok(rec.wav.to_string_lossy().into_owned())
}

pub fn allowed_model_file(model: &str) -> Result<String, String> {
    match model {
        "base" => Ok("ggml-base.bin".to_string()),
        "small" => Ok("ggml-small.bin".to_string()),
        _ => Err("transcribe-failed: неизвестная модель. Выбери base или small.".to_string()),
    }
}

#[tauri::command]
async fn transcribe(
    app: AppHandle,
    wav: String,
    model: String,
) -> Result<String, String> {
    let file = allowed_model_file(&model)?;
    let model_path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("model-missing: {e}"))?
        .join("models")
        .join(&file);
    if !model_path.exists() {
        return Err("model-missing: модель распознавания не скачана. Нажми «Скачать модель» в настройках (нужен интернет один раз).".to_string());
    }
    let whisper = sidecar_path(&app, "whisper")?;
    let out_base = format!("{wav}.out");
    let args = vec![
        "-m".to_string(),
        model_path.to_string_lossy().into_owned(),
        "-l".to_string(),
        "ru".to_string(),
        "-f".to_string(),
        wav.clone(),
        "-otxt".to_string(),
        "-of".to_string(),
        out_base.clone(),
    ];
    let output = tokio::time::timeout(std::time::Duration::from_secs(600), async {
        tokio::process::Command::new(whisper)
            .args(&args)
            .output()
            .await
    })
        .await
        .map_err(|_| "transcribe-failed: превышено время ожидания распознавания".to_string())?
        .map_err(|e| format!("transcribe-failed: не удалось запустить whisper: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "transcribe-failed: whisper завершился с кодом {}",
            output.status.code().unwrap_or(-1)
        ));
    }
    let text = std::fs::read_to_string(format!("{out_base}.txt"))
        .map_err(|e| format!("transcribe-failed: нет результата: {e}"))?
        .trim()
        .to_string();
    if text.is_empty() {
        return Err("empty-transcript: речь не распознана. Попробуй говорить громче и ближе к микрофону.".to_string());
    }
    Ok(text)
}

pub fn session_url(host: &str, port: u16) -> String {
    format!("http://{host}:{port}/session")
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
}

#[tauri::command]
async fn list_sessions(cfg: ServerConfig) -> Result<Vec<SessionInfo>, String> {
    let mut req = reqwest::Client::new().get(session_url(&cfg.host, cfg.port));
    if let Some(auth) = basic_auth_value(&cfg.username, &cfg.password) {
        req = req.header("Authorization", auth);
    }
    let resp = req.send().await.map_err(|e| format!("server-unreachable: {e}"))?;
    let status = resp.status().as_u16();
    if status == 401 || status == 403 {
        return Err("unauthorized: проверь пароль сервера (OPENCODE_SERVER_PASSWORD)".to_string());
    }
    if !resp.status().is_success() {
        return Err(format!("fallback: http {}", resp.status()));
    }
    let items = resp.json::<Vec<serde_json::Value>>().await.map_err(|e| format!("fallback: {e}"))?;
    let mut out: Vec<SessionInfo> = Vec::new();
    for item in &items {
        let Some(id) = item.get("id").and_then(|v| v.as_str()) else { continue };
        if id.is_empty() || out.iter().any(|s: &SessionInfo| s.id == id) { continue; }
        let title = item.get("title").and_then(|v| v.as_str()).filter(|t| !t.is_empty()).unwrap_or(id).to_string();
        out.push(SessionInfo { id: id.to_string(), title });
    }
    Ok(out)
}

#[tauri::command]
async fn send_to_session(cfg: ServerConfig, session_id: String, text: String) -> Result<bool, String> {
    if session_id.is_empty() {
        return Err("session-not-found: выбери сессию в настройках.".to_string());
    }
    let mut req = reqwest::Client::new()
        .post(message_url(&cfg.host, cfg.port, &session_id))
        .json(&serde_json::json!({ "parts": [{ "type": "text", "text": text }] }));
    if let Some(auth) = basic_auth_value(&cfg.username, &cfg.password) {
        req = req.header("Authorization", auth);
    }
    let resp = req.send().await.map_err(|e| format!("server-unreachable: {e}"))?;
    let status = resp.status().as_u16();
    if send_outcome(status) != "sent" {
        if status == 401 || status == 403 {
            return Err("unauthorized: проверь пароль сервера (OPENCODE_SERVER_PASSWORD)".to_string());
        }
        if status == 404 {
            return Err("session-not-found: сессия не найдена (удалена?). Обнови список и выбери снова.".to_string());
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
            let app_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| e.to_string())?;
            app.manage(AppState {
                recording: Mutex::new(None),
                next_id: Mutex::new(1),
                app_dir,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health_check,
            append_to_prompt,
            list_microphones,
            start_recording,
            stop_recording,
            transcribe,
            list_sessions,
            send_to_session
        ])
        .run(tauri::generate_context!())
        .expect("voice-overlay failed to run");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_matches_live_verified_contract() {
        assert_eq!(
            append_url("127.0.0.1", 4096),
            "http://127.0.0.1:4096/tui/append-prompt"
        );
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
        assert_eq!(parse_dshow_devices(sample), vec!["Microphone (Realtek Audio)".to_string()]);
        assert!(parse_dshow_devices("dummy").is_empty());
    }

    #[test]
    fn ffmpeg_args_mirror_ts() {
        assert_eq!(ffmpeg_input_args("linux", None), vec!["-f", "pulse", "-i", "default"]);
        assert_eq!(
            ffmpeg_input_args("windows", Some("Mic")),
            vec!["-f", "dshow", "-i", "audio=Mic"]
        );
        assert_eq!(ffmpeg_input_args("windows", None), vec!["-f", "wasapi", "-i", "default"]);
    }

    #[test]
    fn sidecar_name_carries_base_and_triple() {
        let name = sidecar_file("binaries/ffmpeg").unwrap();
        assert!(name.starts_with("binaries/ffmpeg-"), "{name}");
    }

    #[test]
    fn model_allowlist_maps_to_ggml_files() {
        assert_eq!(allowed_model_file("base"), Ok("ggml-base.bin".to_string()));
        assert_eq!(allowed_model_file("small"), Ok("ggml-small.bin".to_string()));
        assert!(allowed_model_file("../../etc/passwd").is_err());
        assert!(allowed_model_file("large").is_err());
    }

    #[test]
    fn session_urls_match_docs_contract() {
        assert_eq!(session_url("127.0.0.1", 4096), "http://127.0.0.1:4096/session");
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
