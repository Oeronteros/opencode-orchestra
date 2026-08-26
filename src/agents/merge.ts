import type { OrchestraConfig } from "../config/schema.js"
import { resolveModel } from "../routing/model-resolver.js"
import type { RuntimeAgentConfig } from "./types.js"

/** Final reduce stage: combines completed DAG branches without delegating further. */
export function createMergeAgent(config: OrchestraConfig, prompt?: string): RuntimeAgentConfig {
  const resolved = resolveModel({
    pool: config.models.lead,
    capability: "reasoning",
    budget: config.budget,
    allowPaid: config.budget === "quality" || config.budget === "ebobo",
    preferredCosts: config.budget === "balanced" ? ["subscription"] : config.budget === "eco" ? ["free"] : [],
    preferredTiers: ["lead", "frontier"],
  })
  return {
    description: "Hidden reduce-stage agent that merges completed specialist branches into one traceable result.",
    mode: "subagent",
    prompt: prompt ?? "Merge the supplied specialist outputs only. Preserve file/URL evidence and provenance, deduplicate compatible findings, expose contradictions and uncertainty, and produce one actionable handoff. Do not add unsupported claims, edit files, or delegate.",
    hidden: true,
    temperature: 0.1,
    permission: { "*": "deny", read: "allow", glob: "allow", grep: "allow", list: "allow", lsp: "allow", task: "deny", external_directory: "ask" },
    ...(resolved ? { model: resolved.id } : {}),
  }
}
