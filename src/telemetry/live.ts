import { mkdir, rename, writeFile } from "node:fs/promises"
import path from "node:path"

/**
 * Live orchestration activity feed.
 *
 * The OpenCode plugin and the standalone dashboard server run in separate
 * processes, so live state is bridged over the filesystem exactly like the
 * usage ledger. The plugin feeds this stream while agents generate (start /
 * delta / finish) and the dashboard's SSE endpoint re-reads the small snapshot
 * file on a poll, diffing it by a monotonic sequence number.
 *
 * The persisted file is intentionally a full snapshot (active agents + a short
 * ring of recent events) rather than an unbounded log, so a freshly connected
 * dashboard client can read the whole thing with no tailing/trimming logic.
 * The `active` array is authoritative for what is running right now; `recent`
 * is a rolling event log used to animate the UI. Flushes to disk are throttled,
 * and start/finish flush immediately so state changes appear promptly.
 */

/** Per-million-token USD prices for a resolved model. */
export interface LiveTokenPrice {
  input: number
  output: number
}

/** An event appended to the stream (start / delta / finish). */
export type LiveEventKind = "start" | "delta" | "finish"

export interface LiveEvent {
  /** Monotonic sequence; used by the dashboard as its diffing cursor. */
  seq: number
  e: LiveEventKind
  /** Epoch ms the event was produced. */
  ts: number
  /** Orchestration message id the activity belongs to. */
  k: string
  sessionID?: string | undefined
  agent?: string | undefined
  model?: string | undefined
  provider?: string | undefined
  /** Current snippet of what the agent produced (what it is "doing"). */
  text?: string | undefined
  /** USD cost-so-far (delta carries the running estimate; finish the actual). */
  cost?: number | undefined
  /** Tokens-so-far (delta estimate) or finalized tokens (finish). */
  tokens?: { input: number; output: number; reasoning: number } | undefined
  /** Finalization reason, present on finish events. */
  finish?: string | undefined
  /** Stream-observer confidence + flags, present on flagged deltas. */
  confidence?: number | undefined
  flags?: string[] | undefined
}

/** An agent currently generating. */
export interface LiveActiveAgent {
  key: string
  sessionID?: string | undefined
  agent?: string | undefined
  model?: string | undefined
  provider?: string | undefined
  /** Epoch ms the agent started responding. */
  startedAt: number
  /** Last-seen snippet of the in-progress output. */
  text: string
  /** Estimated USD accrued while still generating. */
  cost: number
  tokens: { input: number; output: number; reasoning: number }
  confidence?: number | undefined
  flags?: string[] | undefined
}

export interface LiveSnapshot {
  version: 1
  /** Epoch ms the snapshot was last written. */
  updatedAt: number
  /** Maximum sequence emitted so far. */
  seq: number
  /** Agents currently generating. */
  active: LiveActiveAgent[]
  /** Rolling event log (newest last). */
  recent: LiveEvent[]
}

interface ActiveState extends LiveActiveAgent {
  lastSeq: number
}

const MAX_RECENT = 200
const THROTTLE_MS = 450

function emptySnapshot(): LiveSnapshot {
  return { version: 1, updatedAt: 0, seq: 0, active: [], recent: [] }
}

export function emptyLiveSnapshot(): LiveSnapshot {
  return emptySnapshot()
}

/** Parse the persisted live snapshot; returns an empty snapshot on failure. */
export function parseLiveSnapshot(text: string): LiveSnapshot {
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== "object" || parsed === null) return emptySnapshot()
    const candidate = parsed as Partial<LiveSnapshot>
    if (candidate.version !== 1) return emptySnapshot()
    return {
      version: 1,
      updatedAt: typeof candidate.updatedAt === "number" ? candidate.updatedAt : 0,
      seq: typeof candidate.seq === "number" ? candidate.seq : 0,
      active: Array.isArray(candidate.active) ? candidate.active : [],
      recent: Array.isArray(candidate.recent) ? candidate.recent : [],
    }
  } catch {
    return emptySnapshot()
  }
}

