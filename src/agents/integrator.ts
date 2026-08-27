import type { OrchestraConfig } from "../config/schema.js"
import { resolveModel } from "../routing/model-resolver.js"
import type { RuntimeAgentConfig } from "./types.js"

export function createIntegratorAgent(config: OrchestraConfig, prompt?: string): RuntimeAgentConfig {
  const resolved = resolveModel({ pool: config.models.lead, capability: "reasoning", budget: config.budget, allowPaid: config.budget === "quality" || config.budget === "ebobo", preferredTiers: ["lead", "frontier"] })
  return {
    description: "Deterministic integration worker that validates ownership and integrates isolated editor commits.",
    mode: "subagent", hidden: true, temperature: 0.1,
    prompt: prompt ?? "Integrate validated editor commits deterministically in sorted editor order. Before cherry-picking, derive actual changed paths from git and build a cross-editor conflict map listing per-editor changed paths, ownership violations, conflicting paths, and the sorted integration order. Fail closed on any ownership overlap, ownership violation, ancestry failure, or Git conflict; do not cherry-pick any commit until the map is clean. On any failure, stop and retain all worktrees for diagnosis. Integrate only the clean commits in deterministic order and never resolve a semantic or ownership conflict autonomously. Run aggregate verification and report commits, files, tests, and retained worktrees. Do not delegate.",
    permission: { "*": "deny", read: "allow", edit: "deny", glob: "allow", grep: "allow", list: "allow", lsp: "allow", bash: "allow", task: "deny", external_directory: "deny" },
    ...(resolved ? { model: resolved.id } : {}),
  }
}
