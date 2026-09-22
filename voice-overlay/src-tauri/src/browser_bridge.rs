use crate::ServerConfig;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct BrowserTarget {
    pub id: String,
    pub route: String,
    pub title: String,
}

async fn request(
    cfg: ServerConfig,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    if !matches!(cfg.host.as_str(), "localhost" | "127.0.0.1" | "[::1]") {
        return Err("Для связи с вкладкой укажите локальный хост voice-web.".into());
    }
    let endpoint = if body.is_some() { "insert" } else { "active" };
    let url = format!(
        "http://{}:{}/__orchestra_voice/bridge/{}",
        cfg.host, cfg.port, endpoint
    );
    let client = crate::http_client()?;
    let request = if let Some(body) = body {
        client.post(url).json(&body)
    } else {
        client.get(url)
    };
    let response = request.header("x-orchestra-voice", "1").send().await
        .map_err(|_| "Нет связи с вкладкой. Запустите opencode-orchestra voice-web и откройте OpenCode на его порту (по умолчанию 4097).".to_string())?;
    let status = response.status();
    let value: serde_json::Value = response.json().await.map_err(|_| {
        "На указанном порту нет связи voice-web. Проверьте порт вкладки в настройках.".to_string()
    })?;
    if !status.is_success() {
        return Err(value
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("Не удалось связаться с вкладкой OpenCode.")
            .into());
    }
    Ok(value)
}

#[tauri::command]
pub async fn browser_target(cfg: ServerConfig) -> Result<BrowserTarget, String> {
    serde_json::from_value(request(cfg, None).await?).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn insert_in_browser(
    cfg: ServerConfig,
    target: BrowserTarget,
    text: String,
) -> Result<(), String> {
    let value = request(
        cfg,
        Some(serde_json::json!({"id": target.id, "route": target.route, "text": text})),
    )
    .await?;
    if value.get("inserted").and_then(|v| v.as_bool()) != Some(true) {
        return Err("Вкладка не подтвердила вставку. Проверьте поле ввода перед повтором.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    fn server(status: u16, body: &'static str) -> (ServerConfig, std::thread::JoinHandle<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let worker = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut buffer = [0; 4096];
                let count = socket.read(&mut buffer).unwrap();
                if count == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..count]);
                let text = String::from_utf8_lossy(&bytes);
                if let Some(end) = text.find("\r\n\r\n") {
                    let size = text[..end]
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|s| s.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= end + 4 + size {
                        break;
                    }
                }
            }
            write!(socket, "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            String::from_utf8(bytes).unwrap()
        });
        (
            ServerConfig {
                host: "127.0.0.1".into(),
                port,
                username: String::new(),
                password: String::new(),
            },
            worker,
        )
    }

    #[tokio::test]
    async fn snapshots_tab_and_inserts_without_submitting() {
        let (cfg, worker) = server(
            200,
            r#"{"id":"tab-a","route":"/project/session/A?draftId=1","title":"A"}"#,
        );
        let target = browser_target(cfg).await.unwrap();
        let request = worker.join().unwrap();
        assert!(request.starts_with("GET /__orchestra_voice/bridge/active "));
        assert!(request.contains("x-orchestra-voice: 1"));
        let (cfg, worker) = server(200, r#"{"inserted":true}"#);
        insert_in_browser(cfg, target, "hello".into())
            .await
            .unwrap();
        let request = worker.join().unwrap();
        assert!(request.starts_with("POST /__orchestra_voice/bridge/insert "));
        let body: serde_json::Value =
            serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(
            body,
            serde_json::json!({"id":"tab-a", "route":"/project/session/A?draftId=1", "text":"hello"})
        );
    }

    #[tokio::test]
    async fn reports_route_rejection_and_requires_insertion_ack() {
        let target = || BrowserTarget {
            id: "A".into(),
            route: "/A".into(),
            title: "A".into(),
        };
        let (cfg, worker) = server(409, r#"{"error":"route changed"}"#);
        assert_eq!(
            insert_in_browser(cfg, target(), "hello".into())
                .await
                .unwrap_err(),
            "route changed"
        );
        worker.join().unwrap();
        let (cfg, worker) = server(200, r#"{}"#);
        assert!(insert_in_browser(cfg, target(), "hello".into())
            .await
            .is_err());
        worker.join().unwrap();
    }
}
