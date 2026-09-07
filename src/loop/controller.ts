import { classifyLoopReply, loopPrompt, normalizeLoopReason } from "./protocol.js"

export interface LoopState {
  goal: string
  iteration: number
  status: "running" | "completed" | "failed" | "cancelled" | "paused"
  reason: string
  startedAt: number
  parentID?: string | undefined
  reply?: { id: string; text: string } | undefined
  lastReason?: string
  repeatedReasonCount: number
  busy: boolean
  timer?: ReturnType<typeof setTimeout>
}

export interface LoopControllerOptions {
  enabled: boolean
  maxIterations: number
  maxMinutes: number
  noProgressLimit: number
  verifyCommand?: string
  prompt: (sessionID: string, text: string) => Promise<void>
  log?: (message: string) => void
}

export class LoopController {
  private readonly states = new Map<string, LoopState>()
  private disposed = false
  constructor(private readonly options: LoopControllerOptions) {}

  start(sessionID: string, goal: string): LoopState {
    if (this.disposed) throw new Error("Loop controller disposed")
    if (!this.options.enabled) throw new Error("Loop is disabled. Set orchestration.loop.enabled to true and restart OpenCode.")
    if (this.options.verifyCommand?.trim()) throw new Error("Loop verifyCommand is unsupported: no permission-safe runtime verifier is available. Remove verifyCommand and ask orch-lead to verify through normal tools; DONE is only a completion claim.")
    if (this.get(sessionID)?.status === "running") throw new Error("A loop is already running. Use /loop stop first.")
    const state: LoopState = { goal, iteration: 1, status: "running", reason: "First iteration", startedAt: Date.now(), repeatedReasonCount: 0, busy: false }
    state.timer = setTimeout(() => this.stop(sessionID, "failed", "Time limit reached; no further iterations"), this.options.maxMinutes * 60_000)
    state.timer.unref?.()
    this.states.set(sessionID, state)
    return state
  }

  get(sessionID: string): LoopState | undefined { return this.states.get(sessionID) }

  stop(sessionID: string, status: LoopState["status"] = "cancelled", reason = "Stopped by user; no further iterations"): boolean {
    const state = this.states.get(sessionID)
    if (!state || state.status !== "running") return false
    state.status = status
    state.reason = reason
    clearTimeout(state.timer)
    state.reply = undefined
    this.options.log?.(`Loop ${sessionID}: ${status}: ${reason}`)
    return true
  }

  bind(sessionID: string, parentID: string): void {
    const state = this.get(sessionID)
    if (state?.status === "running") { state.parentID = parentID; state.reply = undefined }
  }

  reply(sessionID: string, parentID: string, id: string, text: string): void {
    const state = this.get(sessionID)
    if (state?.status === "running" && state.parentID === parentID) state.reply = { id, text }
  }

  async tick(sessionID: string): Promise<void> {
    const state = this.get(sessionID)
    if (!state || state.status !== "running" || state.busy || !state.reply) return
    state.busy = true
    const reply = classifyLoopReply(state.reply.text)
    state.reply = undefined
    state.parentID = undefined // Duplicate idle/reply events cannot reuse this turn.
    try {
      if (Date.now() - state.startedAt >= this.options.maxMinutes * 60_000) { this.stop(sessionID, "failed", "Time limit reached"); return }
      if (reply.kind === "done") { this.stop(sessionID, "completed", `Assistant completion claim (not independently verified): ${reply.detail}`); return }
      if (reply.kind === "unknown") { this.stop(sessionID, "paused", "No explicit safe continuation signal"); return }
      const reason = normalizeLoopReason(reply.detail)
      state.repeatedReasonCount = reason === state.lastReason ? state.repeatedReasonCount + 1 : 1
      state.lastReason = reason
      if (state.iteration >= this.options.maxIterations || state.repeatedReasonCount >= this.options.noProgressLimit) {
        this.stop(sessionID, "failed", "Iteration or no-progress limit reached"); return
      }
      state.iteration++
      state.reason = reply.detail
      await this.options.prompt(sessionID, loopPrompt(state.goal) + `\nRemaining work: ${reply.detail}`)
    } catch (error) {
      if (this.get(sessionID) === state) this.stop(sessionID, "failed", String(error))
    } finally { state.busy = false }
  }

  dispose(): void {
    this.disposed = true
    for (const id of this.states.keys()) this.stop(id)
    this.states.clear()
  }
}
