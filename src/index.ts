import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import type { Config, Plugin } from "@opencode-ai/plugin"
import { createAgentSet } from "./agents/build.js"
import type { RuntimeAgentConfig } from "./agents/types.js"
import { InvalidConfigError, loadConfig, type LoadedConfig } from "./config/load.js"
import { globalOrchestraConfig, openCodeConfigDirectory } from "./config/paths.js"
import { registerProject } from "./dashboard/registry.js"
import { applyBudgetPreset, DEFAULT_CONFIG } from "./config/defaults.js"
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
import { calcCost } from "./pricing/cost.js"
import { resolvePricingSync, type ResolverConfig } from "./pricing/resolver.js"
import { detectMcpPresence, resolvePluginVersion, PACKAGE_NAME, type PluginStatus } from "./plugin-status.js"
import { createGitWorktreeAdapter } from "./orchestration/worktree-adapter.js"
import { OrchestrationRunState, type DispatchLease } from "./orchestration/run-state.js"
import { releasePlanMode, type ReminderMessage } from "./routing/plan-reminder.js"
import { LoopController } from "./loop/controller.js"
import { loopPrompt, resolveLoopGoal } from "./loop/protocol.js"

type MutableConfig = Omit<Config, "agent" | "command"> & {
  agent?: Record<string, RuntimeAgentConfig>
  command?: Record<string, { template: string; description?: string; agent?: string }>
  subagent_depth?: number
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Live auto-accept state.
 *
 * The dashboard toggle writes orchestra.jsonc while sessions are running, but
 * plugin config is loaded once at startup, so a statically registered hook
 * would go stale: the panel shows auto-accept ON while the running session
 * still prompts. The permission.ask hook below therefore re-reads the toggle
 * from the config files (mtime-cached) instead of capturing it at load time.
 * Plugin options passed directly to the plugin still outrank file config,
 * mirroring loadConfig's merge order (options > project > global).
 */
interface AutoAcceptCache {
  signatures: Map<string, number>
  value: boolean | undefined
}

function createLiveAutoAccept(directory: string, rawOptions: Record<string, unknown>): () => boolean {
  const optionValue = isRecord(rawOptions.permissions) && typeof rawOptions.permissions.autoAcceptAll === "boolean"
    ? rawOptions.permissions.autoAcceptAll
    : undefined
  const projectJsonc = path.join(directory, ".opencode", "orchestra.jsonc")
  const projectJson = path.join(directory, ".opencode", "orchestra.json")
  let cache: AutoAcceptCache | undefined
  return (): boolean => {
    if (optionValue !== undefined) return optionValue
    try {
      // Project JSONC shadows the JSON sibling (same rule as loadConfig).
      let projected = projectJsonc
      try {
        statSync(projectJsonc)
      } catch {
        projected = projectJson
      }
      const files = [globalOrchestraConfig(), projected]
      const signatures = new Map<string, number>()
      let changed = cache === undefined || cache.signatures.size !== files.length
      for (const file of files) {
        let mtime = 0
        try {
          mtime = statSync(file).mtimeMs
        } catch {
          // File does not exist; keep its signature at 0.
        }
        signatures.set(file, mtime)
        if (!changed && cache && cache.signatures.get(file) !== mtime) changed = true
      }
      if (!changed && cache) return cache.value ?? false
      let merged: boolean | undefined
      for (const file of files) {
        if ((signatures.get(file) ?? 0) === 0) continue
        try {
          const raw = readFileSync(file, "utf8")
          const parsed = parseJsonc(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as unknown
          const permissions = isRecord(parsed) && isRecord(parsed.permissions) ? parsed.permissions : undefined
          if (permissions && typeof permissions.autoAcceptAll === "boolean") merged = permissions.autoAcceptAll
        } catch {
          // Mid-save or malformed JSONC: keep the previously known value.
        }
      }
      cache = { signatures, value: merged }
      return merged ?? false
    } catch {
      return cache?.value ?? false
    }
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
// Sessions where the plan→build transition reminder was already logged, so a
// long-lived plan conversation does not re-log the release on every turn.
const planReleaseNotices = new Set<string>()

const MCP_TOOL_PREFIXES: Array<[prefix: string, server: string]> = [
  ["codebase-memory-mcp_", "codebaseMemory"],
  ["codebase-memory_", "codebaseMemory"],
  ["codebase_memory_", "codebaseMemory"],
  ["ast-grep_", "astGrep"],
  ["ast_grep_", "astGrep"],
  ["memorygraph_", "memoryGraph"],
  ["playwright_", "playwright"],
  ["context7_", "context7"],
  ["git_", "git"],
]

export function mcpServerForTool(tool: string): string | undefined {
  return MCP_TOOL_PREFIXES.find(([prefix]) => tool.startsWith(prefix))?.[1]
}

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
  let loaded: LoadedConfig
  try {
    loaded = await loadConfig(directory, rawOptions)
  } catch (error) {
    if (!(error instanceof InvalidConfigError)) throw error
    const reason = error.reason.replace(/\s+/g, " ").trim().slice(0, 200)
    const configPath = error.configPath.replace(/\s+/g, " ").trim().slice(0, 500)
    await client.app.log({
      body: {
        service: "opencode-orchestra",
        level: "warn",
        message: "OpenCode Orchestra ignored invalid config; using defaults",
        extra: { configPath, reason },
      },
    }).catch(() => undefined)
    loaded = { config: DEFAULT_CONFIG }
  }
  experimental_workspace?.register("git", createGitWorktreeAdapter(directory, loaded.config.orchestration.worktreeRoot))
  await registerProject(directory, openCodeConfigDirectory()).catch(() => undefined)
  const discovered = await discoverConnectedModels(client)
  const orchestra = applyDiscoveredModels(applyBudgetPreset(loaded.config), discovered)
  const coordinator = new OrchestrationRunState({
    maxWorkers: orchestra.orchestration.maxWorkers,
    parallelWorkers: orchestra.orchestration.parallelWorkers,
    maxDelegationDepth: orchestra.orchestration.maxDelegationDepth,
  })
  const nativeLeases = new Map<string, DispatchLease>()
  const autoAcceptLive = createLiveAutoAccept(directory, rawOptions)
  const prompts = await loadPrompts()
  const agents = createAgentSet(orchestra, prompts)
  const loopInputs = new Set<string>()
  const loopIdle = new Set<string>()
  const loop = new LoopController({
    enabled: orchestra.orchestration.loop.enabled,
    maxIterations: orchestra.orchestration.loop.maxIterations,
    maxMinutes: orchestra.orchestration.loop.maxMinutes,
    noProgressLimit: orchestra.orchestration.loop.noProgressLimit,
    verifyCommand: orchestra.orchestration.loop.verifyCommand,
    prompt: async (sessionID, text) => {
      loopInputs.add(sessionID)
      loopIdle.delete(sessionID)
      await client.session.promptAsync({ path: { id: sessionID }, query: { directory }, body: { agent: "orch-lead", parts: [{ type: "text", text }] }, throwOnError: true })
    },
    log: (message) => { void client.app.log({ body: { service: "opencode-orchestra", level: "warn", message } }).catch(() => undefined) },
  })
  const pools: ModelCandidateInput[][] = [
    orchestra.models.lead,
    ...Object.values(orchestra.models.worker),
    orchestra.models.judge,
  ]
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
  const pricingConfig = (): ResolverConfig => ({
    snapshot: priceRefresher.snapshot,
    ...(pricingAliases.length ? { aliases: pricingAliases } : {}),
    ...(openRouter ? { openRouter } : {}),
  })
  const resolveModelPricing = (providerID: string | undefined, modelID: string | undefined) =>
    resolvePricingSync({
      ...(providerID ? { providerID } : {}),
      ...(modelID ? { modelID } : {}),
    }, pricingConfig())
  const ledger = new Ledger(directory, orchestra.telemetry.directory, orchestra.telemetry.enabled, pools, orchestra.telemetry.storeTexts, resolveModelPricing)
  const mcpCalls = new Map<string, { sessionID: string; tool: string; server: string; startedAt: number; retry: boolean }>()
  const completedMcpCalls = new Set<string>()
  const pendingMcpFailures = new Set<string>()
  const recordMcpCompletion = async (
    callID: string,
    success: boolean,
    outputChars = 0,
    timing?: { start?: number; end?: number },
  ): Promise<void> => {
    if (completedMcpCalls.has(callID)) return
    const active = mcpCalls.get(callID)
    if (!active) return
    completedMcpCalls.add(callID)
    mcpCalls.delete(callID)
    const failureKey = `${active.sessionID}:${active.tool}`
    if (success) pendingMcpFailures.delete(failureKey)
    else pendingMcpFailures.add(failureKey)
    const durationMs = timing?.start !== undefined && timing.end !== undefined
      ? Math.max(0, timing.end - timing.start)
      : Math.max(0, Date.now() - active.startedAt)
    await ledger.recordMcpCall(coordinator.rootSessionID(active.sessionID), {
      server: active.server,
      tool: active.tool,
      durationMs,
      success,
      outputChars,
      retry: active.retry,
    })
    if (completedMcpCalls.size > 2_048) completedMcpCalls.clear()
  }
  // Warm the OpenRouter catalog in the background so live/ledger can price
  // gateway ids (anymodel/am/kimi-k3) from the in-memory cache without waiting.
  void openRouter?.getModels().catch(() => undefined)
  // Live orchestration activity feed: records which agents are generating and
  // what they produce (plus an estimated cost-so-far) for the dashboard SSE.
  const live = new LiveStream(directory, orchestra.telemetry.directory, orchestra.telemetry.enabled, (provider, model) => {
    if (!model) return undefined
    const resolution = resolveModelPricing(provider, model)
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
      mutable.subagent_depth ??= orchestra.orchestration.maxDelegationDepth
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
        template: "Call orchestra_route for this task: $ARGUMENTS. Execute only ready sealed nodes through orchestra_dispatch, passing each nodeId and unchanged TaskContract. For parallel implementation, call orchestration_prepare_edit_plan with baseSha plus non-overlapping file/resource ownership, run each orch-editor in its isolated workspace, validate each commit from the sealed plan, then call orch-integrator once. Always run aggregate verification before completion.",
      }
      mutable.command.loop ??= {
        description: "Drive one goal to completion through bounded orch-lead iterations",
        agent: "orch-lead",
        template: "$ARGUMENTS",
      }
    },
    "command.execute.before": async (input, output) => {
      if (input.command !== "loop") return
      const argument = input.arguments.trim()
      if (argument === "stop") { loopInputs.delete(input.sessionID); loop.stop(input.sessionID); throw new Error("Loop stopped. No further iterations will be submitted; use OpenCode interrupt to abort any current turn.") }
      if (argument === "status") {
        const state = loop.get(input.sessionID)
        throw new Error(state ? `Loop ${state.status}; iteration ${state.iteration}; ${state.reason}` : "No loop in this session.")
      }
      const goal = resolveLoopGoal(argument)
      if (!output.parts.some((part) => part.type === "text")) throw new Error("Loop command has no text part; activation refused.")
      loop.start(input.sessionID, goal)
      loopIdle.delete(input.sessionID)
      loopInputs.add(input.sessionID)
      for (const part of output.parts) if (part.type === "text") part.text = loopPrompt(goal)
    },
    tool: createOrchestraTools(orchestra, ledger, pluginStatus, {
      get snapshot() { return priceRefresher.snapshot },
      ...(pricingAliases.length ? { aliases: pricingAliases } : {}),
      ...(openRouter ? { openRouter } : {}),
    }, { client, agents, directory, coordinator }),
    // Always registered: the handler consults the live toggle so the dashboard
    // auto-accept switch takes effect without restarting opencode.
    "permission.ask": async (_input, output) => {
      loop.stop(_input.sessionID, "paused", "Permission request requires user attention")
      if (autoAcceptLive() && output.status !== "deny") output.status = "allow"
    },
    dispose: async () => {
      loop.dispose()
      loopInputs.clear()
      loopIdle.clear()
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
      planReleaseNotices.clear()
      mcpCalls.clear()
      completedMcpCalls.clear()
      pendingMcpFailures.clear()
      coordinator.dispose()
      nativeLeases.clear()
      sessionAgent.clear()
      sessionModel.clear()
      streamObservers.clear()
      flaggedParts.clear()
    },
    "chat.message": async ({ sessionID, agent, model }, output) => {
      if (!sessionID) return
      if (loopInputs.delete(sessionID)) loop.bind(sessionID, output.message.id)
      else loop.stop(sessionID, "cancelled", "New user message interrupted the loop")
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
    // OpenCode's built-in plan agent persists a read-only system-reminder into
    // the conversation and only counter-injects the plan→build transition for
    // the built-in "build" agent. Without this, orch-lead inherits the stale
    // "Plan mode ACTIVE" constraint after a Plan→orch-lead switch and refuses
    // to implement. Mutating output.messages in place is the documented
    // contract for this hook; OpenCode converts the mutated array to model
    // messages immediately after the hook returns.
    "experimental.chat.messages.transform": async (_input, output) => {
      if (!releasePlanMode(output.messages as ReminderMessage[])) return
      const sessionID = output.messages.findLast((message) => message.info.role === "user")?.info.sessionID
      if (sessionID && !planReleaseNotices.has(sessionID)) {
        planReleaseNotices.add(sessionID)
        await client.app.log({
          body: {
            service: "opencode-orchestra",
            level: "info",
            message: "Orchestra released stale plan-mode state for orch-lead",
            extra: { sessionID },
          },
        }).catch(() => undefined)
      }
    },
    "tool.execute.before": async ({ tool, sessionID, callID }, output) => {
      if (tool === "question") loop.stop(sessionID, "paused", "Question requires user attention")
      if (tool === "task" && (output?.args?.subagent_type?.startsWith("orch-") || sessionAgent.get(sessionID)?.startsWith("orch-") || coordinator.snapshot(sessionID))) {
        const args = output?.args
        const node = typeof args?.description === "string" ? coordinator.sealedNode(sessionID, args.description) : undefined
        if (coordinator.sessionContext(sessionID) || !node || !["orch-editor", "orch-integrator"].includes(node.agent)
          || args?.subagent_type !== node.agent || args?.task_id) {
          throw new Error("Orchestra native task requires a sealed editor/integrator nodeId as description, the assigned subagent_type, and a fresh task. Use orchestra_dispatch for evidence.")
        }
        const result = await coordinator.acquire({ parentSessionID: sessionID, nodeId: node.id, agent: node.agent, task: node.contract.objective, contract: node.contract })
        if (!result.ok) throw new Error(result.error)
        nativeLeases.set(callID, result.lease)
        args.prompt = `Sealed TaskContract (do not widen):\n${JSON.stringify(node.contract)}\nValidated editor commits: ${JSON.stringify(coordinator.validatedCommits(sessionID))}\n\n${args.prompt ?? ""}`
        if (node.agent === "orch-integrator") args.prompt += "\nUse one git cherry-pick invocation for the complete ordered commit list. On conflict run git cherry-pick --abort and report any rollback failure. Never cherry-pick commits in separate transactions."
      }
      const server = mcpServerForTool(tool)
      if (!server) return
      const failureKey = `${sessionID}:${tool}`
      mcpCalls.set(callID, { sessionID, tool, server, startedAt: Date.now(), retry: pendingMcpFailures.has(failureKey) })
    },
    "tool.execute.after": async ({ callID }, output) => {
      const lease = nativeLeases.get(callID)
      if (lease) {
        coordinator.complete(lease, true)
        nativeLeases.delete(callID)
      }
      await recordMcpCompletion(callID, true, output.output.length)
    },
    event: async ({ event }) => {
      const eventRecord = event as unknown as { type?: string; properties?: { sessionID?: string; error?: unknown } }
      if (eventRecord.type === "session.error" || eventRecord.type === "session.idle") {
        const sessionID = eventRecord.properties?.sessionID
        if (sessionID && eventRecord.type === "session.idle" && loop.get(sessionID)) { loopIdle.add(sessionID); setTimeout(() => { void loop.tick(sessionID) }, 0) }
        if (sessionID && eventRecord.type === "session.error") { loopInputs.delete(sessionID); loop.stop(sessionID, "failed", "Session error or cancellation") }
        // The session can no longer be mid-generation: finalize any live rows
        // whose completing message.updated never arrived (abort / pre-token
        // error), or they linger as phantom agents on the live panel.
        if (sessionID) live.dropSession(sessionID, eventRecord.type.replace("session.", "session-"))
        if (sessionID && !loop.get(sessionID) && !recoveryNotices.has(`${sessionID}:${eventRecord.type}`)) {
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
        if (part.type === "tool" && part.state.status === "error") {
          const lease = nativeLeases.get(part.callID)
          if (lease) {
            coordinator.complete(lease, false, "Native worker task failed.")
            nativeLeases.delete(part.callID)
          }
          await recordMcpCompletion(part.callID, false, 0, part.state.time)
        }
        const delta = event.properties.delta ?? ""
        // Remember the part type: reasoning deltas arrive through the channel
        // below with field "text" and can only be split off via this record.
        livePartKinds.set(part.id, part.type)
        pruneLiveAccumulators()
        // Assistant messages announce themselves via assistant-only part kinds
        // (step-start begins every LLM step; reasoning/tool parts never appear
        // in user messages). LiveStream.start() is idempotent per key, so this
        // fills `active` even when text deltas don't arrive (tool/non-streaming).
        if (
          !finishedLiveMessages.has(part.messageID)
          && (part.type === "step-start" || part.type === "reasoning" || part.type === "tool")
        ) {
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
      if (info.time.completed !== undefined && info.finish === "stop" && !info.error && loop.get(info.sessionID)?.status === "running") {
        // Read the finalized assistant message, never user/telemetry text.
        const parentID = info.parentID
        const state = loop.get(info.sessionID)
        void client.session.message({ path: { id: info.sessionID, messageID: info.id }, query: { directory }, throwOnError: true }).then((result) => {
          if (loop.get(info.sessionID) !== state || state?.status !== "running" || result.data?.info.role !== "assistant") return
          const text = result.data.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n")
          loop.reply(info.sessionID, parentID, info.id, text)
          // Submission is deferred beyond the completing event callback.
          if (loopIdle.has(info.sessionID)) setTimeout(() => { void loop.tick(info.sessionID) }, 0)
        }).catch(() => { if (loop.get(info.sessionID) === state) loop.stop(info.sessionID, "failed", "Unable to read finalized assistant reply") })
      }
      // If a turn emits no assistant-only part (e.g. some non-streaming path),
      // start the live row from the still-running assistant message instead.
      const finished =
        info.time.completed !== undefined || info.finish !== undefined || info.error !== undefined
      if (!finished) {
        if (finishedLiveMessages.has(info.id)) return
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
      const finishedModel = sessionModel.get(info.sessionID)
      const priced = calcCost(
        resolveModelPricing(finishedModel?.providerID, finishedModel?.modelID),
        { input: info.tokens.input, output: info.tokens.output, reasoning: info.tokens.reasoning },
      )
      const providerCost = Math.max(0, info.cost ?? 0)
      live.finish({
        key: info.id,
        sessionID: info.sessionID,
        agent: sessionAgent.get(info.sessionID),
        cost: priced.cost != null && providerCost === 0 ? priced.cost : providerCost,
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
      const ledgerSessionID = coordinator.rootSessionID(info.sessionID)
      await ledger.recordAssistant({ ...info, sessionID: ledgerSessionID })
      if (storeTextsFlag) {
        const prompt = promptBuffers.get(info.sessionID)
        const reply = replyBuffers.get(info.id)
        promptBuffers.delete(info.sessionID)
        replyBuffers.delete(info.id)
        if (prompt !== undefined || reply !== undefined) {
          const text: { prompt?: string; reply?: string } = {}
          if (prompt !== undefined) text.prompt = prompt
          if (reply !== undefined) text.reply = reply
          await ledger.recordText(ledgerSessionID, info.id, text)
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