/** Estimate output tokens from character count (≈4 chars/token). */
export function estimateOutputTokens(chars: number): number {
  return Math.max(0, Math.floor(chars / 4))
}

/** Estimate live USD accrued from accumulated text + assumed input volume. */
export function estimateLiveCost(
  chars: number,
  price: LiveTokenPrice | undefined,
  assumedInput = 1500,
): { cost: number; input: number; output: number } {
  const output = estimateOutputTokens(chars)
  const input = assumedInput
  let cost = 0
  if (price) {
    cost = (input * price.input + output * price.output) / 1_000_000
  }
  return { cost, input, output }
}

export class LiveStream {
  readonly liveFile: string
  private readonly maxRecent: number
  private readonly throttleMs: number
  private readonly estimatePrice: (provider: string | undefined, model: string | undefined) => LiveTokenPrice | undefined
  private active = new Map<string, ActiveState>()
  private recent: LiveEvent[] = []
  private seq = 0
  private queue: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastWrite = 0
  private dirty = false
  private enabled: boolean

  constructor(
    directory: string,
    telemetryDirectory: string,
    enabled: boolean,
    estimatePrice: (provider: string | undefined, model: string | undefined) => LiveTokenPrice | undefined = () => undefined,
    maxRecent = MAX_RECENT,
    throttleMs = THROTTLE_MS,
  ) {
    this.liveFile = path.resolve(directory, telemetryDirectory, "live.ndjson")
    this.enabled = enabled
    this.maxRecent = maxRecent
    this.throttleMs = throttleMs
    this.estimatePrice = estimatePrice
  }

  private makeEvent(input: Omit<LiveEvent, "seq" | "ts">): LiveEvent {
    const event: LiveEvent = { seq: ++this.seq, ts: Date.now(), ...input }
    this.recent.push(event)
    if (this.recent.length > this.maxRecent) this.recent.splice(0, this.recent.length - this.maxRecent)
    return event
  }

  /** Mark an agent message as started generating. */
  start(input: {
    key: string
    sessionID?: string | undefined
    agent?: string | undefined
    provider?: string | undefined
    model?: string | undefined
    startedAt?: number
  }): void {
    if (!this.enabled) return
    if (this.active.has(input.key)) {
      this.scheduleFlush(true)
      return
    }
    const price = this.estimatePrice(input.provider, input.model)
    const est = estimateLiveCost(0, price)
    this.active.set(input.key, {
      key: input.key,
      sessionID: input.sessionID,
      agent: input.agent,
      model: input.model,
      provider: input.provider,
      startedAt: input.startedAt ?? Date.now(),
      text: "",
      cost: est.cost,
      tokens: { input: est.input, output: 0, reasoning: 0 },
      lastSeq: this.seq,
    })
    this.makeEvent({
      e: "start",
      k: input.key,
      sessionID: input.sessionID,
      agent: input.agent,
      model: input.model,
      provider: input.provider,
      text: "",
      cost: 0,
      tokens: undefined,
    })
    this.scheduleFlush(true)
  }

