import { spawnSync } from "node:child_process"
import os from "node:os"

export type SpawnSyncOptions = NonNullable<Parameters<typeof spawnSync>[2]>

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

/**
 * Run a command natively, retrying through cmd.exe when Windows cannot
 * spawn the target directly (`.cmd`/`.bat` shims and shell scripts fail
 * with EINVAL on CVE-2024-27980-patched Node). The retry is skipped for
 * inputs cmd.exe could reinterpret — see {@link safeForCmdRetry} — and
 * off-Windows the native result is always returned untouched.
 */
export function spawnWithCmdFallback(command: string, args: string[], options: SpawnSyncOptions = {}): ReturnType<typeof spawnSync> {
  const direct = spawnSync(command, args, options)
  if (process.platform === "win32" && direct.error !== undefined && safeForCmdRetry([command, ...args])) {
    const retry = spawnSync(quoteLineForCmd([command, ...args]), [], { ...options, shell: true })
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
