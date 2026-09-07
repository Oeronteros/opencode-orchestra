import type { OrchestraConfig } from "../config/schema.js"
import { workerCapability, workerPoolKey } from "../agents/workers.js"
import { buildFallbackChain } from "./fallback.js"
import { leadResolveRequest } from "./model-resolver.js"

function automaticModels(config: OrchestraConfig, agent: string): string[] {
  const budget = config.budget
  const standardPaid = budget === "quality" || budget === "ebobo"

  if (agent === "orch-lead") {
    const request = leadResolveRequest(budget)
    return buildFallbackChain(config.models.lead, "reasoning", budget, request.allowPaid, {
      ...(request.preferredCosts ? { preferredCosts: request.preferredCosts } : {}),
      ...(request.preferredTiers ? { preferredTiers: request.preferredTiers } : {}),
    })?.all.map((entry) => entry.id) ?? []
  }
  if (agent === "orch-judge") {
    return buildFallbackChain(config.models.judge, "review", budget, config.orchestration.premiumEscalation, {
      preferredTiers: ["frontier"],
    })?.all.map((entry) => entry.id) ?? []
  }
  if (agent === "orch-integrator") {
    return buildFallbackChain(config.models.lead, "reasoning", budget, standardPaid, {
      preferredTiers: ["lead", "frontier"],
    })?.all.map((entry) => entry.id) ?? []
  }
  if (agent === "orch-merge") {
    return buildFallbackChain(config.models.lead, "reasoning", budget, standardPaid, {
      preferredCosts: budget === "balanced" ? ["subscription"] : budget === "eco" ? ["free"] : [],
      preferredTiers: ["lead", "frontier"],
    })?.all.map((entry) => entry.id) ?? []
  }

  const poolKey = agent === "orch-editor" ? "code" : workerPoolKey(agent)
  const capability = agent === "orch-editor" ? "code" : workerCapability(agent)
  return buildFallbackChain(config.models.worker[poolKey], capability, budget, standardPaid, {
    preferredCosts: budget === "eco" || budget === "balanced" ? ["free"] : [],
    preferredTiers: agent === "orch-editor"
      ? ["worker", "lead", "frontier"]
      : budget === "ebobo"
        ? ["frontier", "lead"]
        : budget === "quality"
          ? ["lead", "frontier"]
          : ["worker"],
  })?.all.map((entry) => entry.id) ?? []
}

/** Resolve one agent's effective primary + fallback order without duplicates. */
export function fallbackModelsForAgent(config: OrchestraConfig, agent: string, assignedModel?: string): string[] {
  const automatic = automaticModels(config, agent)
  const primary = assignedModel ?? config.models.agents[agent] ?? automatic[0]
  if (!primary) return []
  if (!config.models.fallback.enabled) return [primary]

  const explicit = config.models.fallback.agents[agent] ?? []
  const alternatives = explicit.length > 0 ? explicit : automatic
  const ordered = [...new Set([primary, ...alternatives])]
  return ordered.slice(0, config.models.fallback.maxRetries + 1)
}

export function supportsFallbackDispatch(agent: string): boolean {
  return agent.startsWith("orch-") && agent !== "orch-lead" && !["orch-editor", "orch-integrator"].includes(agent)
}