  /**
   * Append generated text for an in-flight agent. Each delta updates the
   * in-memory state immediately and is appended to the rolling log; the disk
   * flush is throttled by the class so the dashboard poll stays cheap.
   */
  delta(input: {
    key: string
    text: string
    sessionID?: string | undefined
    agent?: string | undefined
    provider?: string | undefined
    model?: string | undefined
    confidence?: number | undefined
    flags?: string[] | undefined
  }): void {
    if (!this.enabled) return
    const existing = this.active.get(input.key)
    if (!existing) {
      // No prior start for this key: synthesize one so the row is visible.
      this.start({
        key: input.key,
        sessionID: input.sessionID,
        agent: input.agent,
        provider: input.provider,
        model: input.model,
      })
      return
    }
    if (input.sessionID) existing.sessionID = input.sessionID
    if (input.agent) existing.agent = input.agent
    if (input.model) existing.model = input.model
    if (input.provider) existing.provider = input.provider
    const snippet = input.text.length > 240 ? `${input.text.slice(-240)}…` : input.text
    existing.text = snippet
    existing.confidence = input.confidence
    existing.flags = input.flags
    existing.lastSeq = this.seq
    const price = this.estimatePrice(input.provider ?? existing.provider, input.model ?? existing.model)
    const est = estimateLiveCost(snippet.length, price)
    existing.cost = est.cost
    existing.tokens = { input: est.input, output: est.output, reasoning: 0 }
    this.record({
      e: "delta",
      k: input.key,
      sessionID: existing.sessionID,
      agent: existing.agent,
      model: input.model ?? existing.model,
      provider: input.provider ?? existing.provider,
      text: snippet,
      cost: existing.cost,
      tokens: { input: existing.tokens.input, output: existing.tokens.output, reasoning: existing.tokens.reasoning },
      confidence: input.confidence,
      flags: input.flags,
    })
  }

  /** Mark an agent message as finished and remove it from the active set. */
  finish(input: {
    key: string
    cost: number
    tokens?: { input: number; output: number; reasoning: number } | undefined
    finish?: string | undefined
    sessionID?: string | undefined
    agent?: string | undefined
  }): void {
    if (!this.enabled) return
    const existing = this.active.get(input.key)
    this.active.delete(input.key)
    const tokens = input.tokens ?? existing?.tokens ?? { input: 0, output: 0, reasoning: 0 }
    this.record({
      e: "finish",
      k: input.key,
      sessionID: input.sessionID ?? existing?.sessionID,
      agent: input.agent ?? existing?.agent,
      model: existing?.model,
      provider: existing?.provider,
      cost: input.cost,
      tokens,
      finish: input.finish,
    })
    this.scheduleFlush(true)
  }

  /** The current snapshot (before the next disk flush). */
  current(): LiveSnapshot {
    return this.serialize()
  }

  private record(input: Omit<LiveEvent, "seq" | "ts">): void {
    this.makeEvent(input)
    this.scheduleFlush(false)
  }

  private serialize(): LiveSnapshot {
    const active = [...this.active.values()]
      .map(({ lastSeq: _lastSeq, ...rest }) => rest)
      .sort((a, b) => a.startedAt - b.startedAt)
    return {
      version: 1,
      updatedAt: this.lastWrite || Date.now(),
      seq: this.seq,
      active,
      recent: [...this.recent],
    }
  }

  private scheduleFlush(immediate: boolean): void {
    if (!this.enabled) return
    this.dirty = true
    if (immediate) {
      if (this.timer) {
        clearTimeout(this.timer)
        this.timer = undefined
      }
      void this.flush()
      return
    }
    if (this.timer) return
    const remaining = this.throttleMs - (Date.now() - this.lastWrite)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, Math.max(20, remaining))
  }

  private flush(): Promise<void> {
    this.dirty = false
    this.lastWrite = Date.now()
    const snapshot = this.serialize()
    this.queue = this.queue.then(async () => {
      try {
        const directory = path.dirname(this.liveFile)
        await mkdir(directory, { recursive: true })
        // Keep the live telemetry directory out of version control, mirroring
        // the ledger's sentinel so state and live feeds are both untracked.
        const ignoreFile = path.join(directory, ".gitignore")
        try {
          await writeFile(ignoreFile, "*\n!.gitignore\n", { flag: "wx" })
        } catch {
          // The sentinel already exists.
        }
        const temporary = `${this.liveFile}.tmp`
        await writeFile(temporary, JSON.stringify(snapshot) + "\n", "utf8")
        await rename(temporary, this.liveFile)
      } catch {
        // Live telemetry is best-effort; a failure must never break orchestration.
      }
    })
    return this.queue
  }

  async dispose(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.dirty) await this.flush()
    else await this.queue
  }
}
