import { spawnSync } from "node:child_process"
import { statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export type SpawnSyncOptions = NonNullable<Parameters<typeof spawnSync>[2]>

type SpawnSyncDependency = (command: string, args: string[], options: SpawnSyncOptions) => ReturnType<typeof spawnSync>

export interface SpawnFallbackDependencies {
  platform?: NodeJS.Platform
  spawnSync?: SpawnSyncDependency
}

/**
 * Quote a command line for cmd.exe: parts containing spaces or cmd
 * metacharacters are wrapped in double quotes so paths with spaces and
 * `<>&|^` survive parsing. This is intentionally shallow — characters
 * cmd.exe reinterprets even inside quotes (`%VAR%`, embedded `"`, CR/LF,
 * `,`/`;`) cannot be conveyed safely this way and must be rejected
 * upstream by {@link safeForCmdRetry}.
 */
export function quoteLineForCmd(parts: string[]): string {
  return parts
    .map((part) => (part.includes(" ") || /[<>&|^]/.test(part) ? `"${part}"` : part))
    .join(" ")
}

/**
 * Characters cmd.exe interprets even inside double quotes or across the
 * line: an embedded `"` flips quoting state (letting a later `& cmd`
 * escape), `%VAR%` expands within quotes, CR/LF split commands, `,`/`;`
 * separate arguments, and `!VAR!` expands on hosts with delayed expansion
 * enabled. A part containing any of these cannot be conveyed safely
 * through a shell retry, so callers fail closed and keep the native-spawn
 * failure instead of risking command breakout.
 */
const UNSAFE_FOR_CMD_RETRY = /["%\r\n;,!]/

export function safeForCmdRetry(parts: string[]): boolean {
  return !parts.some((part) => UNSAFE_FOR_CMD_RETRY.test(part))
}

/** cmd.exe's default executable search order within a directory. */
const DEFAULT_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"]

/**
 * Mirror cmd.exe's PATH resolution for a bare command name: scan the current
 * directory and then PATH in order, trying PATHEXT extensions within each
 * directory, and return the first existing file. Patched Windows Node skips
 * `.cmd`/`.bat` candidates when resolving direct spawns, so a `.cmd` shim in
 * an earlier PATH entry would otherwise be silently shadowed by a real `.exe`
 * further down PATH. Knowing which candidate wins lets us route `.cmd`/`.bat`
 * wins through the cmd.exe retry deterministically.
 */
function resolveCommandCandidate(command: string, env: NodeJS.ProcessEnv, cwd: string): string | undefined {
  const pathext = (env.PATHEXT ?? DEFAULT_PATHEXT.join(";"))
    .split(";")
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0)
    .map((extension) => (extension.startsWith(".") ? extension : "." + extension))
  const directories = [cwd, ...(env.PATH ?? "").split(";").map((directory) => directory.replace(/^"|"$/g, ""))].filter(
    (directory) => directory.length > 0,
  )
  for (const directory of directories) {
    for (const extension of pathext) {
      const candidate = path.join(directory, command + extension)
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        // Not a file; try the next extension.
      }
    }
  }
  return undefined
}

/**
 * Run a command natively, retrying through cmd.exe when Windows cannot
 * spawn the target directly (`.cmd`/`.bat` shims and shell scripts fail
 * with EINVAL on CVE-2024-27980-patched Node). The retry is skipped for
 * inputs cmd.exe could reinterpret — see {@link safeForCmdRetry} — and
 * off-Windows the native result is always returned untouched.
 *
 * When a bare command name resolves to a `.cmd`/`.bat` shim ahead of any
 * spawnable executable on Windows, the direct spawn is skipped entirely and
 * the command runs through cmd.exe, mirroring cmd.exe's own resolution order.
 * This keeps PATH-based shims authoritative even when a real `.exe` of the
 * same name sits further down PATH (patched Node would otherwise bypass the
 * shim and run the real tool).
 */
export function spawnWithCmdFallback(
  command: string,
  args: string[],
  options: SpawnSyncOptions = {},
  deps: SpawnFallbackDependencies = {},
): ReturnType<typeof spawnSync> {
  const runSpawn = deps.spawnSync || spawnSync
  const platform = deps.platform || process.platform
  const isBareName = !command.includes("\\") && !command.includes("/") && path.extname(command).length === 0
  let shellAttempt: ReturnType<typeof spawnSync> | undefined
  if (platform === "win32" && isBareName && safeForCmdRetry([command, ...args])) {
    const env = options.env ?? process.env
    const cwd =
      typeof options.cwd === "string"
        ? options.cwd
        : options.cwd instanceof URL
          ? fileURLToPath(options.cwd)
          : process.cwd()
    const candidate = resolveCommandCandidate(command, env, cwd)
    if (candidate !== undefined && /\.(cmd|bat)$/i.test(candidate)) {
      shellAttempt = runSpawn(quoteLineForCmd([command, ...args]), [], { ...options, shell: true })
      if (shellAttempt.error === undefined) return shellAttempt
    }
  }
  const direct = runSpawn(command, args, options)
  // When the shim already ran through cmd.exe above and failed to SPAWN, do
  // not shell out a second time — the shim could execute twice, doubling its
  // side effects. Fail closed with the direct-spawn result instead.
  if (platform === "win32" && direct.error !== undefined && shellAttempt === undefined && safeForCmdRetry([command, ...args])) {
    const retry = runSpawn(quoteLineForCmd([command, ...args]), [], { ...options, shell: true })
    if (retry.error === undefined) return retry
  }
  return direct
}

/**
 * User home for tool discovery. Windows tests override HOME to shadow the
 * real per-user toolchain, so honor it before falling back to os.homedir().
 */
export function homeDirectory(): string {
  return process.env.HOME || os.homedir()
}
