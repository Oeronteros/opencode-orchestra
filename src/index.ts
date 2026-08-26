import type { Config, Plugin } from "@opencode-ai/plugin"
import { createAgentSet } from "./agents/build.js"
import type { RuntimeAgentConfig } from "./agents/types.js"
import { loadConfig } from "./config/load.js"
import { openCodeConfigDirectory } from "./config/paths.js"
import { registerProject } from "./dashboard/registry.js"
import { applyBudgetPreset } from "./config/defaults.js"
import type { ModelCandidateInput } from "./config/schema.js"
import { loadPrompts } from "./prompts/load.js"
import { applyDiscoveredModels, discoverConnectedModels } from "./routing/model-discovery.js"
import { primarySystemHint } from "./superpowers/compatibility.js"
import { Ledger } from "./telemetry/ledger.js"
import { LiveStream } from "./telemetry/live.js"
import { createOrchestraTools } from "./tools.js"
import { createStreamObserver, type StreamObserver } from "./routing/observer.js"
import { createPriceRefresher, type RefreshSource } from "./routing/pricing/refresh.js"
import { createOpenRouterCache } from "./pricing/openrouter.js"
import { resolvePricingSync } from "./pricing/resolver.js"
import { detectMcpPresence, resolvePluginVersion, PACKAGE_NAME, type PluginStatus } from "./plugin-status.js"
import { createGitWorktreeAdapter } from "./orchestration/worktree-adapter.js"

type MutableConfig = Omit<Config, "agent" | "command"> & {
  agent?: Record<string, RuntimeAgentConfig>
  command?: Record<string, { template: string; description?: string; agent?: string }>
}

function mergeAgent(base: RuntimeAgentConfig, override?: RuntimeAgentConfig): RuntimeAgentConfig {
  if (!override) return base
  return {
    ...base,
    ...override,
    permission: {
      ...base.permission,
      ...override.permission,
    },
  }
}

// Stream observers keyed by message part id. These let us flag low-confidence
// or self-correcting output *while a worker is still generating*, before any
// finalized answer exists, so escalation can fire early instead of post-hoc.
const streamObservers = new Map<string, StreamObserver>()
const flaggedParts = new Set<string>()
const STREAM_CONFIDENCE_THRESHOLD = 0.6

// Opt-in reply text and prompt text accumulation, keyed by message id. Only
// populated when `telemetry.storeTexts` is enabled; otherwise dropped.
const replyBuffers = new Map<string, string>()
// A chat.message prompt precedes its assistant message and has a different id,
// so prompts are correlated by session rather than by assistant message id.
const promptBuffers = new Map<string, string>()
const MAX_TEXT_BUFFERS = 512
let storeTextsFlag = false

// Live agent activity identity, mapped per session so streaming deltas can be
// attributed to an agent + model before the assistant message finalizes.
// Populated on every LLM request via the chat.params hook.
const sessionAgent = new Map<string, string>()
const sessionModel = new Map<string, { providerID: string; modelID: string }>()
// Per-response accumulated text (independent of telemetry.storeTexts) used to
// show "what the agent is doing" in the live dashboard panel. Bounded.
const liveTexts = new Map<string, string>()
const liveTextLengths = new Map<string, number>()
// Estimated reasoning accumulation, split from output text so the live output
// tok/s is not inflated by thinking output. Only lengths are kept; reasoning
// text is never persisted (same privacy policy as output snippets).
const liveReasoningLengths = new Map<string, number>()
// Per-part dedupe between the two delta sources OpenCode can use:
// `message.part.delta` carries incremental chunks, while
// `message.part.updated` carries cumulative `part.text`. `livePartSeen` is how
// many characters per part have already been fed from either source, so the
// cumulative view only ever appends the unseen suffix (no double counting).
const livePartSeen = new Map<string, number>()
// Part type remembered from part events so reasoning deltas (which arrive with
// field "text", same as output) can be routed to the reasoning estimate.
const livePartKinds = new Map<string, string>()
// Message ids finalized by message.updated; guards against a late delta
// resurrecting an active row that no finish will ever remove.
const finishedLiveMessages = new Set<string>()
const recoveryNotices = new Set<string>()

