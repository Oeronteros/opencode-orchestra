import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"

export interface OrchestrationActionRequest {
  version: 1
  requestId: string
  rootSessionID: string
  nodeId: string
  action: "cancel" | "retry"
  requestedAt: number
}

function parseRequest(value: unknown): OrchestrationActionRequest | undefined {
  if (!value || typeof value !== "object") return undefined
  const request = value as Partial<OrchestrationActionRequest>
  if (request.version !== 1 || typeof request.requestId !== "string" || typeof request.rootSessionID !== "string" || typeof request.nodeId !== "string") return undefined
  if (request.action !== "cancel" && request.action !== "retry") return undefined
  return request as OrchestrationActionRequest
}

/** Cross-process inbox used by the standalone local dashboard. */
export class OrchestrationActionInbox {
  private timer: ReturnType<typeof setInterval> | undefined
  private polling = false
  private readonly directory: string

  constructor(stateDirectory: string, private readonly handle: (request: OrchestrationActionRequest) => Promise<unknown>) {
    this.directory = path.join(stateDirectory, "actions")
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.poll() }, 750)
    this.timer.unref?.()
    void this.poll()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  async poll(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      await mkdir(this.directory, { recursive: true })
      const files = (await readdir(this.directory)).filter((file) => file.endsWith(".json") && !file.endsWith(".result.json")).sort()
      for (const file of files) {
        const requestFile = path.join(this.directory, file)
        let request: OrchestrationActionRequest | undefined
        try { request = parseRequest(JSON.parse(await readFile(requestFile, "utf8"))) } catch { /* handled below */ }
        const requestId = request?.requestId ?? path.basename(file, ".json")
        let result: unknown
        try {
          if (!request) throw new Error("Invalid orchestration action request.")
          result = { ok: true, result: await this.handle(request), completedAt: Date.now() }
        } catch (error) {
          result = { ok: false, error: error instanceof Error ? error.message : String(error), completedAt: Date.now() }
        }
        const resultFile = path.join(this.directory, `${requestId}.result.json`)
        const temporary = `${resultFile}.${process.pid}.tmp`
        await writeFile(temporary, JSON.stringify(result, null, 2) + "\n", "utf8")
        await rename(temporary, resultFile)
        await unlink(requestFile).catch(() => undefined)
      }
    } finally {
      this.polling = false
    }
  }
}
