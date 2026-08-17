import type { OrchestraConfig } from "../config/schema.js"
import { resolveModel } from "../routing/model-resolver.js"
import type { RuntimeAgentConfig } from "./types.js"

export function createJudgeAgent(config: OrchestraConfig, prompt: string): RuntimeAgentConfig {
  const resolved = resolveModel({
    pool: config.models.judge,
    capability: "review",
    budget: config.budget,
    allowPaid: config.orchestration.premiumEscalation,
    preferredTiers: ["frontier"],
  })

  return {
    description: "Hidden frontier-model arbiter for critical or genuinely unresolved worker disagreement.",
    mode: "subagent",
    prompt: prompt.trim(),
    hidden: true,
    temperature: 0.1,
    permission: {
      "*": "deny",
      read: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      lsp: "allow",
      task: "deny",
      external_directory: "ask",
    },
    ...(resolved ? { model: resolved.id } : {}),
  }
}