function pruneOldest(map: Map<string, string>): void {
  while (map.size > MAX_TEXT_BUFFERS) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

function pruneLiveAccumulators(): void {
  const pruneNumberMap = (map: Map<string, number>): void => {
    while (map.size > MAX_TEXT_BUFFERS) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }
  pruneNumberMap(liveReasoningLengths)
  const pruneSeen = (map: Map<string, number>): void => {
    while (map.size > MAX_TEXT_BUFFERS * 4) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }
  pruneSeen(livePartSeen)
  while (livePartKinds.size > MAX_TEXT_BUFFERS * 4) {
    const oldest = livePartKinds.keys().next().value
    if (oldest === undefined) break
    livePartKinds.delete(oldest)
  }
}

/** Accumulate a text delta, retaining a bounded snippet and exact length. */
function appendLiveText(messageID: string, delta: string): { text: string; chars: number } {
  const current = liveTexts.get(messageID) ?? ""
  const next = current.length > 4_000 ? current.slice(-1_600) + delta : current + delta
  liveTexts.set(messageID, next)
  const chars = (liveTextLengths.get(messageID) ?? 0) + delta.length
  liveTextLengths.set(messageID, chars)
  pruneOldest(liveTexts)
  while (liveTextLengths.size > MAX_TEXT_BUFFERS) {
    const oldest = liveTextLengths.keys().next().value
    if (oldest === undefined) break
    liveTextLengths.delete(oldest)
  }
  return { text: next.length > 240 ? next.slice(-240) : next, chars }
}

/** Accumulate reasoning length only; reasoning text itself is never stored. */
function appendLiveReasoning(messageID: string, delta: string): number {
  const chars = (liveReasoningLengths.get(messageID) ?? 0) + delta.length
  liveReasoningLengths.set(messageID, chars)
  while (liveReasoningLengths.size > MAX_TEXT_BUFFERS) {
    const oldest = liveReasoningLengths.keys().next().value
    if (oldest === undefined) break
    liveReasoningLengths.delete(oldest)
  }
  return chars
}

/**
 * OpenCode 1.18.x streams text in dedicated `message.part.delta` events
 * ({sessionID, messageID, partID, field, delta}); the v1 plugin Event union
 * predates that event type, so it is declared and guarded locally.
 */
interface LivePartDeltaEvent {
  type: "message.part.delta"
  properties: {
    sessionID: string
    messageID: string
    partID: string
    field: string
    delta: string
  }
}

function isLivePartDeltaEvent(event: unknown): event is LivePartDeltaEvent {
  return typeof event === "object" && event !== null && (event as { type?: unknown }).type === "message.part.delta"
}

function trackStreamDelta(sessionID: string, part: { id: string; messageID: string }, delta: string): void {
  if (!delta) return
  const partID = part.id
  let observer = streamObservers.get(partID)
  if (!observer) {
    observer = createStreamObserver({ threshold: STREAM_CONFIDENCE_THRESHOLD })
    streamObservers.set(partID, observer)
  }
  const observation = observer.push(delta)
  if (observation.lowConfidence && !flaggedParts.has(partID)) {
    flaggedParts.add(partID)
    void logStreamFlag(sessionID, partID, observation).catch(() => undefined)
  }
  if (storeTextsFlag) {
    replyBuffers.set(part.messageID, `${replyBuffers.get(part.messageID) ?? ""}${delta}`)
    pruneOldest(replyBuffers)
  }
}

function endStream(messageID: string): void {
  // A finalized message no longer needs an accumulated reply after its event
  // handler has consumed it. Keep the id parameter explicit for lifecycle use.
  if (!storeTextsFlag) replyBuffers.delete(messageID)
  // Observers are pruned lazily by size to bound memory over a long session.
  if (streamObservers.size > 512) {
    const overflow = streamObservers.size - 512
    let removed = 0
    for (const key of streamObservers.keys()) {
      if (removed >= overflow) break
      streamObservers.delete(key)
      flaggedParts.delete(key)
      removed += 1
    }
  }
}

// Stub logger: replaced when the plugin body captures `client.app.log`.
let streamLog: (sessionID: string, message: string, extra: unknown) => Promise<void> = () => Promise.resolve()

function logStreamFlag(sessionID: string, partID: string, observation: { confidence: number; flags: string[] }): Promise<void> {
  return streamLog(sessionID, "orchestra stream observer flagged low-confidence output", {
    partID,
    confidence: observation.confidence,
    flags: observation.flags,
  })
}

export const OrchestraPlugin: Plugin = async ({ client, directory, experimental_workspace }, rawOptions = {}) => {
  // Experimental OpenCode workspace integration: editors can be assigned isolated git worktrees.
  const loaded = await loadConfig(directory, rawOptions)
  experimental_workspace?.register("git", createGitWorktreeAdapter(directory, loaded.config.orchestration.worktreeRoot))
  await registerProject(directory, openCodeConfigDirectory()).catch(() => undefined)
  const discovered = await discoverConnectedModels(client)
  const orchestra = applyDiscoveredModels(applyBudgetPreset(loaded.config), discovered)
  const prompts = await loadPrompts()
  const agents = createAgentSet(orchestra, prompts)
  const pools: ModelCandidateInput[][] = [
    orchestra.models.lead,
    ...Object.values(orchestra.models.worker),
    orchestra.models.judge,
  ]
  const ledger = new Ledger(directory, orchestra.telemetry.directory, orchestra.telemetry.enabled, pools, orchestra.telemetry.storeTexts, (providerID, modelID) =>
    resolvePricingSync({
      ...(providerID ? { providerID } : {}),
      ...(modelID ? { modelID } : {}),
    }, pricingConfig()).status)
  storeTextsFlag = orchestra.telemetry.storeTexts
  const refreshSource: RefreshSource | undefined = orchestra.pricing.endpoint
    ? { endpoint: orchestra.pricing.endpoint, refreshIntervalHours: orchestra.pricing.refreshIntervalHours }
    : undefined
  const priceRefresher = createPriceRefresher(undefined, refreshSource)
  priceRefresher.start()
  // Optional OpenRouter pricing fallback: used when neither provider data nor
  // the price snapshot can price a model. Opt-in so offline behavior never
  // changes unless explicitly configured.
  const openRouter = orchestra.pricing.openrouter.enabled
    ? createOpenRouterCache({ ttlMs: orchestra.pricing.openrouter.ttlHours * 3_600_000 })
    : undefined
  const pricingAliases = orchestra.pricing.aliases
  const pricingConfig = (): { snapshot: typeof priceRefresher.snapshot; aliases?: typeof pricingAliases } => ({
    snapshot: priceRefresher.snapshot,
    ...(pricingAliases.length ? { aliases: pricingAliases } : {}),
  })
  // Live orchestration activity feed: records which agents are generating and
  // what they produce (plus an estimated cost-so-far) for the dashboard SSE.
  const live = new LiveStream(directory, orchestra.telemetry.directory, orchestra.telemetry.enabled, (provider, model) => {
    if (!model) return undefined
    const resolution = resolvePricingSync({ ...(provider ? { providerID: provider } : {}), modelID: model }, pricingConfig())
    if (resolution.status !== "paid") return undefined
    return { input: resolution.input ?? 0, output: resolution.output ?? 0 }
  }, 200, 450, orchestra.telemetry.storeTexts)
  /**
   * Feed one incremental text chunk into the live stream + stream observer.
   * Reasoning parts (announced earlier via `message.part.updated` part.type)
   * are routed to the reasoning estimate so the dashboard output tok/s stays
   * meaningful. Deduplicated against the cumulative part.updated view through
   * `livePartSeen`, and skipped for already-finalized messages.
   */
  const feedLiveStream = (sessionID: string, messageID: string, partID: string, delta: string): void => {
    if (!delta || finishedLiveMessages.has(messageID)) return
    const model = sessionModel.get(sessionID)
    const kind = livePartKinds.get(partID)
    const seen = livePartSeen.get(partID) ?? 0
    livePartSeen.set(partID, seen + delta.length)
    trackStreamDelta(sessionID, { id: partID, messageID }, delta)
    if (kind === "reasoning") {
      const reasoningChars = appendLiveReasoning(messageID, delta)
      const output = liveTexts.get(messageID)
      live.delta({
        key: messageID,
        sessionID,
        agent: sessionAgent.get(sessionID),
        // Keep the last output snippet: reasoning text must not overwrite it.
        text: output === undefined ? "" : output.length > 240 ? output.slice(-240) + "…" : output,
        chars: liveTextLengths.get(messageID) ?? 0,
        reasoningChars,
        provider: model?.providerID,
        model: model?.modelID,
      })
    } else {
      const text = appendLiveText(messageID, delta)
      live.delta({
        key: messageID,
        sessionID,
        agent: sessionAgent.get(sessionID),
        text: text.text,
        chars: text.chars,
        reasoningChars: liveReasoningLengths.get(messageID) ?? 0,
        provider: model?.providerID,
        model: model?.modelID,
      })
    }
  }
  const systemHint = primarySystemHint(orchestra)
  const pluginStatus: PluginStatus = {
    name: PACKAGE_NAME,
    version: await resolvePluginVersion(),
    budget: orchestra.budget,
    modelStrategy: orchestra.models.strategy,
    configuredModels: pools.flat().length,
    discoveredModels: discovered.length,
    configSource: loaded.source ?? "plugin options/defaults",
    mcp: await detectMcpPresence(),
  }

  streamLog = (sessionID, message, extra) =>
    client.app
      .log({
        body: { service: "opencode-orchestra", level: "warn", message, extra: { sessionID, ...(extra as object) } },
      })
      .then(() => undefined)
      .catch(() => undefined)

  await client.app
    .log({
      body: {
        service: "opencode-orchestra",
        level: "info",
        message: "OpenCode Orchestra initialized",
        extra: {
          budget: orchestra.budget,
          configSource: loaded.source ?? "plugin options/defaults",
          configuredModels: pools.flat().length,
          discoveredModels: discovered.length,
          modelStrategy: orchestra.models.strategy,
        },
      },
    })
    .catch(() => undefined)

  return {
    config: async (input) => {
      const mutable = input as unknown as MutableConfig
      mutable.agent ??= {}
      for (const [name, agent] of Object.entries(agents)) {
        const merged = mergeAgent(agent, mutable.agent[name])
        // Keep the primary lead writable; isolated editors write only inside their OpenCode workspaces.
        // The integrator remains Git-only even if a user override broadly enables edit.
        mutable.agent[name] = name === "orch-lead"
          ? { ...merged, permission: { ...merged.permission, edit: "allow" } }
          : name === "orch-integrator"
            ? { ...merged, permission: { ...merged.permission, edit: "deny" } }
            : merged
      }
      mutable.command ??= {}
      mutable.command["orchestra-status"] ??= {
        description: "Show OpenCode Orchestra usage and escalation status",
        template: "Call the orchestra_status tool and present its result verbatim.",
      }
      mutable.command["plugin-status"] ??= {
        description: "Show the OpenCode Orchestra plugin's own runtime status",
        template: "Call the orchestra_plugin_status tool and present its result verbatim.",
      }
      mutable.command.orchestra ??= {
        description: "Classify a task and execute it through orch-lead",
        agent: "orch-lead",
        template: "Call orchestra_route for this task: $ARGUMENTS. Then execute the returned plan yourself as orch-lead. For safe parallel implementation, call orchestration_prepare_edit_plan with explicit ownership, run each orch-editor in its own experimental git workspace, validate every commit with orchestration_validate_commit, then call orch-integrator once. Otherwise implement directly. Always verify the result.",
      }
    },
    tool: createOrchestraTools(orchestra, ledger, pluginStatus, {
      get snapshot() { return priceRefresher.snapshot },
      ...(pricingAliases.length ? { aliases: pricingAliases } : {}),
      ...(openRouter ? { openRouter } : {}),
    }),
    dispose: async () => {
      priceRefresher.stop()
      await live.dispose()
      promptBuffers.clear()
      replyBuffers.clear()
      liveTexts.clear()
      liveTextLengths.clear()
      liveReasoningLengths.clear()
      livePartSeen.clear()
      livePartKinds.clear()
      finishedLiveMessages.clear()
      recoveryNotices.clear()
      sessionAgent.clear()
      sessionModel.clear()
      streamObservers.clear()
      flaggedParts.clear()
    },
    "chat.message": async ({ sessionID, agent, model }, output) => {
      if (!sessionID) return
      if (agent) sessionAgent.set(sessionID, agent)
      if (model) sessionModel.set(sessionID, { providerID: model.providerID, modelID: model.modelID ?? (model as { id?: string }).id ?? "" })
      if (!storeTextsFlag) return
      const text = output.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
        .trim()
      if (text) {
        promptBuffers.set(sessionID, text)
        pruneOldest(promptBuffers)
      }
    },
    "chat.params": async ({ sessionID, agent, model }) => {
      // Capture the agent + model for the in-flight LLM request so live stream
      // deltas can attribute activity before the assistant message finalizes.
      if (!sessionID) return
      if (agent) sessionAgent.set(sessionID, agent)
      if (model) sessionModel.set(sessionID, { providerID: model.providerID, modelID: (model as { modelID?: string }).modelID ?? model.id })
    },
    event: async ({ event }) => {
      const eventRecord = event as unknown as { type?: string; properties?: { sessionID?: string; error?: unknown } }
      if (eventRecord.type === "session.error" || eventRecord.type === "session.idle") {
        const sessionID = eventRecord.properties?.sessionID
        if (sessionID && !recoveryNotices.has(`${sessionID}:${eventRecord.type}`)) {
          recoveryNotices.add(`${sessionID}:${eventRecord.type}`)
          await client.app.log({ body: {
            service: "opencode-orchestra",
            level: eventRecord.type === "session.error" ? "warn" : "info",
            message: eventRecord.type === "session.error"
              ? "Orchestra session encountered an error; no automatic continuation was submitted."
              : "Orchestra session is idle; orchestration remains available for the next explicit request.",
            extra: { sessionID, ...(eventRecord.properties?.error ? { error: eventRecord.properties.error } : {}) },
          } }).catch(() => undefined)
        }
        return
      }
      if (event.type === "message.part.updated") {
        const part = event.properties.part
        const delta = event.properties.delta ?? ""
        // Remember the part type: reasoning deltas arrive through the channel
        // below with field "text" and can only be split off via this record.
        livePartKinds.set(part.id, part.type)
        pruneLiveAccumulators()
        // Assistant messages announce themselves via assistant-only part kinds
        // (step-start begins every LLM step; reasoning/tool parts never appear
        // in user messages). LiveStream.start() is idempotent per key, so this
        // fills `active` even when text deltas don't arrive (tool/non-streaming).
        if (part.type === "step-start" || part.type === "reasoning" || part.type === "tool") {
          const m = sessionModel.get(part.sessionID)
          live.start({
            key: part.messageID, // === assistant info.id (see SDK Part.messageID)
            sessionID: part.sessionID,
            agent: sessionAgent.get(part.sessionID),
            provider: m?.providerID,
            model: m?.modelID,
          })
        }
        if (delta) {
          // Legacy/older runtimes deliver incremental deltas here.
          feedLiveStream(part.sessionID, part.messageID, part.id, delta)
        } else if (typeof (part as { text?: unknown }).text === "string") {
          // Fallback for runtimes that only publish cumulative `part.text`
          // (bootstrap replay / non-streaming paths): feed the unseen suffix.
          const cumulative = (part as { text: string }).text
          const seen = livePartSeen.get(part.id) ?? 0
          if (cumulative.length > seen) {
            livePartSeen.set(part.id, cumulative.length)
            feedLiveStream(part.sessionID, part.messageID, part.id, cumulative.slice(seen))
          }
        }
        return
      }
      const candidate = event as unknown
      if (isLivePartDeltaEvent(candidate)) {
        const properties = candidate.properties
        if (properties.field !== "text") return
        feedLiveStream(properties.sessionID, properties.messageID, properties.partID, properties.delta)
        return
      }
      if (event.type !== "message.updated") return
      const info = event.properties.info
      if (info.role !== "assistant") return
      // If a turn emits no assistant-only part (e.g. some non-streaming path),
      // start the live row from the still-running assistant message instead.
      const finished =
        info.time.completed !== undefined || info.finish !== undefined || info.error !== undefined
      if (!finished) {
        const m = sessionModel.get(info.sessionID)
        live.start({
          key: info.id,
          sessionID: info.sessionID,
          agent: sessionAgent.get(info.sessionID),
          provider: m?.providerID,
          model: m?.modelID,
        })
        return // do not finalize a still-running message
      }
      endStream(info.id)
      // Always finalize the live row so an active entry never goes stale, even
      // for sessions whose agent/model were not captured by chat.params yet.
      live.finish({
        key: info.id,
        sessionID: info.sessionID,
        agent: sessionAgent.get(info.sessionID),
        cost: info.cost,
        tokens: { input: info.tokens.input, output: info.tokens.output, reasoning: info.tokens.reasoning },
        finish: info.finish,
      })
      liveTexts.delete(info.id)
      liveTextLengths.delete(info.id)
      liveReasoningLengths.delete(info.id)
      // Later parts must not resurrect the finished row as a fresh active one.
      finishedLiveMessages.add(info.id)
      while (finishedLiveMessages.size > MAX_TEXT_BUFFERS * 2) {
        const oldest = finishedLiveMessages.values().next().value
        if (oldest === undefined) break
        finishedLiveMessages.delete(oldest)
      }
      await ledger.recordAssistant(info)
      if (storeTextsFlag) {
        const prompt = promptBuffers.get(info.sessionID)
        const reply = replyBuffers.get(info.id)
        promptBuffers.delete(info.sessionID)
        replyBuffers.delete(info.id)
        if (prompt !== undefined || reply !== undefined) {
          const text: { prompt?: string; reply?: string } = {}
          if (prompt !== undefined) text.prompt = prompt
          if (reply !== undefined) text.reply = reply
          await ledger.recordText(info.sessionID, info.id, text)
        }
      }
    },
    ...(systemHint
      ? {
          "experimental.chat.system.transform": async (_input, output) => {
            output.system.push(systemHint)
          },
        }
      : {}),
  }
}

// OpenCode 1.18.x resolves a plugin module as `{ id?, server }` (see
// `@opencode-ai/plugin` / `PluginModule`). Older builds resolved a
// default/self-named export instead, so export both for compatibility.
export const server: Plugin = OrchestraPlugin

// OpenCode 1.18 desktop resolves the default export as a PluginModule.
export default {
  id: "opencode-orchestra",
  server: OrchestraPlugin,
} satisfies { id: string; server: Plugin }
