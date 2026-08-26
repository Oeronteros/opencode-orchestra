import type { OrchestraConfig } from "../config/schema.js"
import { resolveModel } from "../routing/model-resolver.js"
import type { RuntimeAgentConfig } from "./types.js"

export function createIntegratorAgent(config: OrchestraConfig): RuntimeAgentConfig {
  const resolved = resolveModel({ pool: config.models.lead, capability: "reasoning", budget: config.budget, allowPaid: config.budget === "quality" || config.budget === "ebobo", preferredTiers: ["lead", "frontier"] })
  return {
    description: "Deterministic integration worker that validates ownership and integrates isolated editor commits.",
    mode: "subagent", hidden: true, temperature: 0.1,
    prompt: "Integrate validated editor commits in plan-node order. Before cherry-picking, derive changed paths from git and fail closed if any path is unowned, multiply owned, or outside its editor partition. Stop on conflicts; never resolve an ownership conflict autonomously. Run aggregate verification and report commits, files, tests, and retained worktrees. Do not delegate.",
    permission: { "*": "deny", read: "allow", edit: "deny", glob: "allow", grep: "allow", list: "allow", lsp: "allow", bash: "allow", task: "deny", external_directory: "deny" },
    ...(resolved ? { model: resolved.id } : {}),
  }
}
