import path from "node:path"
import { createReadStream } from "node:fs"
import { chmod, copyFile, mkdir, open, readFile, readdir, mkdtemp, rename, rm } from "node:fs/promises"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { createVoicePolicy, type VoiceModel } from "./voice-context.js"

/** Launch the GUI by its absolute path, without PATH lookup or a Windows shell. */
export async function launchVoiceOverlay(binary: string, spawnProcess: typeof spawn = spawn): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess(binary, [], {
      cwd: path.dirname(binary), detached: true, stdio: ["ignore", "ignore", "pipe"], windowsHide: true, shell: false,
    })
    let startup: ReturnType<typeof setTimeout> | undefined
    let detail = ""
    child.stderr?.on("data", (chunk: Buffer) => { detail = (detail + chunk.toString()).slice(-4096) })
    const finish = (error?: Error) => {
      clearTimeout(startup)
      child.stderr?.destroy()
      child.unref()
      if (error) reject(error)
      else resolve()
    }
    child.once("error", (error) => finish(new Error(`Cannot launch voice-overlay: ${error.message}`)))
    child.once("exit", (code, signal) => {
      if (code === 0) finish()
      else finish(new Error(`Cannot launch voice-overlay: exited with ${code ?? signal}. ${detail.trim()}`))
    })
    child.once("spawn", () => {
      // A successful OS spawn can still be followed by a Tauri startup failure.
      startup = setTimeout(() => finish(), 1000)
    })
  })
}

const SCOPE = "@oeronteros-1/voice-overlay"

export const VOICE_MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"

export const VOICE_MODEL_FILE = "ggml-base.bin"
// Hugging Face LFS SHA-256 for ggml-base.bin (verified 2026-09-16).
export const VOICE_MODEL_SHA256 = "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe"

// Multilingual model LFS SHA-256 values verified against Hugging Face on 2026-10-04.
export const VOICE_MODEL_SHA256S: Record<VoiceModel, string> = {
  base: VOICE_MODEL_SHA256,
  small: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
  "large-v3-turbo-q5_0": "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
}

async function sha256File(file: string): Promise<string | null> {
  const hash = createHash("sha256")
  try {
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    return hash.digest("hex")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

/** Keep the installed model intact until a complete, verified download is ready. */
export async function ensureVerifiedVoiceModel(dir: string, options: {
  model?: VoiceModel; url?: string; sha256?: string; fetch?: typeof fetch
} = {}): Promise<void> {
  const model = createVoicePolicy().model(options.model ?? "base")
  const filename = createVoicePolicy().modelFile(model)
  const target = path.join(dir, filename)
  const digest = options.sha256 ?? VOICE_MODEL_SHA256S[model]
  if (await sha256File(target) === digest) return
  const response = await (options.fetch ?? fetch)(options.url ?? `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${filename}`, {
    redirect: "follow", signal: AbortSignal.timeout(600_000),
  })
  if (!response.ok) throw new Error(`Failed to download voice model: HTTP ${response.status}`)
  await mkdir(dir, { recursive: true })
  const staging = await mkdtemp(path.join(dir, ".download-"))
  try {
    const downloaded = path.join(staging, filename)
    if (response.body === null) throw new Error("Voice model download returned an empty body.")
    const hash = createHash("sha256")
    const file = await open(downloaded, "wx")
    try {
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        hash.update(chunk)
        await file.write(chunk)
      }
      await file.sync()
    } finally { await file.close() }
    if (hash.digest("hex") !== digest) {
      throw new Error("Voice model SHA-256 mismatch; existing model was preserved. Retry installation.")
    }
    await rename(downloaded, target)
  } finally { await rm(staging, { recursive: true, force: true }) }
}

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
 * `voice-overlay/src-tauri/src/sidecars.rs` — the filenames below are load-bearing.
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
 * Long-lived whisper.cpp HTTP server (keeps the model loaded between
 * dictations). Optional at runtime: packages before it shipped fall back to
 * the one-shot `whisper` CLI.
 */
export function voiceServerSidecarName(platform: string, arch: string): string | null {
  const triple = voiceOverlayTriple(platform, arch)
  if (triple === null) return null
  return `whisper-server-${triple}`
}

/** Refresh an existing installation too: otherwise upgrades keep the old binary. */
export async function installVoiceFiles(packageDir: string, managedDir: string, platform: string, arch: string): Promise<boolean> {
  const executables = [voiceBinaryName(platform), ...(voiceSidecarNames(platform, arch) ?? [])]
  const entries = await readdir(packageDir)
  for (const name of executables) {
    if (!entries.includes(name)) throw new Error(`Voice package is missing ${name}`)
  }
  await mkdir(managedDir, { recursive: true })
  const skipNames = new Set(["package.json", "package-lock.json", "README.md", "LICENSE"])
  let changed = false
  for (const file of entries) {
    if (skipNames.has(file) || file.startsWith(".")) continue
    const source = path.join(packageDir, file)
    const target = path.join(managedDir, file)
    const previous = await readFile(target).catch(() => null)
    if (previous === null || !previous.equals(await readFile(source))) {
      await copyFile(source, target)
      changed = true
    }
    if (platform !== "win32" && executables.includes(file)) await chmod(target, 0o755)
  }
  return changed
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

/** App-data root shared by models and the accelerator preference. */
export function voiceDataDir(platform: string, env: NodeJS.ProcessEnv): string | null {
  if (platform === "linux") {
    const base = env["XDG_DATA_HOME"] ?? (env["HOME"] === undefined ? undefined : path.join(env["HOME"], ".local", "share"))
    if (!base) return null
    return path.join(base, "ai.opencode.voice-overlay")
  }
  if (platform === "win32") {
    const base = env["APPDATA"]
    if (!base) return null
    return path.join(base, "ai.opencode.voice-overlay")
  }
  return null
}

/** App-data `models/` dir (Tauri `app_data_dir()` equivalent). Pure for testability. */
export function voiceModelDir(platform: string, env: NodeJS.ProcessEnv): string | null {
  const dir = voiceDataDir(platform, env)
  return dir === null ? null : path.join(dir, "models")
}
