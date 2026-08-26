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

function pruneOldest(map: Map<string, string>): void {
  while (map.size > MAX_TEXT_BUFFERS) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
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
      if (event.type === "message.part.updated") {
        const part = event.properties.part
        const delta = event.properties.delta ?? ""
        trackStreamDelta(part.sessionID, part, delta)
        if (delta) {
          const model = sessionModel.get(part.sessionID)
          const liveText = appendLiveText(part.messageID, delta)
          live.delta({
            key: part.messageID,
            sessionID: part.sessionID,
            agent: sessionAgent.get(part.sessionID),
            text: liveText.text,
            chars: liveText.chars,
            provider: model?.providerID,
            model: model?.modelID,
          })
        }
        return
      }
      if (event.type !== "message.updated") return
      const info = event.properties.info
      if (info.role !== "assistant") return
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
