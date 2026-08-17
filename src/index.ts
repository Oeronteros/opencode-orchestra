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
  const ledger = new Ledger(directory, orchestra.telemetry.directory, orchestra.telemetry.enabled, pools)
  const systemHint = primarySystemHint(orchestra)

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
      mutable.command.orchestra ??= {
        description: "Classify a task and delegate it to orch-lead",
        template: "Call orchestra_route for this task: $ARGUMENTS. Then delegate the full task once to orch-lead using the returned profile and constraints.",
      }
    },
    tool: createOrchestraTools(orchestra, ledger),
    event: async ({ event }) => {
      if (event.type !== "message.updated") return
      const info = event.properties.info
      if (info.role !== "assistant") return
      await ledger.recordAssistant(info)
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
