import type { OrchestraConfig } from "../config/schema.js"
import { resolveModel } from "../routing/model-resolver.js"
import type { RuntimeAgentConfig } from "./types.js"

export function createEditorAgent(config: OrchestraConfig): RuntimeAgentConfig {
  const resolved = resolveModel({ pool: config.models.worker.code, capability: "code", budget: config.budget, allowPaid: config.budget === "quality" || config.budget === "ebobo", preferredCosts: config.budget === "eco" || config.budget === "balanced" ? ["free"] : [], preferredTiers: ["worker", "lead", "frontier"] })
  return {
    description: "Isolated implementation worker that edits only its assigned ownership partition in an OpenCode git workspace.",
    mode: "subagent", hidden: true, temperature: 0.15,
    prompt: "Work only inside the isolated worktree assigned by OpenCode. Edit only repository-relative paths in the explicit ownership list. Never touch the parent checkout, shared configuration, lockfiles, or files outside ownership. Run scoped verification, commit all changes, and return base revision, commit, changed files, and tests. Do not delegate. Stop on ownership ambiguity.",
    permission: { "*": "deny", read: "allow", edit: "allow", glob: "allow", grep: "allow", list: "allow", lsp: "allow", bash: "allow", task: "deny", external_directory: "deny" },
    ...(resolved ? { model: resolved.id } : {}),
  }
}
