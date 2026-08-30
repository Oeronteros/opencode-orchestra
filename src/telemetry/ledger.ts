import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import type { ModelCandidateInput, ModelCost, ProfileName } from "../config/schema.js"
import { normalizeCandidate } from "../routing/model-resolver.js"
import { classifyError, isRetryable, type ErrorKind } from "../routing/fallback.js"
import { calcCost, type PricingResolution, type PricingStatus } from "../pricing/cost.js"

export type PricingLookup = (
  providerID: string | undefined,
  modelID: string | undefined,
) => PricingStatus | PricingResolution | undefined

function resolutionOf(looked: PricingStatus | PricingResolution | undefined): PricingResolution | undefined {
  if (looked === undefined) return undefined
  return typeof looked === "string" ? { status: looked } : looked
}

export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cache: {
    read: number
    write: number
  }
}

export interface MessageUsage {
  cost: number
  agent?: string
  model?: string
  provider?: string
  createdAt?: number
  completedAt?: number
  finish?: string
  tokens: TokenUsage
  /** How pricing was classified at record time (unknown = no rate found). */
  pricingStatus?: PricingStatus
  /** Opt-in debug text: only recorded when telemetry.storeTexts is enabled. */
  prompt?: string
  reply?: string
}

/**
 * A sanitized, bounded record of an observed attempt: the model that ran, the
 * policy error class (never the raw error text), the next model when a retry
 * was observed, and the outcome. Events are capped and never store credentials,
 * prompts, or provider response bodies.
 */
export interface ReliabilityEvent {
  attempt: number
  model?: string
  errorKind?: ErrorKind
  outcome: "failed" | "retried" | "succeeded"
  nextModel?: string
  at: number
}

export interface SessionLedger {
  profile?: ProfileName
  agents: Record<string, number>
  premiumEscalations: number
  estimatedPaidUsage: number
  freeWorkerCalls: number
  unknownPriceCalls: number
  /** Number of distinct assistant calls priced as paid in this session. */
  paidCallsUsed: number
  consensus?: number
  consensusUncertainty?: number
  consensusNotes?: string
  messages: Record<string, MessageUsage>
  reliability?: ReliabilityEvent[]
}

export interface LedgerState {
  version: 2
  updatedAt: string
  sessions: Record<string, SessionLedger>
}

interface AssistantInfo {
  id: string
  sessionID: string
  role: "assistant"
  mode?: string
  modelID?: string
  providerID?: string
  cost?: number
  time?: {
    created: number
    completed?: number
  }
  tokens?: TokenUsage
  finish?: string
  error?: {
    message?: string
    status?: number
    statusCode?: number
    /** OpenCode SDK nests provider error details under `data` (name + data). */
    data?: unknown
  }
}

function emptySession(): SessionLedger {
  return {
    agents: {},
    premiumEscalations: 0,
    estimatedPaidUsage: 0,
    freeWorkerCalls: 0,
    unknownPriceCalls: 0,
    paidCallsUsed: 0,
    messages: {},
  }
}

export function emptyLedgerState(): LedgerState {
  return { version: 2, updatedAt: new Date(0).toISOString(), sessions: {} }
}

function normalizeTokens(tokens?: Partial<TokenUsage>): TokenUsage {
  return {
    input: Math.max(0, tokens?.input ?? 0),
    output: Math.max(0, tokens?.output ?? 0),
    reasoning: Math.max(0, tokens?.reasoning ?? 0),
    cache: {
      read: Math.max(0, tokens?.cache?.read ?? 0),
      write: Math.max(0, tokens?.cache?.write ?? 0),
    },
  }
}

const RELIABILITY_EVENT_CAP = 100
const RELIABILITY_FIELD_CAP = 200

const ERROR_KINDS = new Set<ErrorKind>(["rate-limit", "server", "timeout", "auth", "invalid-request", "other"])
const RELIABILITY_OUTCOMES = new Set<ReliabilityEvent["outcome"]>(["failed", "retried", "succeeded"])

function boundedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed.slice(0, RELIABILITY_FIELD_CAP) : undefined
}

