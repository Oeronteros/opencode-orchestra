import type { OrchestraConfig } from "../config/schema.js"
import { PROFILE_CATALOG } from "../profiles/catalog.js"
import { leadResolveRequest, resolveModel } from "../routing/model-resolver.js"
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
    ...leadResolveRequest(config.budget),
  })
  const superpowersGuide = config.superpowers.compatibility
    ? "\n\nSuperpowers workflow: invoke the matching skill before any response or action, using the native skill tool. For new functionality use brainstorming before implementation; for bugs use systematic-debugging; for features and bug fixes use test-driven-development; before claiming completion use verification-before-completion. Follow the loaded skill exactly and do not replace it with this orchestration protocol."
    : ""

  return {
    description: "Primary implementation lead that classifies complex work, dispatches a small specialist team, synthesizes evidence, edits files, and verifies the result.",
    mode: "primary",
    prompt: `${basePrompt.trim()}${superpowersGuide}\n\nExecution protocol: build a dependency DAG; dispatch every currently-ready node concurrently up to the runtime limit; wait for dependencies before releasing downstream nodes; after all evidence nodes finish, call orch-merge exactly once with every result labeled by node id and worker. If implementation needs parallel editors, call orchestration_prepare_edit_plan with explicit non-overlapping partitions, then call orchestration_validate_commit for every editor commit before orch-integrator. For editor partitions, resolve one base HEAD SHA, reject overlapping ownership, create one experimental git worktree per editor, dispatch orch-editor nodes only in those worktrees, validate actual git diff and ancestry before calling orch-integrator exactly once, and retain worktrees on failure. Never let parallel editors share a checkout.\n\nEnabled profiles:\n${profileGuide}\n\nRuntime limits: dispatch at most ${config.orchestration.maxWorkers} workers total and at most ${config.orchestration.parallelWorkers} concurrently. Budget mode: ${config.budget}.${config.budget === "ebobo" ? " EBOBO MODE: dispatch the full available specialist roster in parallel, require independent evidence, and always use orch-judge for frontier arbitration." : ""}`,
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
      // Autonomous coordination loop: allow without per-step confirmation.
      // Destructive shell patterns (rm -rf, git reset --hard, git push --force,
      // git clean -f, mkfs, dd, output truncation bypass) cannot be expressed as
      // granular deny rules here — RuntimeAgentConfig allows only
      // allow|ask|deny per tool — so they are enforced via system prompts
      // (prompts/lead.md §§2–3) instead of an engine-level deny list.
      bash: "allow",
      "context7_*": "allow",
      "codebase-memory_*": "allow",
      "codebase_memory_*": "allow",
      "codebase-memory-mcp_*": "allow",
      "memorygraph_*": "allow",
      "git_*": "allow",
      "ast-grep_*": "allow",
      "ast_grep_*": "allow",
      ...(config.superpowers.compatibility ? { skill: "allow" as const } : {}),
      task: {
        "*": "deny",
        ...workerPermissions,
        "orch-editor": "allow",
        "orch-integrator": "allow",
        "orch-merge": "allow",
        "orch-judge": "allow",
      },
      external_directory: "ask",
    },
    ...(resolved ? { model: resolved.id } : {}),
  }
}
