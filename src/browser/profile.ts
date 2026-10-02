import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, readFile, realpath, rm, writeFile, lstat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { browserProfileNameSchema } from "../config/schema.js"

const execute = promisify(execFile)
export function orchestraDataDirectory(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (platform === "win32") return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "OpenCodeOrchestra")
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "OpenCodeOrchestra")
  return path.join(env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "opencode-orchestra")
}

/** Worktrees share the real Git common directory, unrelated clones never do. */
export async function projectIdentity(directory: string): Promise<string> {
  let canonical = await realpath(directory)
  try {
    const result = await execute("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: canonical, windowsHide: true })
    canonical = await realpath(result.stdout.trim())
  } catch { /* A non-Git project is identified by its canonical directory. */ }
  if (process.platform === "win32") canonical = canonical.toLowerCase()
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32)
}

export async function profileDirectory(directory: string, name: string, shared = false, dataRoot = orchestraDataDirectory()): Promise<string> {
  browserProfileNameSchema.parse(name)
  let location = dataRoot
  for (const component of ["browser", "profiles", shared ? "explicit-shared" : await projectIdentity(directory), name]) {
    location = path.join(location, component)
    const info = await lstat(location).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error })
    if (info?.isSymbolicLink()) throw new Error("browser_symlink_profile_denied")
  }
  return location
}

export interface ProfileOwner { pid: number; nonce: string; createdAt: number; chromePid?: number }
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" }
}
export async function readProfileOwner(profile: string): Promise<ProfileOwner | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path.join(profile, ".orchestra-lock", "owner.json"), "utf8"))
    if (value && typeof value === "object" && "pid" in value && typeof value.pid === "number" && "nonce" in value && typeof value.nonce === "string") return value as ProfileOwner
  } catch { /* Missing or untrusted owner record is never grounds for removing a lock. */ }
  return undefined
}
export async function profileLocked(profile: string): Promise<boolean> {
  return lstat(path.join(profile, ".orchestra-lock")).then(() => true).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error })
}

/** No stale-lock stealing: an orphan requires an explicit offline user repair. */
export class ProfileLock {
  private owner: ProfileOwner | undefined
  constructor(readonly profile: string) {}
  async acquire(): Promise<void> {
    await mkdir(this.profile, { recursive: true, mode: 0o700 })
    const lock = path.join(this.profile, ".orchestra-lock")
    try { await mkdir(lock, { mode: 0o700 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("browser_profile_busy")
      throw error
    }
    this.owner = { pid: process.pid, nonce: randomUUID(), createdAt: Date.now() }
    try { await this.write() } catch (error) {
      // This mkdir was ours and no other owner can acquire it.
      await rm(lock, { recursive: true, force: true })
      this.owner = undefined
      throw error
    }
  }
  async owns(): Promise<boolean> {
    const current = await readProfileOwner(this.profile)
    return Boolean(this.owner && current?.pid === process.pid && current.nonce === this.owner.nonce)
  }
  async setChrome(pid: number): Promise<void> {
    if (!await this.owns() || !this.owner) throw new Error("browser_ownership_lost")
    this.owner.chromePid = pid
    await this.write()
  }
  async release(): Promise<void> {
    if (!await this.owns()) { this.owner = undefined; return }
    if (this.owner?.chromePid && processAlive(this.owner.chromePid)) throw new Error("browser_process_still_running")
    await rm(path.join(this.profile, ".orchestra-lock"), { recursive: true })
    this.owner = undefined
  }
  private async write(): Promise<void> {
    await writeFile(path.join(this.profile, ".orchestra-lock", "owner.json"), JSON.stringify(this.owner), { mode: 0o600 })
  }
}
