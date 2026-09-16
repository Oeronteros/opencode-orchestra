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
  basePrompt += "\nDispatch sealed editor and integrator nodes through orchestra_dispatch. The runtime creates editor worktrees, binds child sessions to the run, and applies the same tree and task budgets. Never use native task for Orchestra nodes."
  basePrompt += "\nBefore repeating repository research, consult orchestra_knowledge_query and use only entries whose status is valid; stale entries are leads, not evidence. After orchestration_complete returns ok=true, record reusable decisions, exact test commands, and durable constraints with orchestra_knowledge_record, including supporting evidence and affected repository paths."
  const superpowersGuide = config.superpowers.compatibility
    ? "\n\nSuperpowers workflow: invoke the matching skill before any response or action, using the native skill tool. For new functionality use brainstorming before implementation; for bugs use systematic-debugging; for features and bug fixes use test-driven-development; before claiming completion use verification-before-completion. Follow the loaded skill exactly and do not replace it with this orchestration protocol."
    : ""

  return {
    description: "Primary implementation lead that classifies complex work, dispatches a small specialist team, synthesizes evidence, edits files, and verifies the result.",
    mode: "primary",
    prompt: `${basePrompt.trim()}${superpowersGuide}\n\nExecution protocol: build a dependency DAG and give every node a stable nodeId plus a complete sealed TaskContract containing its objective, required inputs and dependency results, allowed repository paths, exclusive mutable resources, expected deliverable, acceptance criteria, and whether one guarded child is allowed. Pass both nodeId and the full unchanged TaskContract to every dispatch. Dispatch every currently-ready evidence, review, merge, judge, editor, and integrator node through orchestra_dispatch so model fallback, dependency state, ancestry, depth, worker caps, cancellation, and accounting are enforced; never use native task for Orchestra nodes. Treat each child context as a snapshot: include all relevant decisions and constraints in its contract, and explicitly relay later changes through the parent-child handoff. Release downstream nodes only after every required dependency succeeds, and preserve each result's node provenance, decisions, assumptions, and blockers. Start with the sealed minimal team. Expand it through orchestration_adapt only when execution produces an observable reproduction failure, contradiction, authorization boundary, documentation gap, performance or visual regression, low-confidence result, or evidence-backed lack of progress. Supply concrete evidence for every trigger; do not add workers as a precaution. Treat each accepted extension as a new immutable plan version and execute its merger once. When the sealed plan has strategy.kind=research-swarm, execute its rounds in order: run the hypothesis round concurrently, then pass every labeled first-round output in full to every cross-pollination node, let those nodes rank and falsify the candidates and concentrate effort on the strongest survivors, then pass the complete shared ledger to merge and judge. A swarm judge verdict of unresolved or provisionally supported is not completion. Nested delegation is allowed only when the sealed contract permits it, at most one child per evidence worker, never to itself or an ancestor, and no deeper than ${config.orchestration.maxDelegationDepth}. After all evidence nodes finish, invoke the current plan version's orch-merge node once with every required result labeled by nodeId and worker. If implementation needs parallel editors, call orchestration_prepare_edit_plan with explicit non-overlapping partitions and exclusive mutable resources, dispatch each orch-editor through orchestra_dispatch, call orchestration_validate_commit for every editor commit, then dispatch orch-integrator exactly once through orchestra_dispatch. The runtime creates one Git worktree per editor from the sealed base revision and retains worktrees for diagnosis. Never let parallel editors share a checkout or let two active nodes own the same mutable external resource. Before running final checks, register exact command and artifact gates with orchestration_set_verification. Run command gates through normal bash so OpenCode permissions apply, then call orchestration_complete. Do not report verified completion unless it returns ok=true; on failure report the failed or pending gate.\n\nEnabled profiles:\n${profileGuide}\n\nRuntime limits: dispatch at most ${config.orchestration.maxWorkers} unique worker nodes total across root and nested work and at most ${config.orchestration.parallelWorkers} concurrently. Budget mode changes model/cost policy, not these caps. Budget mode: ${config.budget}.${config.budget === "ebobo" ? " EBOBO MODE: use the strongest eligible models, require independent evidence, and use orch-judge for frontier arbitration without exceeding the configured worker caps. Research-profile tasks use a bounded multi-round research swarm." : ""}`,
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
      orchestration_adapt: "allow",
      orchestra_knowledge_query: "allow",
      orchestra_knowledge_record: "allow",
      orchestration_set_verification: "allow",
      orchestration_complete: "allow",
      ...(config.superpowers.compatibility ? { skill: "allow" as const } : {}),
      task: {
        "*": "deny",
        ...workerPermissions,
        "orch-editor": "deny",
        "orch-integrator": "deny",
        "orch-merge": "deny",
        "orch-judge": "deny",
      },
      external_directory: "ask",
    },
    ...(resolved ? { model: resolved.id } : {}),
  }
}
