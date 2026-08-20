import type { OrchestraConfig } from "../config/schema.js"
import { PROFILE_CATALOG } from "../profiles/catalog.js"
import { resolveModel } from "../routing/model-resolver.js"
import type { RuntimeAgentConfig } from "./types.js"

export function createLeadAgent(config: OrchestraConfig, basePrompt: string): RuntimeAgentConfig {
  const enabled = Object.values(PROFILE_CATALOG).filter(
    (profile) => config.orchestration.profiles[profile.name] !== false,
  )
  const profileGuide = enabled
    .map((profile) => `- ${profile.name}: ${profile.purpose} Preferred workers: ${profile.workers.join(", ")}.`)
    .join("\n")
  const workerPermissions = Object.fromEntries(
    Array.from(new Set(enabled.flatMap((profile) => profile.workers))).map((worker) => [worker, "allow"] as const),
  )
  const resolved = resolveModel({
    pool: config.models.lead,
    capability: "reasoning",
    budget: config.budget,
    allowPaid: config.budget === "quality" || config.budget === "ebobo",
    preferredCosts: config.budget === "balanced"
      ? ["subscription"]
      : config.budget === "eco"
        ? ["free"]
        : [],
    preferredTiers: config.budget === "balanced"
      ? ["lead"]
      : config.budget === "quality" || config.budget === "ebobo"
        ? ["frontier", "lead"]
        : [],
  })

  return {
    description: "Primary implementation lead that classifies complex work, dispatches a small specialist team, synthesizes evidence, edits files, and verifies the result.",
    mode: "primary",
    prompt: `${basePrompt.trim()}\n\nExecution protocol: build a dependency DAG; dispatch every currently-ready node concurrently up to the runtime limit; wait for dependencies before releasing downstream nodes; after all evidence nodes finish, call orch-merge exactly once with every result labeled by node id and worker.\n\nEnabled profiles:\n${profileGuide}\n\nRuntime limits: dispatch at most ${config.orchestration.maxWorkers} workers total and at most ${config.orchestration.parallelWorkers} concurrently. Budget mode: ${config.budget}.${config.budget === "ebobo" ? " EBOBO MODE: dispatch the full available specialist roster in parallel, require independent evidence, and always use orch-judge for frontier arbitration." : ""}`,
    hidden: false,
    temperature: 0.2,
    color: "accent",
    permission: {
      "*": "deny",
      read: "allow",
      edit: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      lsp: "allow",
      bash: "ask",
      "context7_*": "allow",
      "codebase-memory_*": "allow",
      "codebase_memory_*": "allow",
      "codebase-memory-mcp_*": "allow",
      "memorygraph_*": "allow",
      task: {
        "*": "deny",
        ...workerPermissions,
        "orch-merge": "allow",
        "orch-judge": "allow",
      },
      external_directory: "ask",
    },
    ...(resolved ? { model: resolved.id } : {}),
  }
}