function isReliabilityOutcome(value: unknown): value is ReliabilityEvent["outcome"] {
  return RELIABILITY_OUTCOMES.has(value as ReliabilityEvent["outcome"])
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

/**
 * Normalize a reliability event into its exact persisted shape, or return
 * undefined when the record is unrecognizable (missing/invalid outcome,
 * attempt, or timestamp). Unrecognizable records are dropped rather than
 * coerced into plausible events, so corrupted persisted state never fabricates
 * a "failed" attempt. Unknown error kinds and non-string model/nextModel are
 * omitted; strings are bounded; raw error text is never stored.
 */
function normalizeReliabilityEvent(value: unknown): ReliabilityEvent | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const event = value as Partial<ReliabilityEvent>
  if (!isReliabilityOutcome(event.outcome)) return undefined
  if (!isPositiveFiniteNumber(event.attempt)) return undefined
  if (typeof event.at !== "number" || !Number.isFinite(event.at)) return undefined
  const model = boundedString(event.model)
  const nextModel = boundedString(event.nextModel)
  const errorKind = event.errorKind !== undefined && ERROR_KINDS.has(event.errorKind) ? event.errorKind : undefined
  return {
    attempt: Math.floor(event.attempt),
    ...(model !== undefined ? { model } : {}),
    ...(errorKind !== undefined ? { errorKind } : {}),
    outcome: event.outcome,
    ...(nextModel !== undefined ? { nextModel } : {}),
    at: event.at,
  }
}

function normalizeReliability(value: unknown): ReliabilityEvent[] {
  if (!Array.isArray(value)) return []
  const events: ReliabilityEvent[] = []
  for (const item of value) {
    const normalized = normalizeReliabilityEvent(item)
    if (normalized !== undefined) events.push(normalized)
  }
  return events.slice(-RELIABILITY_EVENT_CAP)
}

/**
 * Derive a policy error class from an assistant message. A provider error is
 * classified directly; a bare `finish: "error"` with no error detail falls back
 * to the "other" (terminal) class because no retryable signal is known.
 */
function classifyFailure(info: AssistantInfo): ErrorKind | undefined {
  if (info.error != null) return classifyError(toFlatError(info.error)).kind
  if (info.finish === "error") return classifyError({ message: info.finish }).kind
  return undefined
}

/**
 * Normalize an assistant error into the flat `{ message, status, statusCode }`
 * shape that `classifyError` consumes. The OpenCode SDK wraps provider errors
 * as `{ name, data: { message, statusCode } }`, so top-level fields win and any
 * nested `data` fields are promoted when the top level is absent.
 */
