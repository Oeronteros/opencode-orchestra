import type { OrchestraConfig } from "../config/schema.js"
import { PROFILE_CATALOG } from "../profiles/catalog.js"
import { leadResolveRequest, resolveModel } from "../routing/model-resolver.js"
import { leadGitPermissions, safeBashPermissions, type RuntimeAgentConfig } from "./types.js"

export function createLeadAgent(config: OrchestraConfig, basePrompt: string): RuntimeAgentConfig {
  const enabled = Object.values(PROFILE_CATALOG).filter(
    (profile) => config.orchestration.profiles[profile.name] !== false,
  )
  const profileGuide = enabled
    .map((profile) => `- ${profile.name}: ${profile.purpose} Preferred workers: ${profile.workers.join(", ")}.`)
    .join("\n")
  const workerPermissions = Object.fromEntries(
    Array.from(new Set(enabled.flatMap((profile) => profile.workers))).map((worker) => [worker, "deny"] as const),
  )
  const resolved = resolveModel({
    pool: config.models.lead,
    capability: "reasoning",
    ...leadResolveRequest(config.budget),
  })
  basePrompt += "\nNative editor/integrator task calls must use the exact sealed nodeId as description, the assigned subagent_type, and no task_id. The runtime reserves these calls against the same tree budget and injects the sealed contract."
  const superpowersGuide = config.superpowers.compatibility
    ? "\n\nSuperpowers workflow: invoke the matching skill before any response or action, using the native skill tool. For new functionality use brainstorming before implementation; for bugs use systematic-debugging; for features and bug fixes use test-driven-development; before claiming completion use verification-before-completion. Follow the loaded skill exactly and do not replace it with this orchestration protocol."
    : ""

  return {
    description: "Primary implementation lead that classifies complex work, dispatches a small specialist team, synthesizes evidence, edits files, and verifies the result.",
    mode: "primary",
    prompt: `${basePrompt.trim()}${superpowersGuide}\n\nExecution protocol: build a dependency DAG and give every node a stable nodeId plus a complete sealed TaskContract containing its objective, required inputs and dependency results, allowed repository paths, exclusive mutable resources, expected deliverable, acceptance criteria, and whether one guarded child is allowed. Pass both nodeId and the full unchanged TaskContract to every dispatch. Dispatch every currently-ready evidence, review, merge, and judge node through orchestra_dispatch so model fallback, dependency state, ancestry, depth, and worker caps are enforced; never use native task for those nodes. Treat each child context as a snapshot: include all relevant decisions and constraints in its contract, and explicitly relay later changes through the parent-child handoff. Release downstream nodes only after every required dependency succeeds, and preserve each result's node provenance, decisions, assumptions, and blockers. Nested delegation is allowed only when the sealed contract permits it, at most one child per evidence worker, never to itself or an ancestor, and no deeper than ${config.orchestration.maxDelegationDepth}. After all evidence nodes finish, invoke orch-merge exactly once with every result labeled by nodeId and worker. If implementation needs parallel editors, use the native workspace-aware task path: call orchestration_prepare_edit_plan with explicit non-overlapping partitions and exclusive mutable resources, then call orchestration_validate_commit for every editor commit before orch-integrator. For editor partitions, resolve one base HEAD SHA, reject overlapping ownership, create one experimental git worktree per editor, dispatch orch-editor nodes only in those worktrees, validate actual git diff and ancestry before calling orch-integrator exactly once, and retain worktrees on failure. Never let parallel editors share a checkout or let two active nodes own the same mutable external resource. After integration, run the aggregate verification required by the TaskContract. Do not report completion, stage, or commit final integration unless that verification gate passes; on failure report the failed command and leave the run failed or blocked.\n\nEnabled profiles:\n${profileGuide}\n\nRuntime limits: dispatch at most ${config.orchestration.maxWorkers} unique worker nodes total across root and nested work and at most ${config.orchestration.parallelWorkers} concurrently. Budget mode changes model/cost policy, not these caps. Budget mode: ${config.budget}.${config.budget === "ebobo" ? " EBOBO MODE: use the strongest eligible models, require independent evidence, and use orch-judge for frontier arbitration without exceeding the configured worker caps." : ""}`,
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
      // Autonomous coordination with engine-enforced destructive-command denies.
      bash: safeBashPermissions(),
      "context7_*": "allow",
      "codebase-memory_*": "allow",
      "codebase_memory_*": "allow",
      "codebase-memory-mcp_*": "allow",
      "memorygraph_*": "allow",
      ...leadGitPermissions(),
      "ast-grep_*": "allow",
      "ast_grep_*": "allow",
      "playwright_*": "allow",
      orchestra_dispatch: "allow",
      ...(config.superpowers.compatibility ? { skill: "allow" as const } : {}),
      task: {
        "*": "deny",
        ...workerPermissions,
        "orch-editor": "allow",
        "orch-integrator": "allow",
        "orch-merge": "deny",
        "orch-judge": "deny",
      },
      external_directory: "ask",
    },
    ...(resolved ? { model: resolved.id } : {}),
  }
}
