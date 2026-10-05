import { invoke } from "@tauri-apps/api/core";
import type { ServerConfig, SessionRef } from "./lib/opencode";
import type { InputTarget } from "./lib/hotkey";
import type { WidgetSnapshot } from "./lib/widget";

export function updateVoiceWidget(snapshot: WidgetSnapshot): Promise<void> {
  return invoke("update_voice_widget", { snapshot });
}

export function attachVoiceWindow(): Promise<string> {
  return invoke("attach_voice_window");
}

export function enableVoiceHotkey(): Promise<boolean> {
  return invoke<boolean>("enable_voice_hotkey");
}

export function pasteVoiceText(target: InputTarget | null, text: string): Promise<boolean> {
  return invoke<boolean>("paste_voice_text", { target, text });
}
export interface BrowserTarget { id: string; route: string; title: string }

export function browserTarget(cfg: ServerConfig): Promise<BrowserTarget> {
  return invoke<BrowserTarget>("browser_target", { cfg });
}

export function insertInBrowser(cfg: ServerConfig, target: BrowserTarget, text: string): Promise<void> {
  return invoke<void>("insert_in_browser", { cfg, target, text });
}

export type OverlayStatus = "idle" | "recording" | "transcribing" | "error";

export function healthCheck(cfg: ServerConfig): Promise<boolean> {
  return invoke<boolean>("health_check", { host: cfg.host, port: cfg.port });
}

export function appendToPrompt(
  cfg: ServerConfig,
  text: string,
): Promise<boolean> {
  return invoke<boolean>("append_to_prompt", { cfg, text });
}

export function submitPrompt(cfg: ServerConfig): Promise<boolean> {
  return invoke<boolean>("submit_prompt", { cfg });
}

export function listMicrophones(): Promise<string[]> {
  return invoke<string[]>("list_microphones");
}

export function startRecording(
  device: string | undefined,
  model: string,
): Promise<boolean> {
  return invoke<boolean>("start_recording", { device: device ?? null, model });
}

export function cancelTranscription(): Promise<void> {
  return invoke<void>("cancel_transcription");
}

export function stopRecording(): Promise<string> {
  return invoke<string>("stop_recording");
}

export function transcribe(wav: string, model: string, language: string): Promise<string> {
  return invoke<string>("transcribe", { wav, model, language });
}

export function listSessions(cfg: ServerConfig): Promise<SessionRef[]> {
  return invoke<SessionRef[]>("list_sessions", { cfg });
}

export function sendToSession(
  cfg: ServerConfig,
  sessionId: string,
  text: string,
): Promise<boolean> {
  return invoke<boolean>("send_to_session", {
    cfg,
    sessionId: encodeURIComponent(sessionId),
    text,
  });
}
