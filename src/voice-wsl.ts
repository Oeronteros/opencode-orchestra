import path from "node:path"
import os from "node:os"
import { stat } from "node:fs/promises"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { ensureVerifiedVoiceModel, installVoiceFiles, launchVoiceOverlay, voiceSidecarNames } from "./voice.js"

/** WSL terminals are Windows windows; WSLg is not a full EWMH desktop. */
export function usesWindowsVoiceHost(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  kernel: string = os.release(),
): boolean {
  return platform === "linux" && env.ORCHESTRA_VOICE_LINUX_NATIVE !== "1"
    && (!!env.WSL_INTEROP || !!env.WSL_DISTRO_NAME || /microsoft/i.test(kernel))
}

export type WslCommand = (command: string, args: string[]) => Promise<string>
const runFile: WslCommand = (command, args) => new Promise((resolve, reject) => {
  execFile(command, args, { encoding: "utf8", windowsHide: true, shell: false, timeout: 15_000, maxBuffer: 16_384 },
    (error, stdout) => error ? reject(error) : resolve(stdout.trim()))
})

// Fixed script only: no paths or user-supplied strings are interpolated into PowerShell.
const HOST_FOLDERS = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); "
  + "@{local=[Environment]::GetFolderPath('LocalApplicationData'); roaming=[Environment]::GetFolderPath('ApplicationData')} | ConvertTo-Json -Compress"

const windowsAbsolute = (file: string) => /^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+(?:\\|$))/i.test(file)

export interface WslVoiceHost { binary: string; modelDir: string }

export async function resolveWslVoiceHost(options: {
  env?: NodeJS.ProcessEnv; run?: WslCommand
} = {}): Promise<WslVoiceHost> {
  const env = options.env ?? process.env
  const run = options.run ?? runFile
  let folders: unknown
  try {
    folders = JSON.parse((await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", HOST_FOLDERS])).replace(/^\uFEFF/, ""))
  } catch (error) {
    throw new Error(`WSL cannot reach Windows PowerShell. Enable WSL interop and Windows PATH (appendWindowsPath), then retry. ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!folders || typeof folders !== "object"
    || typeof (folders as Record<string, unknown>).local !== "string"
    || typeof (folders as Record<string, unknown>).roaming !== "string") {
    throw new Error("Windows returned invalid voice-overlay application directories.")
  }
  const { local, roaming } = folders as { local: string; roaming: string }
  if (!windowsAbsolute(local) || !windowsAbsolute(roaming)) {
    throw new Error("Windows voice-overlay application directories must be absolute.")
  }
  const requested = env.ORCHESTRA_VOICE_WINDOWS_BINARY
    ?? path.win32.join(local, "Programs", "voice-overlay", "voice-overlay.exe")
  if (!/\.exe$/i.test(requested) || (!windowsAbsolute(requested) && !path.posix.isAbsolute(requested))) {
    throw new Error("ORCHESTRA_VOICE_WINDOWS_BINARY must be an absolute Windows .exe path or its mounted WSL path.")
  }
  const convert = async (file: string) => {
    // Invoke wslpath as an executable with argv, preserving spaces, Unicode and shell characters.
    const converted = (await run("wslpath", ["-u", file])).trim()
    if (!path.posix.isAbsolute(converted)) throw new Error("wslpath returned a non-absolute voice path.")
    return converted
  }
  return {
    binary: path.posix.isAbsolute(requested) ? requested : await convert(requested),
    modelDir: await convert(path.win32.join(roaming, "ai.opencode.voice-overlay", "models")),
  }
}

export async function prepareWslVoiceOverlay(options: {
  env?: NodeJS.ProcessEnv;
  run?: WslCommand;
  packageDir?: string | null;
  exists?: (file: string) => Promise<boolean>;
  install?: typeof installVoiceFiles;
  ensureModel?: typeof ensureVerifiedVoiceModel;
} = {}): Promise<WslVoiceHost> {
  const env = options.env ?? process.env
  const host = await resolveWslVoiceHost({ env, ...(options.run ? { run: options.run } : {}) })
  // An explicit development build is never replaced by the installed npm companion.
  if (!env.ORCHESTRA_VOICE_WINDOWS_BINARY) {
    let packageDir = options.packageDir
    if (packageDir === undefined) {
      try { packageDir = path.dirname(fileURLToPath(import.meta.resolve("@oeronteros-1/voice-overlay-win32-x64/package.json"))) }
      catch { packageDir = null }
    }
    if (packageDir) await (options.install ?? installVoiceFiles)(packageDir, path.posix.dirname(host.binary), "win32", "x64")
  }
  const exists = options.exists ?? (async file => { try { return (await stat(file)).isFile() } catch { return false } })
  const directory = path.posix.dirname(host.binary)
  for (const file of [host.binary, ...voiceSidecarNames("win32", "x64")!.map(name => path.posix.join(directory, name))]) {
    if (!await exists(file)) {
      throw new Error(`Windows voice-overlay installation is incomplete: ${file}. Install/update it from Windows PowerShell with bunx @oeronteros-1/opencode-orchestra@latest voice-overlay, or set ORCHESTRA_VOICE_WINDOWS_BINARY to a complete local Windows build.`)
    }
  }
  await (options.ensureModel ?? ensureVerifiedVoiceModel)(host.modelDir)
  return host
}

export async function launchWslVoiceOverlay(options: Parameters<typeof prepareWslVoiceOverlay>[0] & {
  launch?: typeof launchVoiceOverlay
} = {}): Promise<void> {
  const host = await prepareWslVoiceOverlay(options)
  // WSL interop directly launches the mounted PE binary; no shell quoting or host Node is needed.
  try { await (options.launch ?? launchVoiceOverlay)(host.binary) }
  catch (error) {
    throw new Error(`WSL could not start the Windows voice-overlay. Check WSL interop and the Windows runtime files next to the executable. ${error instanceof Error ? error.message : String(error)}`)
  }
}
