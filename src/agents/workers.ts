import type { OrchestraConfig } from "../config/schema.js"
import { resolveModel } from "../routing/model-resolver.js"
import type { AgentSet, RuntimeAgentConfig } from "./types.js"

interface WorkerSpec {
  description: string
  prompt: string
  pool: keyof OrchestraConfig["models"]["worker"]
  capability: "code" | "reasoning" | "research" | "vision" | "image" | "security" | "review"
  permission: RuntimeAgentConfig["permission"]
}

const READ_ONLY: RuntimeAgentConfig["permission"] = {
  "*": "deny",
  read: "allow",
  glob: "allow",
  grep: "allow",
  list: "allow",
  lsp: "allow",
  "codebase-memory_*": "allow",
  "codebase_memory_*": "allow",
  "codebase-memory-mcp_*": "allow",
  task: "deny",
  external_directory: "ask",
}

const WORKERS: Record<string, WorkerSpec> = {
  "orch-repo": {
    description: "Internal read-only repository scout for focused codebase evidence, ownership, patterns, and change impact.",
    prompt: "Inspect the repository for the exact question. Start with Codebase Memory graph tools for structural discovery, then verify decisive claims against exact source. Return compact evidence with file paths, symbols, coverage, and uncertainties. Do not edit files or delegate.",
    pool: "code",
    capability: "code",
    permission: READ_ONLY,
  },
  "orch-docs": {
    description: "Internal official-documentation and dependency-source scout.",
    prompt: "Research official documentation and upstream source. Prefer primary sources, cite direct URLs, distinguish facts from inference, and do not edit or delegate.",
    pool: "research",
    capability: "research",
    permission: { ...READ_ONLY, webfetch: "allow", websearch: "allow", "context7_*": "allow" },
  },
  "orch-tests": {
    description: "Internal test scout that finds reproduction paths, coverage gaps, and safe verification commands.",
    prompt: "Inspect tests and reproduction paths. Use Codebase Memory to find impacted callers, callees, and test surfaces before targeted source checks. You may run read-only or test commands, but never edit. Return the smallest useful regression-test recommendation.",
    pool: "code",
    capability: "code",
    permission: {
      ...READ_ONLY,
      bash: "allow",
    },
  },
  "orch-research": {
    description: "Internal technical researcher for implementations, standards, and current ecosystem evidence.",
    prompt: "Find high-signal technical references. Prefer official docs, standards, and source code. Return evidence and decision implications; do not edit or delegate.",
    pool: "research",
    capability: "research",
    permission: { ...READ_ONLY, webfetch: "allow", websearch: "allow", "context7_*": "allow" },
  },
  "orch-critic": {
    description: "Internal independent critic that challenges conclusions and detects missing evidence or unsafe assumptions.",
    prompt: "Independently critique the proposed conclusion. Identify contradictions, missing evidence, hidden assumptions, and the strongest alternative. Do not edit or delegate.",
    pool: "reasoning",
    capability: "review",
    permission: READ_ONLY,
  },
  "orch-security": {
    description: "Internal security scout for concrete trust-boundary, authorization, secret, and data-handling risks.",
    prompt: "Perform a focused security analysis. Report only evidence-backed attack paths with impact, likelihood, and mitigation. Do not edit or delegate.",
    pool: "reasoning",
    capability: "security",
    permission: { ...READ_ONLY, webfetch: "allow", websearch: "allow" },
  },
  "orch-visual-reference": {
    description: "Internal visual-reference scout for UI patterns, layout, motion, and interaction examples.",
    prompt: "Collect relevant visual references and explain which concrete layout, hierarchy, motion, and interaction ideas transfer to this product. Do not edit or delegate.",
    pool: "vision",
    capability: "vision",
    permission: { ...READ_ONLY, webfetch: "allow", websearch: "allow" },
  },
  "orch-visual-generate": {
    description: "Internal visual generator for exploratory mockups when an image-generation tool is available.",
    prompt: "Generate only the requested exploratory visual asset. Preserve product constraints, label assumptions, and return the asset plus a short rationale. Do not delegate.",
    pool: "image",
    capability: "image",
    permission: { "*": "deny", "image*": "allow", task: "deny" },
  },
  "orch-visual-review": {
    description: "Internal vision reviewer for screenshots, mockups, hierarchy, accessibility, and visual regressions.",
    prompt: "Review the provided visual material against the task. Report observable issues, severity, and precise recommendations. Do not edit or delegate.",
    pool: "vision",
    capability: "vision",
    permission: READ_ONLY,
  },
}

export function createWorkerAgents(config: OrchestraConfig): AgentSet {
  return Object.fromEntries(
    Object.entries(WORKERS).map(([name, spec]) => {
      const resolved = resolveModel({
        pool: config.models.worker[spec.pool],
        capability: spec.capability,
        budget: config.budget,
        allowPaid: config.budget === "quality" || config.budget === "ebobo",
        preferredCosts: config.budget === "eco" || config.budget === "balanced" ? ["free"] : [],
        preferredTiers: config.budget === "ebobo"
          ? ["frontier", "lead"]
          : config.budget === "quality"
            ? ["lead", "frontier"]
            : ["worker"],
      })
      const agent: RuntimeAgentConfig = {
        description: spec.description,
        mode: "subagent",
        prompt: spec.prompt,
        hidden: !config.orchestration.exposeWorkers,
        temperature: 0.15,
        permission: spec.permission,
        ...(resolved ? { model: resolved.id } : {}),
      }
      return [name, agent]
    }),
  )
}

export type WorkerPoolKey = keyof OrchestraConfig["models"]["worker"]

/** Map a worker name to the capability pool it draws from (for cost estimates). */
export function workerPoolKey(worker: string): WorkerPoolKey {
  const spec = WORKERS[worker]
  return spec?.pool ?? "code"
}

/** Map a worker name to the capability used when resolving its model. */
export function workerCapability(worker: string): WorkerSpec["capability"] {
  const spec = WORKERS[worker]
  return spec?.capability ?? "code"
}
