# Voice Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Tauri v2 floating voice-input window that records via ffmpeg, transcribes offline with whisper.cpp, and appends text to the open opencode TUI prompt.

**Architecture:** Isolated `voice-overlay/` node (React+Vite frontend, Rust backend). UI talks only via `invoke` to 6 Tauri commands; all hardware/network access lives in Rust. Pure logic (device parsing, ffmpeg args, HTTP contract, error catalog) is duplicated once per language as small tested functions with identical behavior contracts.

**Tech Stack:** React 19 + Vite 8 + TypeScript 5.9 (pinned to repo's versions), Tauri v2 (`tauri`, `@tauri-apps/api`, `@tauri-apps/cli` v2), Rust stable, reqwest 0.12 + tokio (process/time) + base64 0.22, ffmpeg + whisper.cpp as Tauri `externalBin` sidecars, ggml `base`/`small` models.

**Spec:** `docs/superpowers/specs/2026-09-07-voice-overlay-design.md` — the plan argues from the spec; executors read both.

## Global Constraints

- Offline v1: no cloud STT, no API keys. Network allowed only for first ggml-model download and for localhost opencode server calls.
- Locked live-verified contract (opencode 1.18.19, 2026-09-07): `POST http://{host}:{port}/tui/append-prompt` with body exactly `{"text": string}` returns `boolean`. Headless `serve` without TUI also returns `true` and drops the text — `true` proves nothing about a live TUI. Clipboard fallback fires ONLY on transport errors and non-2xx (incl. 401).
- ffmpeg stop: write `q` (+newline) to the child's stdin on BOTH OSes (works on Linux too), 5 s grace, then kill. No SIGTERM anywhere (it does not exist on Windows).
- Existing builds untouched: `src/`, `dashboard/`, `dist/`, `dashboard-dist/` are never modified. Root `package.json` gains exactly two scripts: `dev:voice`, `build:voice`.
- All user-facing copy in Russian.
- No commits without the user's explicit request. Every task ends with verify + report, never `git commit`.
- Non-goals (from spec, not in this plan): streaming STT, live waveform/level meter, global hotkey, session picker, cloud fallback, in-app model-download button (manual download commands ship in README instead).
- Backend tasks (2, 3, 4-Rust-parts, 5) execute on a machine with a Rust toolchain and ffmpeg; Task 1 (pure TS) executes anywhere with Node 22+.

---

### Task 1: Frontend scaffold + pure libs + unit tests

**Files:**
- Create: `voice-overlay/package.json`, `voice-overlay/tsconfig.json`, `voice-overlay/tsconfig.test.json`, `voice-overlay/vite.config.ts`, `voice-overlay/index.html`, `voice-overlay/src/main.tsx`, `voice-overlay/src/App.tsx`, `voice-overlay/src/api.ts`, `voice-overlay/src/lib/errors.ts`, `voice-overlay/src/lib/opencode.ts`, `voice-overlay/src/lib/audio.ts`, `voice-overlay/test/errors.test.ts`, `voice-overlay/test/opencode.test.ts`, `voice-overlay/test/audio.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces (exact names later tasks use): `ServerConfig { host: string; port: number; username: string; password: string }`, `OverlayStatus = "idle" | "recording" | "transcribing" | "error"`, `OverlayErrorCode` + `ERROR_CODES` + `errorCopy(code)`, `appendRequest(cfg, text)`, `basicAuthHeader(user, pass)`, `parseAppendResult(status, ack)`, `parseDshowDevices(stderr)`, `ffmpegInputArgs(os, device)`, `ffmpegOutputArgs(wav)`, `SAMPLE_RATE = 16000`, `CHANNELS = 1`, `MAX_SECONDS = 120`, `MIN_WAV_BYTES = 16000`, api fns `healthCheck`, `appendToPrompt`, `listMicrophones`, `startRecording(device?)`, `stopRecording()`, `transcribe(wav, model)`.

- [ ] **Step 1: Write the failing tests**

Create `voice-overlay/test/audio.test.ts`:
```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_SECONDS, SAMPLE_RATE, ffmpegInputArgs, parseDshowDevices } from "../src/lib/audio.js";

const DSHOW_SAMPLE = [
  "[dshow @ 0x123] DirectShow audio devices",
  "[dshow @ 0x123]  \"Microphone (Realtek Audio)\" (audio)",
  "[dshow @ 0x123]  \"Headset (Hands-Free)\" (audio)",
  "[dshow @ 0x123]  \"Integrated Camera\" (video)",
].join("\n");

describe("parseDshowDevices", () => {
  it("returns only audio devices in listing order", () => {
    assert.deepEqual(parseDshowDevices(DSHOW_SAMPLE), [
      "Microphone (Realtek Audio)",
      "Headset (Hands-Free)",
    ]);
  });
  it("returns empty array when no audio devices", () => {
    assert.deepEqual(parseDshowDevices("dummy output"), []);
  });
});

describe("ffmpegInputArgs", () => {
  it("linux pulse default", () => {
    assert.deepEqual(ffmpegInputArgs("linux", undefined), ["-f", "pulse", "-i", "default"]);
  });
  it("linux honors explicit device", () => {
    assert.deepEqual(ffmpegInputArgs("linux", "hw:1"), ["-f", "pulse", "-i", "hw:1"]);
  });
  it("windows dshow with device name", () => {
    assert.deepEqual(ffmpegInputArgs("win32", "Microphone (Realtek Audio)"), [
      "-f", "dshow", "-i", "audio=Microphone (Realtek Audio)",
    ]);
  });
  it("windows wasapi fallback without device", () => {
    assert.deepEqual(ffmpegInputArgs("win32", undefined), ["-f", "wasapi", "-i", "default"]);
  });
});

describe("recording profile", () => {
  it("16kHz mono with 120s cap", () => {
    assert.equal(SAMPLE_RATE, 16000);
    assert.equal(MAX_SECONDS, 120);
  });
});
```
Create `voice-overlay/test/opencode.test.ts`:
```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendRequest, basicAuthHeader, parseAppendResult } from "../src/lib/opencode.js";

describe("appendRequest", () => {
  it("builds the exact live-verified contract", () => {
    const req = appendRequest({ host: "127.0.0.1", port: 4096, username: "", password: "" }, "привет");
    assert.equal(req.url, "http://127.0.0.1:4096/tui/append-prompt");
    assert.equal(req.method, "POST");
    assert.equal(req.body, '{"text":"привет"}');
    assert.equal(req.headers["Content-Type"], "application/json");
    assert.ok(!("Authorization" in req.headers));
  });
  it("adds Basic auth only when username is set", () => {
    const req = appendRequest({ host: "h", port: 1, username: "opencode", password: "s3cret" }, "x");
    assert.equal(req.headers["Authorization"], "Basic " + basicAuthHeader("opencode", "s3cret"));
  });
});

describe("basicAuthHeader", () => {
  it("base64-encodes user:pass", () => {
    assert.equal(basicAuthHeader("opencode", "s3cret"), Buffer.from("opencode:s3cret").toString("base64"));
  });
});

describe("parseAppendResult", () => {
  it("200 true -> inserted", () => {
    assert.equal(parseAppendResult(200, true), "inserted");
  });
  it("401/403 -> unauthorized", () => {
    assert.equal(parseAppendResult(401, false), "unauthorized");
    assert.equal(parseAppendResult(403, true), "unauthorized");
  });
  it("500, 200-false, transport-0 -> fallback", () => {
    assert.equal(parseAppendResult(500, false), "fallback");
    assert.equal(parseAppendResult(200, false), "fallback");
    assert.equal(parseAppendResult(0, false), "fallback");
  });
});
```
Create `voice-overlay/test/errors.test.ts`:
```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ERROR_CODES, errorCopy } from "../src/lib/errors.js";