function toFlatError(error: NonNullable<AssistantInfo["error"]>): { message?: string; status?: number; statusCode?: number } {
  const nested = (typeof error.data === "object" && error.data !== null ? error.data : {}) as {
    message?: unknown
    status?: unknown
    statusCode?: unknown
  }
  const message = error.message ?? (typeof nested.message === "string" ? nested.message : undefined)
  const status = error.status ?? (typeof nested.status === "number" ? nested.status : undefined)
  const statusCode = error.statusCode ?? (typeof nested.statusCode === "number" ? nested.statusCode : undefined)
  return {
    ...(message !== undefined ? { message } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
  }
}

function upgradeState(input: unknown): LedgerState {
  if (typeof input !== "object" || input === null) return emptyLedgerState()
  const candidate = input as { version?: number; updatedAt?: string; sessions?: Record<string, SessionLedger> }
  if (candidate.version !== 1 && candidate.version !== 2) return emptyLedgerState()
  const sessions = candidate.sessions ?? {}
  for (const session of Object.values(sessions)) {
    session.messages ??= {}
    session.agents ??= {}
    session.premiumEscalations ??= 0
    session.estimatedPaidUsage ??= 0
    session.freeWorkerCalls ??= 0
    session.unknownPriceCalls ??= 0
    session.paidCallsUsed ??= 0
    if (session.reliability !== undefined) {
      session.reliability = normalizeReliability(session.reliability)
    }
    for (const [id, message] of Object.entries(session.messages)) {
      session.messages[id] = {
        ...message,
        cost: Math.max(0, message.cost ?? 0),
        tokens: normalizeTokens(message.tokens),
      }
    }
  }
  return {
    version: 2,
    updatedAt: candidate.updatedAt ?? new Date(0).toISOString(),
    sessions,
  }
}

export async function readLedgerState(file: string): Promise<LedgerState> {
  try {
    return upgradeState(JSON.parse(await readFile(file, "utf8")))
  } catch {
    return emptyLedgerState()
  }
}

export class Ledger {
  readonly enabled: boolean
  readonly stateFile: string
  private readonly storeTexts: boolean
  private readonly modelCosts: Map<string, ModelCost>
  private readonly pricingOf: PricingLookup | undefined
  private state?: LedgerState
  private queue = Promise.resolve()
  /**
   * In-memory per-session pending retryable failure: session id -> attempt
   * number that failed. Cleared when the next assistant attempt in that session
   * is observed. Terminal kinds (auth/invalid-request/other) never populate it,
   * so no retry transition is fabricated for them.
   */
  private readonly pendingFailure = new Map<string, number>()

  constructor(
    directory: string,
    telemetryDirectory: string,
    enabled: boolean,
    pools: ModelCandidateInput[][],
    storeTexts = false,
    pricingOf?: PricingLookup,
  ) {
    this.enabled = enabled
    this.storeTexts = storeTexts
    this.pricingOf = pricingOf
    this.stateFile = path.resolve(directory, telemetryDirectory, "state.json")
    this.modelCosts = new Map(
      pools.flat().map((candidate) => {
        const normalized = normalizeCandidate(candidate)
        return [normalized.id, normalized.cost]
      }),
    )
  }

  private async load(): Promise<LedgerState> {
    if (this.state) return this.state
    try {
      this.state = upgradeState(JSON.parse(await readFile(this.stateFile, "utf8")))
    } catch {
      this.state = emptyLedgerState()
    }
    return this.state
  }

  private async save(state: LedgerState): Promise<void> {
    if (!this.enabled) return
    const directory = path.dirname(this.stateFile)
    await mkdir(directory, { recursive: true })
    const ignoreFile = path.join(directory, ".gitignore")
    try {
      await writeFile(ignoreFile, "*\n!.gitignore\n", { flag: "wx" })
    } catch {
      // The sentinel already exists or the directory is intentionally read-only.
    }
    state.updatedAt = new Date().toISOString()
    const temporary = `${this.stateFile}.tmp`
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8")
    await rename(temporary, this.stateFile)
  }

  private mutate(operation: (state: LedgerState) => void): Promise<void> {
    if (!this.enabled) return Promise.resolve()
    this.queue = this.queue.then(async () => {
      const state = await this.load()
      operation(state)
      await this.save(state)
    })
    return this.queue
  }

  async setProfile(sessionID: string, profile: ProfileName): Promise<void> {
    await this.mutate((state) => {
      const session = (state.sessions[sessionID] ??= emptySession())
      session.profile = profile
    })
  }

  async setConsensus(sessionID: string, consensus: number, details?: { uncertainty?: number; notes?: string }): Promise<void> {
    await this.mutate((state) => {
      const session = (state.sessions[sessionID] ??= emptySession())
      session.consensus = consensus
      if (details?.uncertainty !== undefined) session.consensusUncertainty = details.uncertainty
      if (details?.notes !== undefined) session.consensusNotes = details.notes
    })
  }

  async recordAssistant(info: AssistantInfo): Promise<void> {
    const agent = info.mode ?? "default"
    const model = info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : undefined
    const resolution = resolutionOf(this.pricingOf?.(info.providerID, info.modelID))
    const pricingStatus = resolution?.status
    const tokens = normalizeTokens(info.tokens)
    const priced = resolution
      ? calcCost(resolution, {
        input: tokens.input,
        output: tokens.output,
        reasoning: tokens.reasoning,
        cacheRead: tokens.cache.read,
      })
      : undefined
    const providerCost = Math.max(0, info.cost ?? 0)
    const currentCost = priced?.cost != null && providerCost === 0 ? priced.cost : providerCost
    await this.mutate((state) => {
      const session = (state.sessions[info.sessionID] ??= emptySession())
      const previous = session.messages[info.id]
      const delta = Math.max(0, currentCost - (previous?.cost ?? 0))
      session.estimatedPaidUsage += delta

      if (!previous) {
        session.agents[agent] = (session.agents[agent] ?? 0) + 1
        if (agent === "orch-judge") session.premiumEscalations += 1
        const declared = model ? this.modelCosts.get(model) : undefined
        if (declared === "paid" || (declared === undefined && pricingStatus === "paid")) session.paidCallsUsed += 1
        if (pricingStatus === "unknown") {
          session.unknownPriceCalls += 1
        }
        if (agent.startsWith("orch-") && agent !== "orch-lead" && agent !== "orch-judge" && model
          && (declared === "free" || (declared === undefined && pricingStatus === "free"))) {
          session.freeWorkerCalls += 1
        }
        this.observeReliabilityAttempt(session, info.sessionID, model, info)
      }

      session.messages[info.id] = {
        cost: currentCost,
        agent,
        ...(info.modelID ? { model: info.modelID } : {}),
        ...(info.providerID ? { provider: info.providerID } : {}),
        ...(info.time?.created ? { createdAt: info.time.created } : {}),
        ...(info.time?.completed ? { completedAt: info.time.completed } : {}),
        ...(info.finish ? { finish: info.finish } : {}),
        tokens,
        ...(pricingStatus ? { pricingStatus } : {}),
        ...(previous?.prompt !== undefined ? { prompt: previous.prompt } : {}),
        ...(previous?.reply !== undefined ? { reply: previous.reply } : {}),
      }
    })
  }

  /**
   * Append a normalized reliability event to a session, keeping only the most
   * recent `RELIABILITY_EVENT_CAP` entries. Unrecognizable events are dropped.
   */
  private appendReliabilityEvent(session: SessionLedger, event: ReliabilityEvent): void {
    const normalized = normalizeReliabilityEvent(event)
    if (normalized === undefined) return
    const events = (session.reliability ??= [])
    events.push(normalized)
    if (events.length > RELIABILITY_EVENT_CAP) {
      session.reliability = events.slice(-RELIABILITY_EVENT_CAP)
    }
  }

  /**
   * Observe a genuinely new assistant attempt. A retryable failure that was
   * pending from the previous attempt produces a "retried" transition; then the
   * attempt's own failure (if any) produces a "failed" event and, when
   * retryable, arms the next transition. Successful attempts with no pending
   * failure produce no event.
   */
  private observeReliabilityAttempt(
    session: SessionLedger,
    sessionID: string,
    model: string | undefined,
    info: AssistantInfo,
  ): void {
    const pendingAttempt = this.pendingFailure.get(sessionID)
    const attempt = pendingAttempt !== undefined ? pendingAttempt + 1 : 1

    if (pendingAttempt !== undefined) {
      this.appendReliabilityEvent(session, {
        attempt,
        ...(model !== undefined ? { model } : {}),
        outcome: "retried",
        ...(model !== undefined ? { nextModel: model } : {}),
        at: Date.now(),
      })
      this.pendingFailure.delete(sessionID)
    }

    const kind = classifyFailure(info)
    if (kind === undefined) return

    this.appendReliabilityEvent(session, {
      attempt,
      ...(model !== undefined ? { model } : {}),
      errorKind: kind,
      outcome: "failed",
      at: Date.now(),
    })
    if (isRetryable(kind)) {
      this.pendingFailure.set(sessionID, attempt)
    }
  }

  /**
   * Additive reliability event recording. No-op when the ledger is disabled.
   * The event is sanitized (bounded fields, closed error-kind enum, no raw
   * error text) and the session's event list is capped.
   */
  async recordReliabilityEvent(sessionID: string, event: ReliabilityEvent): Promise<void> {
    await this.mutate((state) => {
      const session = (state.sessions[sessionID] ??= emptySession())
      this.appendReliabilityEvent(session, event)
    })
  }

  /**
   * Opt-in debug text. No-op unless the ledger was constructed with
   * `storeTexts`, so prompts and replies are never persisted by default.
   */
  async recordText(
    sessionID: string,
    messageID: string,
    text: { prompt?: string; reply?: string },
  ): Promise<void> {
    if (!this.storeTexts) return
    await this.mutate((state) => {
      const session = (state.sessions[sessionID] ??= emptySession())
      const message = (session.messages[messageID] ??= {
        cost: 0,
        agent: "default",
        tokens: normalizeTokens(undefined),
      })
      if (text.prompt !== undefined) message.prompt = text.prompt
      if (text.reply !== undefined) message.reply = text.reply
    })
  }

  async getSession(sessionID: string): Promise<SessionLedger> {
    await this.queue
    const state = await this.load()
    return state.sessions[sessionID] ?? emptySession()
  }

  async formatStatus(sessionID: string): Promise<string> {
    const session = await this.getSession(sessionID)
    const agents = Object.entries(session.agents)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, calls]) => `  ${name.padEnd(24)} ${calls}`)
      .join("\n")
    return [
      "OpenCode Orchestra status",
      "",
      `profile: ${session.profile?.toUpperCase() ?? "not classified"}`,
      "",
      "agents:",
      agents || "  no recorded calls",
      "",
      `premium escalations: ${session.premiumEscalations}`,
      `estimated paid usage: $${session.estimatedPaidUsage.toFixed(4)}`,
      `free worker calls: ${session.freeWorkerCalls}`,
      `unknown price calls: ${session.unknownPriceCalls}`,
      `paid calls used: ${session.paidCallsUsed}`,
      `consensus: ${session.consensus === undefined ? "not recorded" : `${Math.round(session.consensus * 100)}%`}`,
      ...(session.consensusUncertainty !== undefined ? [`consensus uncertainty: ${Math.round(session.consensusUncertainty * 100)}%`] : []),
    ].join("\n")
  }
}
