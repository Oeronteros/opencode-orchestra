import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import type { PersistedOrchestrationState } from "./run-state.js"

const STATE_FILE = "runs.json"

/**
 * Serializes orchestration checkpoints through one promise chain so a slower
 * older write can never replace a newer state snapshot.
 */
export class OrchestrationStateStore {
  readonly file: string
  private pending: Promise<void> = Promise.resolve()

  constructor(
    projectDirectory: string,
    stateDirectory: string,
    private readonly enabled: boolean,
  ) {
    this.file = path.resolve(projectDirectory, stateDirectory, STATE_FILE)
  }

  async load(): Promise<PersistedOrchestrationState | undefined> {
    if (!this.enabled) return undefined
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as unknown
      return parsed && typeof parsed === "object" ? parsed as PersistedOrchestrationState : undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }

  schedule(state: PersistedOrchestrationState): void {
    if (!this.enabled) return
    const serialized = JSON.stringify(state, null, 2) + "\n"
    this.pending = this.pending
      .catch(() => undefined)
      .then(async () => {
        await mkdir(path.dirname(this.file), { recursive: true })
        const temporary = `${this.file}.${process.pid}.tmp`
        await writeFile(temporary, serialized, "utf8")
        await rename(temporary, this.file)
      })
  }

  async flush(): Promise<void> {
    await this.pending
  }
}