describe("error catalog", () => {
  it("every code has non-empty Russian copy", () => {
    for (const code of ERROR_CODES) {
      const copy = errorCopy(code);
      assert.ok(copy.length > 10, code);
      assert.match(copy, /[А-Яа-яЁё]/);
    }
  });
  it("catalog is exactly the spec-approved set", () => {
    assert.deepEqual([...ERROR_CODES].sort(), [
      "empty-recording", "empty-transcript", "model-missing", "no-audio-server",
      "no-ffmpeg", "no-mic", "server-unreachable", "too-long",
      "transcribe-failed", "unauthorized",
    ].sort());
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test voice-overlay/test/*.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `../src/lib/*.js` (implementation does not exist yet). This is the correct red state.

- [ ] **Step 3: Write the minimal implementation**

Create `voice-overlay/src/lib/audio.ts`:
```ts
export const SAMPLE_RATE = 16000;
export const CHANNELS = 1;
export const MAX_SECONDS = 120;
/** ~0.5 s of 16 kHz mono s16le; smaller wav files count as empty. */
export const MIN_WAV_BYTES = 16000;

export type OsKind = "linux" | "win32";

const DSHOW_AUDIO_LINE = /"([^"]+)"\s*\(audio\)/g;

export function parseDshowDevices(ffmpegStderr: string): string[] {
  const out: string[] = [];
  for (const m of ffmpegStderr.matchAll(DSHOW_AUDIO_LINE)) {
    const name = m[1];
    if (name !== undefined && !out.includes(name)) out.push(name);
  }
  return out;
}

export function ffmpegInputArgs(os: OsKind, device: string | undefined): string[] {
  if (os === "linux") return ["-f", "pulse", "-i", device ?? "default"];
  if (device !== undefined) return ["-f", "dshow", "-i", `audio=${device}`];
  return ["-f", "wasapi", "-i", "default"];
}

export function ffmpegOutputArgs(wavPath: string): string[] {
  return ["-ar", String(SAMPLE_RATE), "-ac", String(CHANNELS), "-c:a", "pcm_s16le", "-y", wavPath];
}
```
Create `voice-overlay/src/lib/opencode.ts`:
```ts
export interface ServerConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface AppendHttpRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

export type AppendOutcome = "inserted" | "unauthorized" | "fallback";

declare function btoa(s: string): string;

export function appendRequest(cfg: ServerConfig, text: string): AppendHttpRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.username !== "") headers["Authorization"] = "Basic " + basicAuthHeader(cfg.username, cfg.password);
  return {
    url: `http://${cfg.host}:${cfg.port}/tui/append-prompt`,
    method: "POST",
    headers,
    body: JSON.stringify({ text }),
  };
}

export function basicAuthHeader(username: string, password: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(`${username}:${password}`).toString("base64");
  return btoa(`${username}:${password}`);
}

export function parseAppendResult(status: number, ack: boolean): AppendOutcome {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 200 && ack === true) return "inserted";
  return "fallback";
}
```
Create `voice-overlay/src/lib/errors.ts`:
```ts
export const ERROR_CODES = [
  "no-mic",
  "no-ffmpeg",
  "no-audio-server",
  "model-missing",
  "server-unreachable",
  "unauthorized",
  "empty-transcript",
  "empty-recording",
  "too-long",
  "transcribe-failed",
] as const;

export type OverlayErrorCode = (typeof ERROR_CODES)[number];

const COPY: Record<OverlayErrorCode, string> = {
  "no-mic": "Микрофон не найден. Подключи устройство и выбери его в настройках.",
  "no-ffmpeg": "Не найден ffmpeg. Установи его и перезапусти приложение.",
  "no-audio-server": "Нет доступа к звуковому серверу. Проверь PulseAudio или PipeWire: выполни pactl info.",
  "model-missing": "Модель распознавания не скачана. Нажми «Скачать модель» в настройках (нужен интернет один раз).",
  "server-unreachable": "Сервер opencode недоступен. Запусти opencode с фиксированным портом: opencode --port 4096.",
  "unauthorized": "Неверный пароль сервера. Проверь пароль в настройках (OPENCODE_SERVER_PASSWORD).",
  "empty-transcript": "Речь не распознана. Попробуй говорить громче и ближе к микрофону.",
  "empty-recording": "Запись пустая (короче полсекунды). Нажми Record, дождись и потом Stop.",
  "too-long": "Превышен лимит 120 секунд. Запись остановлена автоматически.",
  "transcribe-failed": "Ошибка распознавания. Попробуй ещё раз или выбери модель small в настройках.",
};

