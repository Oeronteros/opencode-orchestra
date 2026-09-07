import { invoke } from "@tauri-apps/api/core";
import type { ServerConfig, SessionRef } from "./lib/opencode";

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

export function listSessions(cfg: ServerConfig): Promise<SessionRef[]> {
  return invoke<SessionRef[]>("list_sessions", { cfg });
}

export function sendToSession(cfg: ServerConfig, sessionId: string, text: string): Promise<boolean> {
  return invoke<boolean>("send_to_session", { cfg, sessionId, text });
}
