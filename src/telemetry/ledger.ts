import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import type { ModelCandidateInput, ModelCost, ProfileName } from "../config/schema.js"
import { normalizeCandidate } from "../routing/model-resolver.js"

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
  /** Opt-in debug text: only recorded when telemetry.storeTexts is enabled. */
  prompt?: string
  reply?: string
}

export interface SessionLedger {
  profile?: ProfileName
  agents: Record<string, number>
  premiumEscalations: number
  estimatedPaidUsage: number
  freeWorkerCalls: number
  consensus?: number
  messages: Record<string, MessageUsage>
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
}

function emptySession(): SessionLedger {
  return {
    agents: {},
    premiumEscalations: 0,
    estimatedPaidUsage: 0,
    freeWorkerCalls: 0,
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
  private state?: LedgerState
  private queue = Promise.resolve()

  constructor(
    directory: string,
    telemetryDirectory: string,
    enabled: boolean,
    pools: ModelCandidateInput[][],
    storeTexts = false,
  ) {
    this.enabled = enabled
    this.storeTexts = storeTexts
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

  async setConsensus(sessionID: string, consensus: number): Promise<void> {
    await this.mutate((state) => {
      const session = (state.sessions[sessionID] ??= emptySession())
      session.consensus = consensus
    })
  }

  async recordAssistant(info: AssistantInfo): Promise<void> {
    const agent = info.mode ?? "default"
    await this.mutate((state) => {
      const session = (state.sessions[info.sessionID] ??= emptySession())
      const previous = session.messages[info.id]
      const currentCost = Math.max(0, info.cost ?? 0)
      const delta = Math.max(0, currentCost - (previous?.cost ?? 0))
      session.estimatedPaidUsage += delta

      if (!previous) {
        session.agents[agent] = (session.agents[agent] ?? 0) + 1
        if (agent === "orch-judge") session.premiumEscalations += 1
        const model = info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : undefined
        if (agent.startsWith("orch-") && agent !== "orch-lead" && agent !== "orch-judge" && model && this.modelCosts.get(model) === "free") {
          session.freeWorkerCalls += 1
        }
      }

      session.messages[info.id] = {
        cost: currentCost,
        agent,
        ...(info.modelID ? { model: info.modelID } : {}),
        ...(info.providerID ? { provider: info.providerID } : {}),
        ...(info.time?.created ? { createdAt: info.time.created } : {}),
        ...(info.time?.completed ? { completedAt: info.time.completed } : {}),
        ...(info.finish ? { finish: info.finish } : {}),
        tokens: normalizeTokens(info.tokens),
        ...(previous?.prompt !== undefined ? { prompt: previous.prompt } : {}),
        ...(previous?.reply !== undefined ? { reply: previous.reply } : {}),
      }
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
      `consensus: ${session.consensus === undefined ? "not recorded" : `${Math.round(session.consensus * 100)}%`}`,
    ].join("\n")
  }
}
