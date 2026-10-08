//! Long-lived `whisper-server` child: the model stays loaded between
//! dictations, removing the per-request model load and process startup.
//! Requests are serialized because the server holds a single context.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, Command};
use tokio::sync::{watch, Mutex};
use tokio::time::{sleep, timeout, Instant};

const READY_TIMEOUT: Duration = Duration::from_secs(120);
const INFERENCE_TIMEOUT: Duration = Duration::from_secs(600);
const BOUNDARY: &str = "----voiceoverlay7f3a19c2";

pub fn server_args(model: &Path, threads: usize, port: u16) -> Vec<String> {
    vec![
        "-m".into(),
        model.to_string_lossy().into_owned(),
        "-t".into(),
        threads.to_string(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string(),
    ]
}

fn push_field(body: &mut Vec<u8>, name: &str, value: &str) {
    body.extend_from_slice(
        format!(
            "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
        )
        .as_bytes(),
    );
}

/// Hand-built multipart body (no reqwest `multipart` feature needed).
pub fn multipart_body(wav: &[u8], language: &str) -> Vec<u8> {
    let mut body = Vec::with_capacity(wav.len() + 512);
    body.extend_from_slice(
        format!(
            "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(wav);
    body.extend_from_slice(b"\r\n");
    push_field(&mut body, "language", language);
    push_field(&mut body, "response_format", "text");
    body.extend_from_slice(format!("--{BOUNDARY}--\r\n").as_bytes());
    body
}

async fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| format!("transcribe-failed: нет свободного порта: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("transcribe-failed: {error}"))?
        .port();
    drop(listener);
    Ok(port)
}

pub struct WhisperServer {
    child: Child,
    port: u16,
    model: PathBuf,
    stderr_tail: Arc<Mutex<String>>,
    client: reqwest::Client,
}

impl WhisperServer {
    pub async fn start(server: &Path, model: &Path, threads: usize) -> Result<Self, String> {
        let port = free_port().await?;
        let mut command = Command::new(server);
        command.args(server_args(model, threads, port));
        Self::start_command(command, model, port).await
    }

    async fn start_command(mut command: Command, model: &Path, port: u16) -> Result<Self, String> {
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(target_os = "windows")]
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let mut child = command.spawn().map_err(|error| {
            format!("transcribe-failed: не удалось запустить whisper-server: {error}")
        })?;
        let stderr_tail = Arc::new(Mutex::new(String::new()));
        if let Some(mut stderr) = child.stderr.take() {
            let tail = stderr_tail.clone();
            tokio::spawn(async move {
                let mut buffer = [0u8; 4096];
                loop {
                    match stderr.read(&mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(count) => {
                            let mut guard = tail.lock().await;
                            guard.push_str(&String::from_utf8_lossy(&buffer[..count]));
                            let length = guard.len();
                            if length > 4000 {
                                guard.drain(..length - 4000);
                            }
                        }
                    }
                }
            });
        }
        let client = reqwest::Client::builder()
            // Loopback server: never route dictation audio through OS or
            // environment proxies (a system VPN may answer 503 for 127.0.0.1).
            .no_proxy()
            .connect_timeout(Duration::from_secs(5))
            .timeout(INFERENCE_TIMEOUT)
            .build()
            .map_err(|error| format!("transcribe-failed: {error}"))?;
        let mut instance = WhisperServer {
            child,
            port,
            model: model.to_path_buf(),
            stderr_tail,
            client,
        };
        instance.wait_ready().await?;
        Ok(instance)
    }

    pub async fn ensure_started(
        slot: &mut Option<Self>,
        server: &Path,
        model: &Path,
        threads: usize,
    ) -> Result<(), String> {
        Self::ensure_with(slot, model, || Self::start(server, model, threads)).await
    }

    async fn ensure_with<F, Fut>(
        slot: &mut Option<Self>,
        model: &Path,
        start: F,
    ) -> Result<(), String>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<Self, String>>,
    {
        if slot.as_mut().is_some_and(|server| {
            server.model == model && matches!(server.child.try_wait(), Ok(None))
        }) {
            return Ok(());
        }
        if let Some(mut previous) = slot.take() {
            previous.kill().await;
        }
        *slot = Some(start().await?);
        Ok(())
    }

    async fn stderr_tail(&self) -> String {
        self.stderr_tail.lock().await.trim().to_string()
    }

    async fn wait_ready(&mut self) -> Result<(), String> {
        let deadline = Instant::now() + READY_TIMEOUT;
        loop {
            if !matches!(self.child.try_wait(), Ok(None)) {
                return Err(format!(
                    "transcribe-failed: whisper-server завершился: {}",
                    self.stderr_tail().await
                ));
            }
            if matches!(
                timeout(
                    Duration::from_millis(1500),
                    TcpStream::connect(("127.0.0.1", self.port)),
                )
                .await,
                Ok(Ok(_))
            ) {
                return Ok(());
            }
            if Instant::now() > deadline {
                return Err("transcribe-failed: whisper-server не запустился вовремя".to_string());
            }
            sleep(Duration::from_millis(150)).await;
        }
    }

    pub async fn transcribe(&mut self, wav: &[u8], language: &str) -> Result<String, String> {
        let body = multipart_body(wav, language);
        let response = self
            .client
            .post(format!("http://127.0.0.1:{}/inference", self.port))
            .header(
                reqwest::header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={BOUNDARY}"),
            )
            .body(body)
            .send()
            .await
            .map_err(|error| format!("transcribe-failed: whisper-server недоступен: {error}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "transcribe-failed: whisper-server http {}",
                response.status()
            ));
        }
        response
            .text()
            .await
            .map(|text| text.trim().to_string())
            .map_err(|error| format!("transcribe-failed: {error}"))
    }

    /// Discard failed or interrupted inference so the next request can start
    /// a fresh process instead of queueing behind work that is still running.
    pub async fn transcribe_with_cancel(
        slot: &mut Option<Self>,
        wav: &[u8],
        language: &str,
        mut cancel: watch::Receiver<bool>,
    ) -> Result<String, String> {
        let server = slot
            .as_mut()
            .ok_or_else(|| "transcribe-failed: whisper-server недоступен".to_string())?;
        let result = if *cancel.borrow() {
            Err("cancelled: распознавание отменено".to_string())
        } else {
            tokio::select! {
                result = server.transcribe(wav, language) => result,
                _ = cancel.changed() => Err("cancelled: распознавание отменено".to_string()),
            }
        };
        if result.is_err() {
            if let Some(mut server) = slot.take() {
                server.kill().await;
            }
        }
        result
    }

    pub async fn kill(&mut self) {
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The test executable doubles as a portable child process fixture.
    #[test]
    fn server_process_fixture() {
        let Ok(port) = std::env::var("VOICE_WHISPER_TEST_PORT") else {
            return;
        };
        if std::env::var("VOICE_WHISPER_TEST_EXIT").is_ok() {
            eprintln!("startup failed");
            std::process::exit(3);
        }
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind(format!("127.0.0.1:{port}")).unwrap();
        for socket in listener.incoming() {
            let mut socket = socket.unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            loop {
                let mut buffer = [0u8; 4096];
                let Ok(count) = socket.read(&mut buffer) else {
                    break;
                };
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..count]);
                let text = String::from_utf8_lossy(&request);
                if let Some(end) = text.find("\r\n\r\n") {
                    let size = text[..end]
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|size| size.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + size {
                        break;
                    }
                }
            }
            if request.is_empty() {
                continue;
            } // TCP readiness probe.
            let text = String::from_utf8_lossy(&request);
            if text.contains("\r\n\r\ncrash\r\n") {
                std::process::exit(3)
            }
            if text.contains("\r\n\r\nslow\r\n") {
                std::thread::sleep(Duration::from_secs(30))
            }
            let _ = socket.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\ntranscript",
            );
        }
    }

    async fn fixture_server(exit: bool) -> Result<WhisperServer, String> {
        let port = free_port().await.unwrap();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "whisper_server::tests::server_process_fixture",
                "--nocapture",
            ])
            .env("VOICE_WHISPER_TEST_PORT", port.to_string());
        if exit {
            command.env("VOICE_WHISPER_TEST_EXIT", "1");
        }
        WhisperServer::start_command(command, Path::new("model.bin"), port).await
    }

    #[tokio::test]
    async fn startup_exit_is_reported_without_waiting_for_ready_timeout() {
        let result = timeout(Duration::from_secs(5), fixture_server(true))
            .await
            .unwrap();
        assert!(
            result.is_err(),
            "a refused connection must not count as ready"
        );
    }

    #[tokio::test]
    async fn reuses_a_live_process_and_restarts_a_crashed_process_for_the_same_model() {
        let model = Path::new("model.bin");
        let mut slot = None;
        WhisperServer::ensure_with(&mut slot, model, || fixture_server(false))
            .await
            .unwrap();
        let pid = slot.as_ref().unwrap().child.id();
        WhisperServer::ensure_with(&mut slot, model, || async {
            panic!("live server was restarted")
        })
        .await
        .unwrap();
        assert_eq!(slot.as_ref().unwrap().child.id(), pid);
        assert!(slot
            .as_mut()
            .unwrap()
            .transcribe(b"RIFF-audio", "crash")
            .await
            .is_err());
        slot.as_mut().unwrap().child.wait().await.unwrap();
        WhisperServer::ensure_with(&mut slot, model, || fixture_server(false))
            .await
            .unwrap();
        assert_eq!(
            slot.as_mut()
                .unwrap()
                .transcribe(b"RIFF-audio", "ru")
                .await
                .unwrap(),
            "transcript"
        );
        slot.as_mut().unwrap().kill().await;
    }

    #[tokio::test]
    async fn cancellation_kills_busy_inference_and_allows_a_fresh_request() {
        let mut slot = Some(fixture_server(false).await.unwrap());
        let (sender, cancel) = watch::channel(false);
        let request =
            WhisperServer::transcribe_with_cancel(&mut slot, b"RIFF-audio", "slow", cancel);
        let cancel_task = async {
            sleep(Duration::from_millis(100)).await;
            sender.send(true).unwrap();
        };
        let (result, _) = tokio::join!(request, cancel_task);
        assert!(result.unwrap_err().starts_with("cancelled:"));
        assert!(slot.is_none());
        WhisperServer::ensure_with(&mut slot, Path::new("model.bin"), || fixture_server(false))
            .await
            .unwrap();
        assert_eq!(
            slot.as_mut()
                .unwrap()
                .transcribe(b"tail", "ru")
                .await
                .unwrap(),
            "transcript"
        );
        slot.as_mut().unwrap().kill().await;
    }

    #[test]
    fn server_args_match_the_pinned_contract() {
        let args = server_args(Path::new("ggml-base.bin"), 8, 9000);
        assert_eq!(
            args,
            vec![
                "-m",
                "ggml-base.bin",
                "-t",
                "8",
                "--host",
                "127.0.0.1",
                "--port",
                "9000"
            ]
        );
    }

    #[test]
    fn multipart_body_carries_file_language_and_text_format() {
        let body = multipart_body(b"RIFF-audio", "ru");
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains("name=\"file\"; filename=\"audio.wav\""));
        assert!(text.contains("Content-Type: audio/wav"));
        assert!(text.contains("RIFF-audio"));
        assert!(text.contains("name=\"language\"\r\n\r\nru\r\n"));
        assert!(text.contains("name=\"response_format\"\r\n\r\ntext\r\n"));
        assert!(text.ends_with(&format!("--{BOUNDARY}--\r\n")));
    }

    #[tokio::test]
    async fn free_port_is_bindable_and_missing_binaries_fail_loudly() {
        let port = free_port().await.unwrap();
        assert!(port > 0);
        assert!(WhisperServer::start(
            Path::new("definitely-missing-whisper-server"),
            Path::new("model.bin"),
            4
        )
        .await
        .is_err());
    }
}