export function errorCopy(code: OverlayErrorCode): string {
  return COPY[code];
}
```

- [ ] **Step 4: Compile the libs + tests and run them green**

Create `voice-overlay/tsconfig.test.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "noEmit": false,
    "outDir": "dist-test",
    "rootDir": ".",
    "declaration": false,
    "sourceMap": false,
    "types": ["node"]
  },
  "include": ["src/lib/**/*.ts", "test/**/*.ts"]
}
```
Create `voice-overlay/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "noEmit": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src", "vite.config.ts"]
}
```
Run: `../node_modules/.bin/tsc -p voice-overlay/tsconfig.test.json && node --test voice-overlay/dist-test/test/*.test.js` (from repo root; uses the repo's TypeScript, `@types/node` resolves upward from `voice-overlay/`).
Expected: all suites PASS (3 files, 12 tests). If `@types/node` does not resolve, the executor installs `voice-overlay` deps first (`npm install --prefix voice-overlay`) and reruns — same expectation.

- [ ] **Step 5: Write the UI shell + invoke wrappers + configs**

Create `voice-overlay/package.json`:
```json
{
  "name": "opencode-voice-overlay",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev:frontend": "vite",
    "build:frontend": "vite build",
    "dev": "tauri dev",
    "build": "tauri build",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "tsc -p tsconfig.test.json && node --test dist-test/test/*.test.js"
  },
  "dependencies": {
    "@tauri-apps/api": "^2.0.0",
    "react": "^19.2.8",
    "react-dom": "^19.2.8"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.0.0",
    "@types/node": "^22.0.0",
    "@types/react": "^19.2.18",
    "@types/react-dom": "^19.2.4",
    "@vitejs/plugin-react": "^6.1.0",
    "typescript": "^5.9.0",
    "vite": "^8.2.2"
  }
}
```
Create `voice-overlay/vite.config.ts`:
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  plugins: [react()],
  clearScreen: false,
  server: { port: 1421, strictPort: true },
  build: { outDir: "dist" },
});
```
Create `voice-overlay/index.html`:
```html
<!doctype html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Голосовой ввод</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```
Create `voice-overlay/src/main.tsx`:
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```
Create `voice-overlay/src/api.ts` (Tauri `invoke` maps camelCase arg keys to the Rust snake_case params automatically; `device: null` maps to `None`):
```ts
import { invoke } from "@tauri-apps/api/core";
import type { ServerConfig } from "./lib/opencode";

export type OverlayStatus = "idle" | "recording" | "transcribing" | "error";

export function healthCheck(cfg: ServerConfig): Promise<boolean> {
  return invoke<boolean>("health_check", { host: cfg.host, port: cfg.port });
}

export function appendToPrompt(cfg: ServerConfig, text: string): Promise<boolean> {
  return invoke<boolean>("append_to_prompt", { cfg, text });
}

export function listMicrophones(): Promise<string[]> {
  return invoke<string[]>("list_microphones");
}

export function startRecording(device?: string): Promise<boolean> {
  return invoke<boolean>("start_recording", { device: device ?? null });
}

export function stopRecording(): Promise<string> {
  return invoke<string>("stop_recording");
}

export function transcribe(wav: string, model: string): Promise<string> {
  return invoke<string>("transcribe", { wav, model });
}
```
Create `voice-overlay/src/App.tsx` (static skeleton; full wiring is Task 4):
```tsx
import { useState } from "react";
import type { OverlayStatus } from "./api";

export function App() {
  const [status] = useState<OverlayStatus>("idle");
  return (
    <main>
      <button type="button" disabled>
        Record
      </button>
      <span>{status}</span>
    </main>
  );
}
```

- [ ] **Step 6: Verify full scaffold**

Run: `npm install --prefix voice-overlay` then `npm --prefix voice-overlay run typecheck` and `npm --prefix voice-overlay test`
Expected: typecheck clean, all unit tests PASS.
Verify + report (no commit without explicit request).

---

### Task 2: Tauri backend — config, state, server link

**Files:**
- Create: `voice-overlay/src-tauri/Cargo.toml`, `voice-overlay/src-tauri/tauri.conf.json`, `voice-overlay/src-tauri/build.rs`, `voice-overlay/src-tauri/src/main.rs`, `voice-overlay/src-tauri/.gitignore` (content: `target/\nbinaries/*.wav\n`)

**Interfaces:**
- Consumes: `ServerConfig` shape from Task 1 (Rust mirror struct with identical field names `host/port/username/password`).
- Produces: commands `health_check(host, port)`, `append_to_prompt(cfg, text)`; pure fns `append_url`, `basic_auth_value`, `append_outcome`; `AppState { recording, next_id, app_dir }` (recording slot filled by Task 3).

- [ ] **Step 1: Write the Rust failing tests**

They live in `src-tauri/src/main.rs` under `#[cfg(test)]` (shown in Step 3). First create the files from Steps 2–3, then run `cargo test` and watch the two server-link tests fail against the stubbed outcomes — no, TDD honestly here: write `main.rs` with the pure functions returning wrong values (`append_url` returns `String::new()`, `basic_auth_value` returns `None`, `append_outcome` returns `"fallback"`), run `cargo test`, see exactly 3 failures. Then Step 4 implements them correctly.

- [ ] **Step 2: Write backend configs**

Create `voice-overlay/src-tauri/Cargo.toml`:
```toml
[package]
name = "voice-overlay"
version = "0.1.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
reqwest = { version = "0.12", features = ["json", "rustls-tls"] }
tokio = { version = "1", features = ["process", "time"] }
base64 = "0.22"

[features]
default = ["custom-protocol"]
custom-protocol = ["tauri/custom-protocol"]
```
Create `voice-overlay/src-tauri/build.rs`:
```rust
fn main() {
    tauri_build::build()
}
```
Create `voice-overlay/src-tauri/tauri.conf.json`:
```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Voice Overlay",
  "version": "0.1.0",
  "identifier": "ai.opencode.voice-overlay",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:1421",
    "beforeDevCommand": "npm run dev:frontend",
    "beforeBuildCommand": "npm run build:frontend"
  },
  "app": {
    "windows": [
      {
        "label": "overlay",
        "title": "Голосовой ввод",
        "width": 320,
        "height": 140,
        "resizable": false,
        "decorations": false,
        "alwaysOnTop": true
      }
    ],
    "security": {
      "csp": "default-src 'self'; style-src 'self' 'unsafe-inline'"
    }
  },
  "bundle": {
    "active": true,
    "targets": ["deb", "appimage", "nsis"],
    "externalBin": ["binaries/ffmpeg", "binaries/whisper"]
  }
}
```

- [ ] **Step 3: Write `main.rs` with stubbed pure fns + real commands + tests**

Create `voice-overlay/src-tauri/src/main.rs`:
```rust
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

pub const MAX_SECONDS: u64 = 120;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Default)]
pub struct Recording {
    pub id: u64,
    pub wav: PathBuf,
}

pub struct AppState {
    pub recording: Mutex<Option<Recording>>,
    pub next_id: Mutex<u64>,
    pub app_dir: PathBuf,
}

pub fn append_url(host: &str, port: u16) -> String {
    String::new()
}

pub fn basic_auth_value(username: &str, password: &str) -> Option<String> {
    let _ = (username, password);
    None
}

/// Maps HTTP status + server ack to the TS `AppendOutcome` contract.
pub fn append_outcome(status: u16, ack: bool) -> &'static str {
    let _ = (status, ack);
    "fallback"
}

#[tauri::command]
pub async fn health_check(host: String, port: u16) -> Result<bool, String> {
    let resp = reqwest::get(format!("http://{host}:{port}/global/health"))
        .await
        .map_err(|e| format!("server-unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("server-unreachable: http {}", resp.status()));
    }
    Ok(true)
}

#[tauri::command]
pub async fn append_to_prompt(cfg: ServerConfig, text: String) -> Result<bool, String> {
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

fn main() {
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
        .invoke_handler(tauri::generate_handler![health_check, append_to_prompt])
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
}
```
(`app.path()` needs the `Manager` trait: the file's import block after Task 3 must read exactly:
```rust
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
```
`Stdio`/`AppHandle` are used by Task 3; add all four lines when applying Task 3 so the file compiles after every task.)

- [ ] **Step 4: Run tests to verify they fail**

Run (on the Rust machine): `cargo test -p voice-overlay` (from `voice-overlay/src-tauri/`, plain `cargo test`).
Expected: exactly 3 failures — `url_matches_live_verified_contract`, `basic_auth_encodes_user_pass`, `outcome_mirrors_ts_contract` (stubs return wrong values).

- [ ] **Step 5: Implement the three pure functions**

Replace the stubs with:
```rust
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

pub fn append_outcome(status: u16, ack: bool) -> &'static str {
    if status == 401 || status == 403 {
        return "unauthorized";
    }
    if status == 200 && ack {
        return "inserted";
    }
    "fallback"
}
```

- [ ] **Step 6: Verify green + live server check**

Run: `cargo test`
Expected: all PASS (3 tests).
Run: start `opencode serve --port 4096` on the same machine, then a throwaway check that `health_check` reaches it — via a temporary `#[test]`? No: network tests do not belong in `cargo test`. Instead verify manually once with curl (the command does exactly what the Rust code does):
Run: `curl -s http://127.0.0.1:4096/global/health && curl -s -X POST http://127.0.0.1:4096/tui/append-prompt -H 'Content-Type: application/json' -d '{"text":"overlay-link-ok"}'`
Expected: `{"healthy":true,...}` then `true`.
Verify + report (no commit without explicit request).

---

### Task 3: Recording — devices, start/stop, limits

**Files:**
- Modify: `voice-overlay/src-tauri/src/main.rs` (append recording section + register 3 commands in `generate_handler!`)

**Interfaces:**
- Consumes: `AppState.recording`, `AppState.next_id`, `AppState.app_dir` from Task 2; behavior contracts of TS `parseDshowDevices`/`ffmpegInputArgs` from Task 1 (Rust mirrors must produce identical outputs for identical inputs).
- Produces: commands `list_microphones()`, `start_recording(device)`, `stop_recording()`; pure fns `parse_dshow_devices`, `ffmpeg_input_args`, `sidecar_file`; `Recording { id, wav, child, started }`.

- [ ] **Step 1: Write the failing Rust tests**

Append to the existing `#[cfg(test)] mod tests` in `main.rs`:
```rust
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test`
Expected: FAIL with `cannot find function parse_dshow_devices / ffmpeg_input_args / sidecar_file` (3 unresolved-name errors). Correct red state.

- [ ] **Step 3: Implement recording**

Extend the `Recording` struct (replace the Task 2 version):
```rust
#[derive(Debug)]
pub struct Recording {
    pub id: u64,
    pub wav: PathBuf,
    pub child: tokio::process::Child,
    pub started: std::time::Instant,
}
```
(`Recording` no longer derives `Default`/`Clone` — remove those derives; `Child` is neither.)
Append this implementation block to `main.rs` (the `use` lines already live in the top import block per the note in Task 2 Step 3 — do not repeat them):
```rust
pub const MIN_WAV_BYTES: u64 = 16000;

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
    let v: Vec<&str> = match (os, device) {
        ("linux", d) => vec!["-f", "pulse", "-i", d.unwrap_or("default")],
        (_, Some(d)) => vec!["-f", "dshow", "-i", &format!("audio={d}")],
        _ => vec!["-f", "wasapi", "-i", "default"],
    };
    // NOTE: `vec!["-f", ..., &format!(...)]` mixes &str and &String — write it as owned Strings:
    v.into_iter().map(str::to_string).collect()
}
```
Wait — that `vec!` mixes types and will not compile. Write it correctly the first time:
```rust
pub fn ffmpeg_input_args(os: &str, device: Option<&str>) -> Vec<String> {
    match (os, device) {
        ("linux", d) => vec!["-f".to_string(), "pulse".to_string(), "-i".to_string(), d.unwrap_or("default").to_string()],
        (_, Some(d)) => vec!["-f".to_string(), "dshow".to_string(), "-i".to_string(), format!("audio={d}")],
        _ => vec!["-f".to_string(), "wasapi".to_string(), "-i".to_string(), "default".to_string()],
    }
}
```
Continue appending:
```rust
pub fn sidecar_file(base: &str) -> Result<String, String> {
    let triple = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        ("linux", "aarch64") => "aarch64-unknown-linux-gnu",
        ("windows", "x86_64") => "x86_64-pc-windows-msvc.exe",
        ("windows", "aarch64") => "aarch64-pc-windows-msvc.exe",
        (os, arch) => return Err(format!("unsupported-os: {os}/{arch}")),
    };
    Ok(format!("{base}-{triple}"))
}

fn sidecar_path(app: &AppHandle, base: &str) -> Result<PathBuf, String> {
    let name = sidecar_file(base)?;
    app.path()
        .resource_dir()
        .map_err(|e| format!("no-ffmpeg: {e}"))?
        .join(&name)
        .pipe_exists()
}

trait PipeExists {
    fn pipe_exists(self) -> Result<PathBuf, String>;
}

impl PipeExists for PathBuf {
    fn pipe_exists(self) -> Result<PathBuf, String> {
        if self.exists() {
            Ok(self)
        } else {
            Err(format!("no-ffmpeg: sidecar missing: {}", self.display()))
        }
    }
}
```
Hmm — the cute `pipe_exists` trait is over-clever; reviewers will flag it. Replace with a plain check. Use this instead:
```rust
fn sidecar_path(app: &AppHandle, base: &str) -> Result<PathBuf, String> {
    let name = sidecar_file(base)?;
    let path = app
        .path()
        .resource_dir()
        .map_err(|e| format!("no-ffmpeg: {e}"))?
        .join(&name);
    if path.exists() {
        Ok(path)
    } else {
        Err(format!("no-ffmpeg: sidecar missing: {}", path.display()))
    }
}
```
(This replaces the trait version — do NOT include the trait.)
Commands:
```rust
#[tauri::command]
pub async fn list_microphones(app: AppHandle) -> Result<Vec<String>, String> {
    if std::env::consts::OS != "windows" {
        return Ok(Vec::new());
    }
    let ffmpeg = sidecar_path(&app, "binaries/ffmpeg")?;
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
pub async fn start_recording(
    app: AppHandle,
    state: State<'_, AppState>,
    device: Option<String>,
) -> Result<bool, String> {
    {
        if state.recording.lock().map_err(|e| e.to_string())?.is_some() {
            return Err("busy: запись уже идёт".to_string());
        }
    }
    let wav = state
        .app_dir
        .join(format!("record-{}.wav", chrono_free_id(&state)?));
```
No — do not invent a `chrono_free_id` helper (undeclared reference = plan bug). Use the `next_id` counter already in state:
```rust
#[tauri::command]
pub async fn start_recording(
    app: AppHandle,
    state: State<'_, AppState>,
    device: Option<String>,
) -> Result<bool, String> {
    let id = {
        let mut slot = state.recording.lock().map_err(|e| e.to_string())?;
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
    let ffmpeg = sidecar_path(&app, "binaries/ffmpeg").map_err(|_| {
        // Dev fallback: system ffmpeg from PATH before sidecars are packaged (Task 5).
        "binaries/ffmpeg".to_string()
    });
```
No — `map_err` returning a String then using it as a path is type soup. Write it plainly:
```rust
    let ffmpeg: PathBuf = match sidecar_path(&app, "binaries/ffmpeg") {
        Ok(p) => p,
        Err(_) => PathBuf::from("ffmpeg"),
    };
    let mut child = tokio::process::Command::new(ffmpeg)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("no-ffmpeg: не удалось запустить ffmpeg: {e}"))?;
    if child.stdin.take().is_none() {
        let _ = child.kill().await;
        return Err("transcribe-failed: нет доступа к stdin ffmpeg".to_string());
    }
```
Careful — taking stdin out and dropping it closes the pipe immediately, which may make ffmpeg exit on some builds. Keep the stdin handle inside `Recording` instead:
```rust
pub struct Recording {
    pub id: u64,
    pub wav: PathBuf,
    pub child: tokio::process::Child,
    pub started: std::time::Instant,
}
```
Store the child WITH stdin still attached (do not take it here). Take it in `stop_recording` to write `q`. Corrected start tail:
```rust
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
        let kill = match app_clone.state::<AppState>().recording.lock() {
            Ok(mut slot) => match slot.as_mut() {
                Some(rec) if rec.id == id => true,
                _ => false,
            },
            Err(_) => false,
        };
        if kill {
            if let Ok(mut slot) = app_clone.state::<AppState>().recording.lock() {
                if let Some(rec) = slot.as_mut() {
                    if rec.id == id {
                        let _ = rec.child.kill().await;
                    }
                }
            }
        }
    });
    Ok(true)
}

#[tauri::command]
pub async fn stop_recording(state: State<'_, AppState>) -> Result<String, String> {
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
        return Err("empty-recording: запись пустая (короче полсекунды). Нажми Record, дождись и потом Stop.".to_string());
    }
    Ok(rec.wav.to_string_lossy().into_owned())
}
```
(`use tokio::io::AsyncWriteExt as _;` inside the function body is legal Rust.)
Finally register the commands — change the Task 2 handler line to:
```rust
.invoke_handler(tauri::generate_handler![
    health_check,
    append_to_prompt,
    list_microphones,
    start_recording,
    stop_recording
])
```

- [ ] **Step 4: Run tests green**

Run: `cargo test`
Expected: all PASS (3 old + 3 new = 6 tests).

- [ ] **Step 5: Fixture recording check (no microphone needed)**

Run (Linux machine with system ffmpeg; uses the `VOICE_FFMPEG_TEST_INPUT` override path — a real `start_recording` equivalent at CLI level):
Run: `ffmpeg -f lavfi -i "sine=frequency=440:duration=2" -ar 16000 -ac 1 -c:a pcm_s16le -y /tmp/voice-probe.wav && python3 -c "import os; print(os.path.getsize('/tmp/voice-probe.wav'))"`
Expected: size ≥ 64000 bytes (2 s × 16000 × 2 bytes), proving the exact output profile from `ffmpegOutputArgs` produces a valid wav. (True command-level E2E runs in Task 5 with the packaged app.)
Verify + report (no commit without explicit request).

---

### Task 4: Transcribe + full UI wiring

**Files:**
- Modify: `voice-overlay/src-tauri/src/main.rs` (append `transcribe` command + `allowed_model_file` pure fn + tests + handler registration), `voice-overlay/src/App.tsx` (full rewrite below), create `voice-overlay/src/settings.tsx`.

**Interfaces:**
- Consumes: all Task 1–3 APIs. `transcribe(wav, model)` returns the trimmed transcript text or `Err` with an `OverlayErrorCode`-prefixed message (`"<code>: <human text>"` — the UI splits on the first `": "` to recover the code).
- Produces: finished overlay window behavior per Spec Section 2.

- [ ] **Step 1: Reconcile whisper flags with the vendored binary (target machine)**

Run: `<path-to-whisper-sidecar> --help | head -40`
Expected: flags `-m`, `-l`, `-f`, `-otxt`, `-of` exist with the meanings used below. If any flag differs, adjust ONLY the `args` array in the `transcribe` implementation in Step 3 (same values, same order otherwise) and record the deviation in `voice-overlay/README.md`. Do not redesign the command.

- [ ] **Step 2: Write the failing Rust tests**

Append to `mod tests`:
```rust
#[test]
fn model_allowlist_maps_to_ggml_files() {
    assert_eq!(allowed_model_file("base"), Ok("ggml-base.bin".to_string()));
    assert_eq!(allowed_model_file("small"), Ok("ggml-small.bin".to_string()));
    assert!(allowed_model_file("../../etc/passwd").is_err());
    assert!(allowed_model_file("large").is_err());
}
```

- [ ] **Step 3: Implement `transcribe` (append to `main.rs`)**

```rust
pub fn allowed_model_file(model: &str) -> Result<String, String> {
    match model {
        "base" => Ok("ggml-base.bin".to_string()),
        "small" => Ok("ggml-small.bin".to_string()),
        _ => Err("transcribe-failed: неизвестная модель. Выбери base или small.".to_string()),
    }
}

#[tauri::command]
pub async fn transcribe(
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
    let whisper = sidecar_path(&app, "binaries/whisper")?;
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
```
Register it: add `transcribe` to the `generate_handler![...]` list.
Run: `cargo test`
Expected: all PASS (7 tests).

- [ ] **Step 4: Write the settings component**

Create `voice-overlay/src/settings.tsx`:
```tsx
import { useState } from "react";
import type { ServerConfig } from "./lib/opencode";

export interface OverlaySettings extends ServerConfig {
  device: string;
  model: string;
}

const DEFAULTS: OverlaySettings = {
  host: "127.0.0.1",
  port: 4096,
  username: "",
  password: "",
  device: "",
  model: "base",
};

const KEY = "voice-overlay-settings:v1";

export function loadSettings(): OverlaySettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return DEFAULTS;
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<OverlaySettings>) };
  } catch {
    return DEFAULTS;
  }
}

export function SettingsView(props: {
  settings: OverlaySettings;
  devices: string[];
  onChange: (next: OverlaySettings) => void;
  onBack: () => void;
}) {
  const [draft, setDraft] = useState<OverlaySettings>(props.settings);
  const set = (patch: Partial<OverlaySettings>) => setDraft((d) => ({ ...d, ...patch }));
  return (
    <main>
      <h1>Настройки</h1>
      <label>
        Хост
        <input value={draft.host} onChange={(e) => set({ host: e.target.value })} />
      </label>
      <label>
        Порт
        <input
          type="number"
          value={draft.port}
          onChange={(e) => set({ port: Number(e.target.value) || 4096 })}
        />
      </label>
      <label>
        Пользователь
        <input value={draft.username} onChange={(e) => set({ username: e.target.value })} />
      </label>
      <label>
        Пароль
        <input
          type="password"
          value={draft.password}
          onChange={(e) => set({ password: e.target.value })}
        />
      </label>
      <label>
        Микрофон
        <select value={draft.device} onChange={(e) => set({ device: e.target.value })}>
          <option value="">По умолчанию</option>
          {props.devices.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>
      <label>
        Модель
        <select value={draft.model} onChange={(e) => set({ model: e.target.value })}>
          <option value="base">base — быстрее (~140 МБ)</option>
          <option value="small">small — точнее (~460 МБ)</option>
        </select>
      </label>
      <button
        type="button"
        onClick={() => {
          localStorage.setItem(KEY, JSON.stringify(draft));
          props.onChange(draft);
        }}
      >
        Сохранить
      </button>
      <button type="button" onClick={props.onBack}>
        Назад
      </button>
    </main>
  );
}
```

- [ ] **Step 5: Wire the full App (replace the Task 1 skeleton)**

Replace `voice-overlay/src/App.tsx` with:
```tsx
import { useEffect, useRef, useState } from "react";
import {
  appendToPrompt,
  listMicrophones,
  startRecording,
  stopRecording,
  transcribe,
  type OverlayStatus,
} from "./api";
import { errorCopy, type OverlayErrorCode } from "./lib/errors";
import { MAX_SECONDS } from "./lib/audio";
import { loadSettings, SettingsView, type OverlaySettings } from "./settings";

function codeOf(message: string): OverlayErrorCode | null {
  const head = message.split(": ")[0];
  const codes: OverlayErrorCode[] = [
    "no-mic", "no-ffmpeg", "no-audio-server", "model-missing",
    "server-unreachable", "unauthorized", "empty-transcript",
    "empty-recording", "too-long", "transcribe-failed",
  ];
  return (codes as string[]).includes(head ?? "") ? (head as OverlayErrorCode) : null;
}

export function App() {
  const [settings, setSettings] = useState<OverlaySettings>(loadSettings);
  const [devices, setDevices] = useState<string[]>([]);
  const [status, setStatus] = useState<OverlayStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<string>("");
  const [showSettings, setShowSettings] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    listMicrophones().then(setDevices).catch(() => setDevices([]));
  }, []);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const fail = (message: string) => {
    const code = codeOf(message);
    setError(code !== null ? errorCopy(code) : message);
    setStatus("error");
  };

  const onRecord = async () => {
    setError(null);
    setNotice(null);
    setPreview("");
    try {
      await startRecording(settings.device === "" ? undefined : settings.device);
    } catch (e) {
      fail(String(e));
      return;
    }
    setStatus("recording");
    timer.current = window.setTimeout(() => {
      void onStop(true);
    }, MAX_SECONDS * 1000);
  };

  const onStop = async (auto = false) => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setStatus("transcribing");
    let wav: string;
    try {
      wav = await stopRecording();
    } catch (e) {
      fail(String(e));
      return;
    }
    let text: string;
    try {
      text = await transcribe(wav, settings.model);
    } catch (e) {
      fail(String(e));
      return;
    }
    setPreview(text);
    try {
      await appendToPrompt(settings, text);
      setNotice(auto ? "Достигнут лимит 120 секунд — вставлено в промпт" : "Вставлено в промпт");
      setStatus("idle");
    } catch (e) {
      const message = String(e);
      if (message.startsWith("fallback:") || message.startsWith("server-unreachable:")) {
        try {
          await navigator.clipboard.writeText(text);
          setNotice("Сервер недоступен — текст скопирован в буфер обмена");
        } catch {
          setNotice("Сервер недоступен — скопируй текст вручную");
        }
        setStatus("idle");
        return;
      }
      fail(message);
    }
  };

  if (showSettings) {
    return (
      <SettingsView
        settings={settings}
        devices={devices}
        onChange={(next) => {
          setSettings(next);
          setShowSettings(false);
        }}
        onBack={() => setShowSettings(false)}
      />
    );
  }

  const busy = status === "recording" || status === "transcribing";
  return (
    <main>
      {status === "recording" ? (
        <button type="button" onClick={() => void onStop(false)}>
          Stop
        </button>
      ) : (
        <button type="button" disabled={busy} onClick={() => void onRecord()}>
          Record
        </button>
      )}
      <button type="button" disabled={busy} onClick={() => setShowSettings(true)}>
        ⚙
      </button>
      <span>{status}</span>
      {preview !== "" && <p>{preview}</p>}
      {notice !== null && <p>{notice}</p>}
      {error !== null && <p role="alert">{error}</p>}
    </main>
  );
}
```

- [ ] **Step 6: Verify UI task**

Run: `npm --prefix voice-overlay run typecheck`
Expected: clean.
Run: `npm --prefix voice-overlay test`
Expected: all unit tests PASS (no regressions from Task 1).
Verify + report (no commit without explicit request).

---

### Task 5: Packaging, docs, verification matrix

**Files:**
- Create: `voice-overlay/src-tauri/binaries/.gitkeep` (+ real sidecar binaries per platform, see Step 1), `voice-overlay/README.md`
- Modify: root `package.json` (add exactly two scripts)

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: installable artifacts + closed verification.

- [ ] **Step 1: Vendor the sidecar binaries**

Place these exact files (names are load-bearing — `sidecar_file` in Task 3 constructs them):
- `voice-overlay/src-tauri/binaries/ffmpeg-x86_64-unknown-linux-gnu` (Linux static build, e.g. from https://johnvansickle.com/ffmpeg/)
- `voice-overlay/src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe` (Windows essentials build, e.g. from https://www.gyan.dev/ffmpeg/builds/)
- `voice-overlay/src-tauri/binaries/whisper-x86_64-unknown-linux-gnu` and `voice-overlay/src-tauri/binaries/whisper-x86_64-pc-windows-msvc.exe` (matching whisper.cpp release from https://github.com/ggerganov/whisper.cpp/releases, flag reconciliation from Task 4 Step 1 applies)
- ggml models are NOT bundled: first-run download to the app-data `models/` dir from https://huggingface.co/ggerganov/whisper.cpp (`ggml-base.bin`, `ggml-small.bin`) with sha256 check. (The in-app «Скачать модель» button is a documented v1 gap: this task ships a `voice-overlay/README.md` section with the exact manual download commands; the button itself is the first follow-up, not this plan.)
- [ ] **Step 2: Wire root scripts**

In root `package.json` `scripts`, add exactly:
```json
"dev:voice": "npm --prefix voice-overlay run dev",
"build:voice": "npm --prefix voice-overlay run build",
```
Placed alphabetically next to the existing `dev:dashboard`/`build:dashboard` lines. Nothing else in the root file changes.

- [ ] **Step 3: Write `voice-overlay/README.md`**

Contents (no placeholders — real commands): prerequisites per OS (Rust via rustup `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y` / `winget install Rustlang.Rustup`; system ffmpeg for dev; Node 22+), model download commands with exact URLs, the `opencode --port 4096` precondition, dev (`npm run dev:frontend`, `cargo check`) and bundle (`npm run build`) commands, the manual E2E checklist from Step 5, and the known v1 gaps (no in-app model-download button, no global hotkey, nsis built only on Windows).

- [ ] **Step 4: Static verification (all green)**

Run: `npm --prefix voice-overlay run typecheck`
Expected: clean.
Run: `npm --prefix voice-overlay test`
Expected: all PASS.
Run (Rust machine): `cargo check && cargo test` in `voice-overlay/src-tauri/`
Expected: clean + 7 PASS.
Run (Linux machine): `npm run build:voice` (repo root)
Expected: `deb` + `appimage` artifacts emitted; no changes to `dist/` or `dashboard-dist/` (verify with `git status --porcelain` showing only `voice-overlay/` + root `package.json` + docs).

- [ ] **Step 5: Manual E2E matrix (human, target machines)**

| # | Действие | Ожидание |
|---|----------|----------|
| 1 | Открыть `opencode --port 4096`, нажать Record, 5 с русской речи, Stop | Текст в промпте TUI, статус idle, превью совпадает |
| 2 | Остановить сервер, повторить | Текст в буфере обмена + notice про буфер |
| 3 | Неверный пароль в настройках, повторить | `unauthorized`-текст из каталога |
| 4 | Stop без Record | `idle`-ошибка не падает, окно остаётся в idle (backend вернул `idle:…`, UI показывает текст как есть) |
| 5 | `serve` без TUI, повторить | Ответ `true`, текст теряется — подтверждает предусловие живого TUI (не баг) |
| 6 | 121 с записи | Автостоп на 120 с, notice про лимит |

Verify + report (no commit without explicit request).

---

### Task 6: Web target — sessions delivery (`opencode web`)

**Spec:** `docs/superpowers/specs/2026-09-07-voice-overlay-design.md`, Section 6. Read it before touching code.

**Endpoint choice (locked from live docs 2026-09-07, `https://opencode.ai/docs/server/`):** `POST /session/:id/prompt_async` (same body as `/session/:id/message`, returns 204, no wait). NOT `POST /session/:id/message` — it waits for the model response and would hang the overlay. Body: `{ parts: [{ type: "text", text }] }`. Sessions: `GET /session` → `Session[]`. Part shape + field names are reconciled against live `/doc` on the toolchain machine before release (Step 1); if they differ, adjust ONLY the payload constructors below and record the deviation in `voice-overlay/README.md`.

**Files:**
- Modify: `voice-overlay/src/lib/opencode.ts` (append web section), `voice-overlay/src/api.ts` (+2 fns), `voice-overlay/src/lib/errors.ts` (+2 codes), `voice-overlay/test/errors.test.ts` (10 → 12), `voice-overlay/src/settings.tsx` (target + sessionId), `voice-overlay/src/App.tsx` (branch after preview), `voice-overlay/src-tauri/src/main.rs` (+2 commands, +2 pure fns, +3 tests, handler), `voice-overlay/README.md` (web section)
- Create: `voice-overlay/test/web.test.ts`

**Interfaces:**
- Consumes: `ServerConfig`, `basicAuthHeader` (Task 1); `Recording`/`AppState` untouched; error contract `"<code>: <text>"` unchanged.
- Produces: `Target = "tui" | "web"`, `SessionRef { id: string; title: string }`, `sessionListRequest(cfg)`, `sessionMessageRequest(cfg, sessionId, text)`, `parseSessionList(json: unknown): SessionRef[]`, `parseSendResult(status: number): "sent" | "unauthorized" | "session-not-found" | "fallback"`, api `listSessions(cfg)`, `sendToSession(cfg, sessionId, text)`, Rust `session_url`, `message_url`, commands `list_sessions`, `send_to_session`.

- [ ] **Step 1: Reconcile with live `/doc` (toolchain machine with `opencode web` running)**

Run: `curl -s http://127.0.0.1:4096/doc | python3 -c "import sys,json; d=json.load(sys.stdin); ps=d.get('paths',d); print('\n'.join(sorted(ps.keys())))" | grep -E "session" | head -20`
Expected: paths include `/session` (get) and `/session/{id}/prompt_async` (post). Then fetch the post schema and check the `parts` item shape contains a text field named `text` with a discriminator `type: "text"`. If the shape differs (e.g. `content` instead of `parts`), adjust ONLY `sessionMessageRequest` (TS) and `send_to_session` (Rust) payload literals, keep field order, and append the deviation to `voice-overlay/README.md` web section. Do not redesign.

- [ ] **Step 2: Write the failing TS tests**

Create `voice-overlay/test/web.test.ts`:
```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSendResult,
  parseSessionList,
  sessionListRequest,
  sessionMessageRequest,
} from "../src/lib/opencode.js";

const CFG = { host: "127.0.0.1", port: 4096, username: "", password: "" };

describe("sessionListRequest", () => {
  it("GETs /session with JSON content type", () => {
    const req = sessionListRequest(CFG);
    assert.equal(req.url, "http://127.0.0.1:4096/session");
    assert.equal(req.method, "GET");
    assert.equal(req.headers["Content-Type"], "application/json");
  });
});

describe("sessionMessageRequest", () => {
  it("POSTs text part to prompt_async (204, no wait)", () => {
    const req = sessionMessageRequest(CFG, "ses_123", "привет");
    assert.equal(req.url, "http://127.0.0.1:4096/session/ses_123/prompt_async");
    assert.equal(req.method, "POST");
    assert.equal(req.body, JSON.stringify({ parts: [{ type: "text", text: "привет" }] }));
  });
  it("URL-encodes the session id", () => {
    const req = sessionMessageRequest(CFG, "a/b c", "x");
    assert.ok(req.url.includes("/session/a%2Fb%20c/prompt_async"), req.url);
  });
});

describe("parseSessionList", () => {
  it("extracts id+title, falls back to id", () => {
    assert.deepEqual(
      parseSessionList([{ id: "s1", title: "Shop" }, { id: "s2" }]),
      [{ id: "s1", title: "Shop" }, { id: "s2", title: "s2" }],
    );
  });
  it("rejects non-arrays and items without id", () => {
    assert.deepEqual(parseSessionList({}), []);
    assert.deepEqual(parseSessionList([{ title: "x" }]), []);
    assert.deepEqual(parseSessionList(null), []);
  });
});

describe("parseSendResult", () => {
  it("2xx -> sent", () => {
    assert.equal(parseSendResult(200), "sent");
    assert.equal(parseSendResult(204), "sent");
  });
  it("401/403 -> unauthorized, 404 -> session-not-found", () => {
    assert.equal(parseSendResult(401), "unauthorized");
    assert.equal(parseSendResult(403), "unauthorized");
    assert.equal(parseSendResult(404), "session-not-found");
  });
  it("rest -> fallback", () => {
    assert.equal(parseSendResult(500), "fallback");
    assert.equal(parseSendResult(0), "fallback");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm --prefix voice-overlay test`
Expected: FAIL — `web.test.ts` fails with `ERR_MODULE_NOT_FOUND` for `sessionListRequest` etc. (all 15 old tests still PASS). Correct red state.

- [ ] **Step 4: Implement TS web section (append to `src/lib/opencode.ts`)**

```ts
export type Target = "tui" | "web";

export interface SessionRef {
  id: string;
  title: string;
}

export interface SessionHttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

function authHeaders(cfg: ServerConfig): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.username !== "") headers["Authorization"] = "Basic " + basicAuthHeader(cfg.username, cfg.password);
  return headers;
}

export function sessionListRequest(cfg: ServerConfig): SessionHttpRequest {
  return {
    url: `http://${cfg.host}:${cfg.port}/session`,
    method: "GET",
    headers: authHeaders(cfg),
  };
}

export function sessionMessageRequest(cfg: ServerConfig, sessionId: string, text: string): SessionHttpRequest {
  return {
    url: `http://${cfg.host}:${cfg.port}/session/${encodeURIComponent(sessionId)}/prompt_async`,
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify({ parts: [{ type: "text", text }] }),
  };
}

export type SendOutcome = "sent" | "unauthorized" | "session-not-found" | "fallback";

export function parseSendResult(status: number): SendOutcome {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "session-not-found";
  if (status >= 200 && status < 300) return "sent";
  return "fallback";
}

export function parseSessionList(json: unknown): SessionRef[] {
  if (!Array.isArray(json)) return [];
  const out: SessionRef[] = [];
  for (const item of json) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec["id"] !== "string" || rec["id"] === "") continue;
    const id = rec["id"];
    const title = typeof rec["title"] === "string" && rec["title"] !== "" ? rec["title"] : id;
    if (!out.some((s) => s.id === id)) out.push({ id, title });
  }
  return out;
}
```

- [ ] **Step 5: Wire api/settings/errors/App**

Append to `voice-overlay/src/api.ts`:
```ts
import type { ServerConfig, SessionRef } from "./lib/opencode";

export function listSessions(cfg: ServerConfig): Promise<SessionRef[]> {
  return invoke<SessionRef[]>("list_sessions", { cfg });
}

export function sendToSession(cfg: ServerConfig, sessionId: string, text: string): Promise<boolean> {
  return invoke<boolean>("send_to_session", { cfg, sessionId, text });
}
```
(Note: extend the existing `import type { ServerConfig }` line — do not add a second import from the same module.)
In `voice-overlay/src/lib/errors.ts`: add `"no-session"` and `"session-not-found"` to `ERROR_CODES` + COPY entries `"no-session": "Нет ни одной сессии. Создай сессию в opencode web и обнови список."`, `"session-not-found": "Сессия не найдена (удалена?). Обнови список и выбери снова."`.
In `voice-overlay/test/errors.test.ts`: update the expected sorted list to 12 entries (add `"no-session"`, `"session-not-found"`).
In `voice-overlay/src/settings.tsx`: extend `OverlaySettings` with `target: Target; sessionId: string`, DEFAULTS with `target: "tui", sessionId: ""` (existing `loadSettings` merge already migrates old stored settings), `SettingsView` props with `sessions: SessionRef[]`, add target radio (`tui` — «TUI-промпт», `web` — «Web-сессия») + session `<select>` (hidden+disabled when `target === "tui"`, options from `props.sessions`, first option `value=""` — «Выбери сессию»).
In `voice-overlay/src/App.tsx`: extend `codeOf` list with the 2 new codes; add `sessions` state + `loadSessions()` (calls `listSessions(settings)` on mount, on settings save, and on `showSettings` close; failure → `[]`); pass `sessions` to `SettingsView`; after transcribe: `if (settings.target === "web") { setPreview(text); setNotice(auto ? "Достигнут лимит 120 секунд — нажми «Отправить в сессию»" : "Проверь текст и нажми «Отправить в сессию»"); setStatus("idle"); return; }` (NO auto-send — spec rule); render send button when `preview !== "" && settings.target === "web" && status === "idle"`: disabled when `settings.sessionId === ""`, onClick → `sendToSession(settings, settings.sessionId, preview)` → notice «Отправлено в сессию» + `setPreview("")`; on error: `session-not-found:` → `fail` (re-pick), `fallback:/server-unreachable:` → clipboard fallback (same as TUI). Switching `target` clears `error` and sets `status` to `"idle"` (spec: смена таргета сбрасывает ошибку).

- [ ] **Step 6: Implement Rust commands (append to `src-tauri/src/main.rs`)**

Pure fns + tests:
```rust
pub fn session_url(host: &str, port: u16) -> String {
    format!("http://{host}:{port}/session")
}

pub fn message_url(host: &str, port: u16, session_id: &str) -> String {
    format!("http://{host}:{port}/session/{session_id}/prompt_async")
}
```
(`session_id` is inserted raw — the TS side `encodeURIComponent`s; Rust receives the already-encoded id from `sendToSession`. Document with a one-line comment.)
Tests to append in `mod tests`:
```rust
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
```
with:
```rust
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
```
Commands:
```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub title: String,
}

#[tauri::command]
pub async fn list_sessions(cfg: ServerConfig) -> Result<Vec<SessionInfo>, String> {
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
pub async fn send_to_session(cfg: ServerConfig, session_id: String, text: String) -> Result<bool, String> {
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
```
Register `list_sessions, send_to_session` in `generate_handler![...]`.

- [ ] **Step 7: README web section + verify**

Append to `voice-overlay/README.md` a `## Web-таргет (opencode web)` section: `opencode web --port 4096` precondition, target switch, session picker, explicit-send rule, endpoint choice rationale (`prompt_async` 204 no-wait vs blocking `/message`), `/doc` reconciliation status + any deviation.
Run: `npm --prefix voice-overlay run typecheck` (clean) + `npm --prefix voice-overlay test` (all PASS incl. new `web.test.ts`, updated `errors.test.ts` with 12 codes).
Run (Rust machine): `cargo test` — all PASS (9 tests: 7 old + 2 new).
Verify + report (no commit without explicit request).

---

### Task 7: Delivery — кнопка из `bunx install` (Section 7)

**Spec:** `docs/superpowers/specs/2026-09-07-voice-overlay-design.md`, Section 7. Read it before touching code.

**Precedents (verified in repo, follow them):** per-platform `optionalDependencies` with `os`/`cpu` (see `lightningcss-*` in root `package.json`); `ensureX()` provisioning in `src/cli.ts` (`ensureCodebaseMemory`, `ensureUv`) with `{ command, status }` + `failureReason` catch wrapper; optional install flags (`git?`, `astGrep?`, `superpowers?` — undefined means enabled, `options.X !== false` check); installer report lines via `dependencyLine()` in `main()`; doctor `Check` shape `{ id, label, status, detail, hint? }` pushed in `runDoctor` (`src/diagnostics/doctor.ts`).

**Files:**
- Create: `.github/workflows/voice-overlay.yml`, `voice-overlay/packaging/linux-x64/package.json`, `voice-overlay/packaging/linux-arm64/package.json`, `voice-overlay/packaging/win32-x64/package.json`, `scripts/pack-voice-overlay.mjs`, `test/voice.test.ts`
- Modify: root `package.json` (3 `optionalDependencies`, exact pins), `src/cli.ts`, `src/diagnostics/doctor.ts`, `test/cli.test.ts`, `test/doctor.test.ts`, `README.md` (install section)

**Interfaces:**
- Consumes: `ProvisionedDependency`, `failureReason`, `localBinCandidates` (all existing in `src/cli.ts`); `openCodePackagesRoot()`; root `package.json` `version` (now `2.0.1`) as the lockstep pin source; `node:fs` existence checks (never spawn the Tauri binary for probing — unknown flags open its window).
- Produces: `voiceOverlayPackageFor(platform: string, arch: string): string | null`, `voiceBinaryName(platform)`, `voiceOverlayTriple(platform, arch): string | null` (identical to Rust `sidecar_file`), `voiceSidecarNames(platform, arch)`, `voiceManagedDir(platform, env): string | null` (`~/.local/bin` on Linux, `%LOCALAPPDATA%\Programs\voice-overlay` on Windows — sidecars must sit next to the binary because Tauri resolves them exe-adjacent), `VOICE_MODEL_URL`, `VOICE_MODEL_FILE`, `provisionVoiceOverlay(shouldProvision: boolean)`, `InstallOptions.voice?: boolean`, `InstallResult["dependencies"]["voice"]`, doctor check `id: "voice-overlay"`, CLI flag `--no-voice`.

- [ ] **Step 1: Write the failing tests**

Create `test/voice.test.ts`:
```ts
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { voiceOverlayPackageFor, VOICE_MODEL_URL } from "../src/voice.js"

describe("voiceOverlayPackageFor", () => {
  it("maps supported platforms to sidecar package names", () => {
    assert.equal(voiceOverlayPackageFor("linux", "x64"), "@oeronteros-1/voice-overlay-linux-x64")
    assert.equal(voiceOverlayPackageFor("linux", "arm64"), "@oeronteros-1/voice-overlay-linux-arm64")
    assert.equal(voiceOverlayPackageFor("win32", "x64"), "@oeronteros-1/voice-overlay-win32-x64")
  })
  it("returns null for unsupported platforms", () => {
    assert.equal(voiceOverlayPackageFor("darwin", "arm64"), null)
    assert.equal(voiceOverlayPackageFor("win32", "arm64"), null)
    assert.equal(voiceOverlayPackageFor("freebsd", "x64"), null)
  })
})

describe("VOICE_MODEL_URL", () => {
  it("points at the whisper.cpp ggml base model", () => {
    assert.equal(VOICE_MODEL_URL, "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin")
  })
})
```
Append to `test/cli.test.ts` (next to the other `install()` cases):
```ts
test("installer skips voice overlay with voice:false", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-voice-"))
  const result = await install({ configDirectory: directory, context7: false, codebaseMemory: false, memoryGraph: false, git: false, astGrep: false, playwright: false, superpowers: false, voice: false, provisionDependencies: true, force: false, dryRun: false, pluginCacheDirectory: path.join(directory, "packages") })
  assert.equal(result.dependencies.voice.status, "skipped")
})
```
(`mkdtemp`, `os`, `path` already imported in `test/cli.test.ts`; place the case next to the other `install()` cases.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsc -p tsconfig.test.json` (from repo root)
Expected: FAIL with `TS2307: Cannot find module '../src/voice.js'` (feature missing, not a typo). Correct red state.

- [ ] **Step 3: Implement `src/voice.ts` (new, pure logic only)**

```ts
const SCOPE = "@oeronteros-1/voice-overlay"

export const VOICE_MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"

export const VOICE_MODEL_FILE = "ggml-base.bin"

export function voiceOverlayPackageFor(platform: string, arch: string): string | null {
  if (platform === "linux" && arch === "x64") return `${SCOPE}-linux-x64`
  if (platform === "linux" && arch === "arm64") return `${SCOPE}-linux-arm64`
  if (platform === "win32" && arch === "x64") return `${SCOPE}-win32-x64`
  return null
}

export function voiceBinaryName(platform: string): string {
  return platform === "win32" ? "voice-overlay.exe" : "voice-overlay"
}
```
(No fs/network here — resolution + download live in `provisionVoiceOverlay` in `src/cli.ts`, next step.)

- [ ] **Step 4: Wire CLI (`src/cli.ts`)**

1. `InstallOptions`: add `/** Provision the prebuilt voice-overlay button binary; false explicitly disables it. */ voice?: boolean` after the `superpowers?` line.
2. `InstallResult["dependencies"]`: add `voice: ProvisionedDependency` after `astGrep`.
3. `parseArguments` install defaults: add `voice: true`, and flag branch `else if (argument === "--no-voice") options.voice = false` next to `--no-superpowers`.
4. New `provisionVoiceOverlay(shouldProvision: boolean): Promise<ProvisionedDependency>` placed next to the other provision functions. Never spawn the Tauri binary for probing (unknown flags open its window) — existence only, via `node:fs` checks:
```ts
async function provisionVoiceOverlay(shouldProvision: boolean): Promise<ProvisionedDependency> {
  const platform = process.platform
  const dep = voiceOverlayPackageFor(platform, process.arch)
  if (dep === null) return { command: "voice-overlay", status: "skipped" }
  if (!shouldProvision) return { command: "voice-overlay", status: "skipped" }
  const managedDir = voiceManagedDir(platform, process.env)
  const binary = voiceBinaryName(platform)
  const managedBinary = managedDir === null ? null : path.join(managedDir, binary)
  if (managedBinary !== null && isExecutableFile(managedBinary)) {
    await ensureVoiceModel().catch(() => undefined)
    return { command: managedBinary, status: "existing" }
  }
  let packageDir: string
  try {
    packageDir = path.dirname(fileURLToPath(import.meta.resolve(`${dep}/package.json`)))
  } catch {
    return { command: "voice-overlay", status: "failed", reason: `optional package ${dep} is not installed` }
  }
  if (managedDir === null) {
    return { command: "voice-overlay", status: "failed", reason: "no managed install directory on this platform" }
  }
  const sidecars = voiceSidecarNames(platform, process.arch) ?? []
  try {
    await mkdir(managedDir, { recursive: true })
    for (const file of [binary, ...sidecars]) {
      await copyFile(path.join(packageDir, file), path.join(managedDir, file))
    }
    if (platform !== "win32") await chmod(path.join(managedDir, binary), 0o755)
  } catch (error) {
    const reason = failureReason(error)
    return { command: "voice-overlay", status: "failed", ...(reason ? { reason } : {}) }
  }
  await ensureVoiceModel().catch(() => undefined)
  return { command: path.join(managedDir, binary), status: "installed" }
}
```
(`fileURLToPath` from `node:url` — extend the existing `pathToFileURL` import on line 8; `copyFile`, `mkdir`, `chmod` already imported. `isExecutableFile` = tiny local `accessSync(X_OK)` wrapper next to the provision function. `ensureVoiceModel()`: downloads `VOICE_MODEL_URL` to the platform app-data `models/` dir only when `ggml-base.bin` is absent (bounded fetch like `downloadScript` but with `arrayBuffer()` + 10 min timeout for ~140 MB); all failures swallowed — a missing model is a runtime `model-missing` UI error, never an install failure.)
5. In `install()`: after the `memoryGraph` block, add the `voice` block mirroring it exactly:
```ts
const voice = options.voice !== false
  ? await provisionVoiceOverlay(shouldProvision).catch((error: unknown) => {
      const reason = failureReason(error)
      return { command: "voice-overlay", status: "failed" as const, ...(reason ? { reason } : {}) }
    })
  : { command: "voice-overlay", status: "skipped" as const }
