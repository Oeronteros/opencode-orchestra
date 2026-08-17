import type { Config, Plugin } from "@opencode-ai/plugin"
import { createAgentSet } from "./agents/build.js"
import type { RuntimeAgentConfig } from "./agents/types.js"
import { loadConfig } from "./config/load.js"
import { applyBudgetPreset } from "./config/defaults.js"
import type { ModelCandidateInput } from "./config/schema.js"
import { loadPrompts } from "./prompts/load.js"
import { applyDiscoveredModels, discoverConnectedModels } from "./routing/model-discovery.js"
import { primarySystemHint } from "./superpowers/compatibility.js"
import { Ledger } from "./telemetry/ledger.js"
import { createOrchestraTools } from "./tools.js"
import { createStreamObserver, type StreamObserver } from "./routing/observer.js"
import { createPriceRefresher, type RefreshSource } from "./routing/pricing/refresh.js"
import { detectMcpPresence, resolvePluginVersion, PACKAGE_NAME, type PluginStatus } from "./plugin-status.js"

type MutableConfig = Omit<Config, "agent" | "command"> & {
  agent?: Record<string, RuntimeAgentConfig>
  command?: Record<string, { template: string; description?: string }>
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

function pruneOldest(map: Map<string, string>): void {
  while (map.size > MAX_TEXT_BUFFERS) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
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

export const OrchestraPlugin: Plugin = async ({ client, directory }, rawOptions = {}) => {
  const loaded = await loadConfig(directory, rawOptions)
  const discovered = await discoverConnectedModels(client)
  const orchestra = applyDiscoveredModels(applyBudgetPreset(loaded.config), discovered)
  const prompts = await loadPrompts()
  const agents = createAgentSet(orchestra, prompts)
  const pools: ModelCandidateInput[][] = [
    orchestra.models.lead,
    ...Object.values(orchestra.models.worker),
    orchestra.models.judge,
  ]
  const ledger = new Ledger(directory, orchestra.telemetry.directory, orchestra.telemetry.enabled, pools, orchestra.telemetry.storeTexts)
  storeTextsFlag = orchestra.telemetry.storeTexts
  const refreshSource: RefreshSource | undefined = orchestra.pricing.endpoint
    ? { endpoint: orchestra.pricing.endpoint, refreshIntervalHours: orchestra.pricing.refreshIntervalHours }
    : undefined
  const priceRefresher = createPriceRefresher(undefined, refreshSource)
  priceRefresher.start()
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
        mutable.agent[name] = mergeAgent(agent, mutable.agent[name])
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
        description: "Classify a task and delegate it to orch-lead",
        template: "Call orchestra_route for this task: $ARGUMENTS. Then delegate the full task once to orch-lead using the returned profile and constraints.",
      }
    },
    tool: createOrchestraTools(orchestra, ledger, pluginStatus, {
      get snapshot() { return priceRefresher.snapshot },
    }),
    dispose: async () => {
      priceRefresher.stop()
      promptBuffers.clear()
      replyBuffers.clear()
      streamObservers.clear()
      flaggedParts.clear()
    },
    "chat.message": async ({ sessionID }, output) => {
      if (!storeTextsFlag || !sessionID) return
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
    event: async ({ event }) => {
      if (event.type === "message.part.updated") {
        const part = event.properties.part
        trackStreamDelta(part.sessionID, part, event.properties.delta ?? "")
        return
      }
      if (event.type !== "message.updated") return
      const info = event.properties.info
      if (info.role !== "assistant") return
      endStream(info.id)
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
export default OrchestraPlugin
