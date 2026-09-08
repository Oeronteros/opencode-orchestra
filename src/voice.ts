import path from "node:path"

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

/**
 * Tauri sidecar triple. Must stay identical to `sidecar_file` in
 * `voice-overlay/src-tauri/src/main.rs` — the filenames below are load-bearing.
 */
export function voiceOverlayTriple(platform: string, arch: string): string | null {
  if (platform === "linux" && arch === "x64") return "x86_64-unknown-linux-gnu"
  if (platform === "linux" && arch === "arm64") return "aarch64-unknown-linux-gnu"
  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc.exe"
  return null
}

export function voiceSidecarNames(platform: string, arch: string): string[] | null {
  const triple = voiceOverlayTriple(platform, arch)
  if (triple === null) return null
  return [`ffmpeg-${triple}`, `whisper-${triple}`]
}

/**
 * Managed install directory for the button binary + sidecars. Sidecars must
 * sit next to the binary (Tauri resolves them exe-adjacent), so all three
 * files are co-located here. Pure function of platform + env for testability.
 */
export function voiceManagedDir(platform: string, env: NodeJS.ProcessEnv): string | null {
  if (platform === "linux") {
    const home = env["HOME"]
    if (!home) return null
    return path.join(home, ".local", "bin")
  }
  if (platform === "win32") {
    const base = env["LOCALAPPDATA"]
    if (!base) return null
    return path.join(base, "Programs", "voice-overlay")
  }
  return null
}

/** App-data `models/` dir (Tauri `app_data_dir()` equivalent). Pure for testability. */
export function voiceModelDir(platform: string, env: NodeJS.ProcessEnv): string | null {
  if (platform === "linux") {
    const base = env["XDG_DATA_HOME"] ?? (env["HOME"] === undefined ? undefined : path.join(env["HOME"], ".local", "share"))
    if (!base) return null
    return path.join(base, "ai.opencode.voice-overlay", "models")
  }
  if (platform === "win32") {
    const base = env["APPDATA"]
    if (!base) return null
    return path.join(base, "ai.opencode.voice-overlay", "models")
  }
  return null
}
