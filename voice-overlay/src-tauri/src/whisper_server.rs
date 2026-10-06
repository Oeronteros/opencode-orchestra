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
use tokio::sync::Mutex;
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
        command
            .args(server_args(model, threads, port))
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
        let instance = WhisperServer {
            child,
            port,
            model: model.to_path_buf(),
            stderr_tail,
            client,
        };
        instance.wait_ready().await?;
        Ok(instance)
    }

    pub fn model(&self) -> &Path {
        &self.model
    }

    async fn stderr_tail(&self) -> String {
        self.stderr_tail.lock().await.trim().to_string()
    }

    async fn wait_ready(&self) -> Result<(), String> {
        let deadline = Instant::now() + READY_TIMEOUT;
        loop {
            if timeout(
                Duration::from_millis(1500),
                TcpStream::connect(("127.0.0.1", self.port)),
            )
            .await
            .is_ok()
            {
                return Ok(());
            }
            if self.child.id().is_none() {
                return Err(format!(
                    "transcribe-failed: whisper-server завершился: {}",
                    self.stderr_tail().await
                ));
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

    pub async fn kill(&mut self) {
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
