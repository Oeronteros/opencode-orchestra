import { mkdir, open, readFile, rename, unlink } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import type { PersistedOrchestrationState } from "./run-state.js"

export interface PersistenceStatus {
  state: "disabled" | "idle" | "ready" | "error" | "closed"
  file: string
  error?: string
}

interface Owner { pid: number; token: string }

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH" }
}

/** One writer per project, with atomic snapshots and immediately observed failures. */
export class OrchestrationStateStore {
  readonly file: string
  private readonly owner: Owner = { pid: process.pid, token: randomUUID() }
  private pending: Promise<void> = Promise.resolve()
  private acquisition?: Promise<void>
  private ownsLock = false
  private closed = false
  private restoreError: Error | undefined
  private lastError: Error | undefined
  private state: PersistenceStatus["state"]

  constructor(
    projectDirectory: string,
    stateDirectory: string,
    private readonly enabled: boolean,
    private readonly onError?: (error: Error) => void | Promise<void>,
  ) {
    this.file = path.resolve(projectDirectory, stateDirectory, "runs.json")
    this.state = enabled ? "idle" : "disabled"
  }

  status(): PersistenceStatus {
    return { state: this.state, file: this.file, ...(this.lastError ? { error: this.lastError.message } : {}) }
  }

  private report(error: unknown): Error {
    const previous = this.lastError?.message
    this.lastError = error instanceof Error ? error : new Error(String(error))
    this.state = "error"
    if (previous !== this.lastError.message) {
      try { void Promise.resolve(this.onError?.(this.lastError)).catch(() => undefined) } catch { /* reporting must not reject the queue */ }
    }
    return this.lastError
  }

  private async readOwner(): Promise<Owner> {
    const owner = JSON.parse(await readFile(this.file + ".lock", "utf8")) as Owner
    if (!Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== "string" || !/^[a-f0-9-]{36}$/.test(owner.token)) {
      throw new Error("Invalid checkpoint lock: " + this.file + ".lock")
    }
    return owner
  }

  private async acquire(): Promise<void> {
    if (this.ownsLock) return
    return this.acquisition ??= (async () => {
      await mkdir(path.dirname(this.file), { recursive: true })
      const lock = this.file + ".lock"
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const handle = await open(lock, "wx")
          try { await handle.writeFile(JSON.stringify(this.owner)); await handle.sync() }
          catch (error) { await handle.close(); await unlink(lock).catch(() => undefined); throw error }
          await handle.close()
          this.ownsLock = true
          this.state = "ready"
          return
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        }
        const previous = await this.readOwner().catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw error
        })
        if (!previous) continue
        if (alive(previous.pid)) throw new Error("Checkpoint is owned by process " + previous.pid + ": " + lock)
        // A guard for this exact dead owner prevents concurrent reclaimers
        // from unlinking a replacement lease based on an old observation.
        const reclaim = lock + "." + previous.token + ".reclaim"
        const guard = await open(reclaim, "wx")
        try {
          const current = await this.readOwner().catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined
            throw error
          })
          if (current?.token === previous.token && !alive(current.pid)) await unlink(lock)
        } finally {
          await guard.close()
          await unlink(reclaim)
        }
      }
      throw new Error("Unable to acquire checkpoint lock: " + lock)
    })()
  }

  async load(): Promise<PersistedOrchestrationState | undefined> {
    if (!this.enabled) return undefined
    if (this.closed) throw new Error("Checkpoint store is closed")
    try {
      await this.acquire()
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as unknown
      if (!parsed || typeof parsed !== "object" || !("version" in parsed) || parsed.version !== 1
        || !("runs" in parsed) || !Array.isArray(parsed.runs)) throw new Error("Invalid checkpoint format")
      return parsed as PersistedOrchestrationState
    } catch (error) {
      if (this.ownsLock && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      this.restoreError = this.report(error)
      throw this.restoreError
    }
  }

  schedule(state: PersistedOrchestrationState): void {
    if (!this.enabled || this.closed) return
    const serialized = JSON.stringify(state, null, 2) + "\n"
    this.pending = this.pending.then(async () => {
      if (this.restoreError) throw this.restoreError
      await this.acquire()
      if ((await this.readOwner()).token !== this.owner.token) throw new Error("Checkpoint ownership was lost")
      const temporary = this.file + "." + this.owner.token + ".tmp"
      try {
        const handle = await open(temporary, "wx")
        try { await handle.writeFile(serialized, "utf8"); await handle.sync() }
        finally { await handle.close() }
        await rename(temporary, this.file)
        this.lastError = undefined
        this.state = "ready"
      } finally { await unlink(temporary).catch(() => undefined) }
    }).catch((error: unknown) => { this.report(error) })
  }

  async flush(): Promise<void> {
    await this.pending
    if (this.lastError) throw this.lastError
  }

  async close(): Promise<void> {
    this.closed = true
    try { await this.flush() }
    finally {
      if (this.ownsLock) {
        const owner = await this.readOwner()
        if (owner.token === this.owner.token) await unlink(this.file + ".lock")
        this.ownsLock = false
      }
      this.state = "closed"
    }
  }
}