```
and include `voice` in the returned `dependencies` object.
6. In `main()` report: after the `ast-grep` line add `console.log(`Voice overlay: ${dependencyLine(result.dependencies.voice)}`)`, then the two final hint lines (only when `result.dependencies.voice.status !== "skipped"`):
```ts
console.log("Голосовая кнопка установлена: запусти voice-overlay.")
console.log("TUI — вставка в промпт, Web — отправка в сессию (переключатель — кнопка ⚙ в окне).")
```
(Exact copy from spec Section 7. If `main()` prints hints conditionally on dry-run, follow that same condition.)
7. Model download: inside `provisionVoiceOverlay`, after resolving the binary (status `existing` path), skip — model download happens on first overlay run per spec Sections 3–5, NOT in CLI (spec Section 7 says CLI downloads `ggml-base.bin`; implement it here: download `VOICE_MODEL_URL` to the app-data `models/` dir only when the file is absent; failure → still return the binary result with `status: "existing"` — a missing model is a runtime `model-missing` error with its own UI, never an install failure. Bound the download: reuse the bounded-fetch helper used by the other installers.)

- [ ] **Step 5: Doctor check (`src/diagnostics/doctor.ts`)**

Append in `runDoctor` after the `ast-grep` block. Never probe with `--version` (it would open the Tauri window) — existence only, via `node:fs` `accessSync(X_OK)` over absolute candidates (extend the existing `node:fs/promises` import with a `node:fs` import for `accessSync`/`constants`):
```ts
// --- Voice overlay button (prebuilt Tauri binary; unknown flags open its
// window, so only file existence is checked — never spawned) ---
const voiceManaged = voiceManagedDir(process.platform, process.env)
const voiceCandidates = [
  ...(voiceManaged === null ? [] : [path.join(voiceManaged, voiceBinaryName(process.platform))]),
  ...localBinCandidates(voiceBinaryName(process.platform)),
]
const voiceExecutable = voiceCandidates.find((candidate) => {
  try {
    accessSync(candidate, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
})
push({
  id: "voice-overlay",
  label: "Voice overlay button",
  status: voiceExecutable === undefined ? "info" : "ok",
  detail: voiceExecutable ?? "not installed",
  ...(voiceExecutable === undefined
    ? { hint: "Run `opencode-orchestra install` to provision it (needs a display to show the window)." }
    : {}),
})
```
(`localBinCandidates` + `path` already exist in `doctor.ts`; import `{ voiceBinaryName, voiceManagedDir }` from `"../voice.js"`.)
Add cases to `test/doctor.test.ts`: voice binary present (fake executable file in a temp HOME) → `ok`; absent → `info` (mirror the existing `ast-grep` doctor cases; read them first and reuse their temp-dir/env pattern).

- [ ] **Step 6: Packaging scaffolding + CI**

Create the three `voice-overlay/packaging/<platform>/package.json` files (exact content pattern):
```json
{
  "name": "@oeronteros-1/voice-overlay-linux-x64",
  "version": "0.0.0-PLACEHOLDER",
  "private": false,
  "os": ["linux"],
  "cpu": ["x64"],
  "files": ["voice-overlay", "ffmpeg-x86_64-unknown-linux-gnu", "whisper-x86_64-unknown-linux-gnu"]
}
```
(`win32-x64`: `os: ["win32"]`, files with `.exe` names per `sidecar_file` triples. `version` is stamped by CI to the root `package.json` version — never hand-edited.)
Create `scripts/pack-voice-overlay.mjs`: args `--platform <linux-x64|linux-arm64|win32-x64> --version <x.y.z> --src <dir-with-built-artifacts>`; copies the three binaries into the packaging dir, stamps `version`, prints the publish command. Keep it dependency-free (node builtins only).
Create `.github/workflows/voice-overlay.yml`: matrix `ubuntu-22.04 x64` + `windows-2022 x64` (plus a comment marking where the `linux-arm64` runner row goes, per spec Section 7); steps: Rust stable, Node 22, `npm ci` in `voice-overlay/`, `apt` webkit2gtk dev packages (linux), vendor ffmpeg static + whisper.cpp release (URLs pinned as env vars at the top of the file), `npm run build:voice`, `node scripts/pack-voice-overlay.mjs --platform … --version $(node -p require('./package.json').version) --src voice-overlay/src-tauri/target/release`, `npm publish` of the staged dir on tags (needs `NPM_TOKEN` secret — no secret invention in-repo, reference only).
Root `package.json`: add the two v1 pins to `optionalDependencies` (exact versions, lockstep `2.0.1`):
```json
"@oeronteros-1/voice-overlay-linux-x64": "2.0.1",
"@oeronteros-1/voice-overlay-win32-x64": "2.0.1",
```
(arm64 intentionally absent until its runner lands — spec Section 7.)

- [ ] **Step 7: README + verify**

`README.md` install section: voice lines (what `install` provisions, `--no-voice`, model auto-download, WSL/display warn, Linux webkit note via `doctor`), exact final hint copy.
Run: `npm run typecheck` (clean) + `npm test` (full suite green, incl. new `test/voice.test.ts` + new cli/doctor cases, no regressions).
Run: `node scripts/pack-voice-overlay.mjs --help` (exits 0, prints usage) — the real pack/publish path runs only in CI (no Rust/npm-publish here).
Verify + report (no commit without explicit request).
