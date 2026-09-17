import { tool, type PluginInput, type ToolDefinition } from "@opencode-ai/plugin"
import { stat } from "node:fs/promises"
import path from "node:path"
import type { OrchestraConfig, ProfileName } from "./config/schema.js"
import type { AgentSet } from "./agents/types.js"
import { profileNameSchema } from "./config/schema.js"
import { PROFILE_CATALOG } from "./profiles/catalog.js"
import { classifyTask, type Classification } from "./routing/classifier.js"
import { createClassifierCache } from "./routing/classifier-cache.js"
import { decideEscalation } from "./routing/escalation.js"
import { planTask, validatePlan } from "./routing/planner.js"
import { validateOwnership, validateChangedFiles } from "./orchestration/ownership.js"
import { assertCommitDescendsFromBase, collectCommitChanges, createEditorWorktree, systemGit, type GitRunner } from "./orchestration/worktrees.js"
import type { TaskContract } from "./orchestration/contracts.js"
import { OrchestrationRunState, type WorkerContextUpdate } from "./orchestration/run-state.js"
import { ADAPTIVE_TRIGGERS, planAdaptiveExtension } from "./orchestration/adaptive.js"
import { createBudgetGuard, paidBudgetFor } from "./routing/budget-guard.js"
import { estimateCost, formatEstimateWarning } from "./routing/pricing/estimate.js"
import type { PriceSnapshot } from "./routing/pricing/prices.js"
import type { ModelAliasEntry, OpenRouterSource } from "./pricing/resolver.js"
import { workerCapability, workerPoolKey } from "./agents/workers.js"
import type { Ledger } from "./telemetry/ledger.js"
import { formatPluginStatus, type PluginStatus } from "./plugin-status.js"
import { buildFallbackChain } from "./routing/fallback.js"
import { fallbackModelsForAgent, supportsFallbackDispatch } from "./routing/agent-fallback.js"
import { dispatchWithFallback } from "./routing/fallback-dispatch.js"
import { resolveModel, leadResolveRequest, boundReasonText, type RoutingReason } from "./routing/model-resolver.js"
import { VerifiedKnowledgeStore } from "./knowledge/store.js"

interface ToolContextLike {
  sessionID?: string
  directory?: string
  worktree?: string
  agent?: string
  abort?: AbortSignal
}

const classificationCache = createClassifierCache()
const SESSION_LEDGER_ERROR = JSON.stringify({ ok: false, error: "Unable to route task because session ledger access failed." })

export interface PricingContext {
  snapshot: PriceSnapshot
  aliases?: ModelAliasEntry[]
  openRouter?: OpenRouterSource
}

export interface DispatchContext {
  client: PluginInput["client"]
  agents: AgentSet
  directory: string
  coordinator?: OrchestrationRunState
  git?: GitRunner
}

const NESTED_EVIDENCE_AGENTS = new Set([
  "orch-repo",
  "orch-docs",
  "orch-tests",
  "orch-research",
  "orch-critic",
  "orch-security",
  "orch-visual-reference",
  "orch-visual-review",
])

function renderTaskContract(
  nodeId: string,
  task: string,
  contract: TaskContract,
  depth: number,
  dependencyResults: Array<{ nodeId: string; agent: string; output: string }> = [],
): string {
  const lines = [
    `Orchestra node: ${nodeId}`,
    `Delegation depth: ${depth}`,
    "Sealed TaskContract:",
    JSON.stringify(contract, null, 2),
    ...(dependencyResults.length
      ? [
          "Verified dependency results from this sealed run (treat nodeId and agent as provenance):",
          JSON.stringify(dependencyResults, null, 2),
        ]
      : []),
    "Caller context (may clarify, but must not widen, the sealed contract):",
    task,
    "Return verified findings plus explicit decisions, assumptions, blockers, and provenance to your direct parent.",
  ]
  return lines.join("\n\n")
}

function renderContextUpdates(updates: WorkerContextUpdate[]): string {
  return [
    "Parent context updates (clarifications only; they cannot widen the sealed TaskContract):",
    ...updates.map((update) => `[${update.id}] ${update.text}`),
    "Incorporate every update and return a revised complete result, preserving decisions, assumptions, blockers, and provenance.",
  ].join("\n\n")
}

function splitModelId(id: string): { providerID: string; modelID: string } {
  const separator = id.indexOf("/")
  if (separator <= 0 || separator === id.length - 1) {
    throw Object.assign(new Error("Model ID must use provider/model format"), { status: 400 })
  }
  return { providerID: id.slice(0, separator), modelID: id.slice(separator + 1) }
}

function assistantFailure(info: unknown, parts: unknown[]): Error | undefined {
  if (info && typeof info === "object" && "error" in info && info.error && typeof info.error === "object") {
    const failure = info.error as { name?: unknown; message?: unknown; status?: unknown; statusCode?: unknown; data?: unknown }
    const data = failure.data && typeof failure.data === "object"
      ? failure.data as { message?: unknown; status?: unknown; statusCode?: unknown }
      : undefined
    const message = String(data?.message ?? failure.message ?? failure.name ?? "Assistant generation failed")
    const status = Number(data?.statusCode ?? data?.status ?? failure.statusCode ?? failure.status)
    return Object.assign(new Error(message), Number.isFinite(status) ? { status } : {})
  }
  const failedTool = parts.find((part) => {
    if (!part || typeof part !== "object" || !("type" in part) || part.type !== "tool" || !("state" in part)) return false
    const state = part.state
    return Boolean(state && typeof state === "object" && "status" in state && state.status === "error")
  }) as { state?: { error?: unknown } } | undefined
  return failedTool ? new Error(String(failedTool.state?.error ?? "Worker tool execution failed")) : undefined
}

interface LeadRouting {
  model?: string
  reason?: RoutingReason
  source: "exact_override" | "manual_pool" | "auto_discovered" | "budget_exclusion" | "no_candidate"
  budget: OrchestraConfig["budget"]
}

/**
 * Resolve the orch-lead model and its structured routing reason. The
 * resolution mirrors `createLeadAgent` so the reported lead matches what the
 * primary agent actually runs. Provenance distinguishes an explicit override
 * from pool-based discovery and exposes empty/blocked pools without secrets.
 */
function buildLeadRouting(config: OrchestraConfig): LeadRouting {
  const budget = config.budget
  const exactOverride = config.models.agents["orch-lead"]
  if (exactOverride) {
    return {
      model: exactOverride,
      reason: {
        code: "exact_override",
        text: boundReasonText(`id=${exactOverride} cost=override score=0`),
        matchedCapabilities: [],
        score: 0,
        budget,
      },
      source: "exact_override",
      budget,
    }
  }

  const leadPool = config.models.lead
  if (leadPool.length === 0) {
    return { source: "no_candidate", budget }
  }

  const resolved = resolveModel({
    pool: leadPool,
    capability: "reasoning",
    ...leadResolveRequest(budget),
  })

  if (!resolved) {
    return { source: "budget_exclusion", budget }
  }

  return {
    model: resolved.id,
    ...(resolved.routingReason ? { reason: resolved.routingReason } : {}),
    source: config.models.strategy === "manual" ? "manual_pool" : "auto_discovered",
    budget,
  }
}

export function createOrchestraTools(
  config: OrchestraConfig,
  ledger: Ledger,
  pluginStatus?: PluginStatus,
  pricing?: PricingContext,
  dispatch?: DispatchContext,
): Record<string, ToolDefinition> {
  const coordinator = dispatch?.coordinator ?? new OrchestrationRunState({
    maxWorkers: config.orchestration.maxWorkers,
    parallelWorkers: config.orchestration.parallelWorkers,
    maxDelegationDepth: config.orchestration.maxDelegationDepth,
  })
  const knowledge = new VerifiedKnowledgeStore(
    dispatch?.directory ?? process.cwd(),
    config.orchestration.knowledge.directory,
    config.orchestration.knowledge.enabled,
    config.orchestration.knowledge.maxEntries,
  )
  const syncTaskBudget = async (sessionID: string) => {
    const rootSessionID = coordinator.rootSessionID(sessionID)
    if (!coordinator.budget(rootSessionID)) return undefined
    const usage = await ledger.usageTotals(rootSessionID)
    return coordinator.updateBudgetUsage(rootSessionID, usage)
  }
  return {
    orchestration_prepare_edit_plan: tool({
      description: "Seal explicit non-overlapping ownership/resource partitions and prepare an isolated editor DAG.",
      args: {
        task: tool.schema.string().min(1),
        profile: tool.schema.string().optional(),
        baseSha: tool.schema.string().min(7),
        partitions: tool.schema.array(tool.schema.object({
          id: tool.schema.string().min(1),
          description: tool.schema.string().min(1),
          ownership: tool.schema.array(tool.schema.string().min(1)).min(1),
          inputs: tool.schema.array(tool.schema.string().min(1)).optional(),
          acceptanceCriteria: tool.schema.array(tool.schema.string().min(1)).min(1).optional(),
          exclusiveResources: tool.schema.array(tool.schema.string().min(1)).optional(),
        })).min(1),
      },
      async execute(args, rawContext) {
        if (config.orchestration.parallelEditors === 0) return "Parallel editor mode is disabled (orchestration.parallelEditors is 0)."
        if (args.partitions.length > config.orchestration.parallelEditors) return JSON.stringify({ ok: false, violations: ["editor partition count exceeds parallelEditors"] }, null, 2)
        const violations = validateOwnership(args.partitions.map((p) => ({ id: p.id, paths: p.ownership })))
        if (violations.length) return JSON.stringify({ ok: false, violations }, null, 2)
        const classification = classifyTask(args.task, config.orchestration.profiles)
        const profile = args.profile && profileNameSchema.safeParse(args.profile).success ? args.profile as ProfileName : classification.profile
        const reservedEditorNodes = args.partitions.length + 1
        if (reservedEditorNodes > config.orchestration.maxWorkers) {
          return JSON.stringify({ ok: false, violations: ["editor partitions plus integrator exceed maxWorkers"] }, null, 2)
        }
        const plan = planTask(profile, classification.secondaryProfiles, {
          maxNodes: config.orchestration.maxWorkers,
          includeEvidence: false,
          includeMerger: false,
          editorPartitions: args.partitions.map((partition) => ({
            id: partition.id,
            description: partition.description,
            ownership: partition.ownership,
            ...(partition.inputs ? { inputs: partition.inputs } : {}),
            ...(partition.acceptanceCriteria ? { acceptanceCriteria: partition.acceptanceCriteria } : {}),
            ...(partition.exclusiveResources ? { exclusiveResources: partition.exclusiveResources } : {}),
          })),
          includeIntegrator: true,
        })
        for (const node of plan.nodes) {
          if (node.role === "editor") node.worktree = { branch: "", path: "", baseRevision: args.baseSha }
        }
        const planProblems = [
          ...(plan.nodes.length > config.orchestration.maxWorkers ? ["editor plan exceeds maxWorkers; reduce evidence workers or partitions"] : []),
          ...validatePlan(plan),
        ]
        if (planProblems.length) return JSON.stringify({ ok: false, violations: planProblems, plan }, null, 2)
        const context = rawContext as ToolContextLike
        let run
        try {
          run = context.sessionID ? coordinator.extendPlan(context.sessionID, plan) : undefined
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unable to seal the edit plan."
          return JSON.stringify({ ok: false, violations: [message], plan }, null, 2)
        }
        return JSON.stringify({ ok: true, plan, ...(run ? { run } : {}), parallelEditors: Math.min(config.orchestration.parallelEditors, args.partitions.length), worktreeRoot: config.orchestration.worktreeRoot ?? ".orchestra/worktrees", next: "Dispatch each ready orch-editor through orchestra_dispatch. The runtime creates its isolated Git worktree from baseSha." }, null, 2)
      },
    }),
    orchestration_validate_commit: tool({
      description: "Validate an editor commit using the actual git diff and its sealed plan ownership, never caller or worker claims.",
      args: {
        commitSha: tool.schema.string().min(7),
        nodeId: tool.schema.string().min(1),
      },
      async execute(args, rawContext) {
        const context = rawContext as ToolContextLike
        if (!context.sessionID) return JSON.stringify({ ok: false, error: "A root session is required to load the sealed edit plan." })
        const sealed = coordinator.sealedNode(context.sessionID, args.nodeId)
        if (!sealed || sealed.role !== "editor" || !sealed.baseRevision) {
          return JSON.stringify({ ok: false, error: "The editor node or its sealed base revision is unavailable." })
        }
        const repo = context.worktree || context.directory || dispatch?.directory
        if (!repo) return JSON.stringify({ ok: false, error: "The repository directory is unavailable." })
        await assertCommitDescendsFromBase(systemGit, repo, sealed.baseRevision, args.commitSha)
        const changes = await collectCommitChanges(systemGit, repo, sealed.baseRevision, args.commitSha)
        const partitions = coordinator.sealedEditorPartitions(context.sessionID)
        const changed = Object.fromEntries(partitions.map((p) => [p.id, p.id === args.nodeId ? changes.flatMap((c) => c.oldPath ? [c.oldPath, c.path] : [c.path]) : []]))
        const ownership = partitions.map((p) => ({ id: p.id, paths: p.ownership }))
        const violations = validateChangedFiles(ownership, changed)
        if (violations.length === 0) coordinator.recordValidatedCommit(context.sessionID, args.nodeId, args.commitSha)
        return JSON.stringify({ ok: violations.length === 0, nodeId: args.nodeId, baseSha: sealed.baseRevision, commitSha: args.commitSha, changes, violations }, null, 2)
      },
    }),
    orchestration_relay_context: tool({
      description: "Relay a bounded clarification to a pending, queued, or active Orchestra node. Active dispatch waits for and incorporates the follow-up response before completing.",
      args: {
        nodeId: tool.schema.string().min(1),
        message: tool.schema.string().min(1).max(8_000),
      },
      async execute(args, rawContext) {
        const context = rawContext as ToolContextLike
        if (!context.sessionID) return JSON.stringify({ ok: false, error: "A parent session is required." })
        return JSON.stringify(coordinator.relayContext(context.sessionID, args.nodeId, args.message), null, 2)
      },
    }),
    orchestra_dispatch: tool({
      description: "Run one sealed Orchestra node through the shared depth/total/concurrency/resource guard and configured model fallback chain.",
      args: {
        agent: tool.schema.string().min(1),
        task: tool.schema.string().min(1),
        nodeId: tool.schema.string().min(1),
        contract: tool.schema.object({
          objective: tool.schema.string().min(1),
          inputs: tool.schema.array(tool.schema.string().min(1)),
          deliverable: tool.schema.string().min(1),
          acceptanceCriteria: tool.schema.array(tool.schema.string().min(1)).min(1),
          allowedPaths: tool.schema.array(tool.schema.string().min(1)),
          exclusiveResources: tool.schema.array(tool.schema.string().min(1)),
          delegation: tool.schema.object({
            allowed: tool.schema.boolean(),
            maxChildren: tool.schema.number().int().min(0).max(1),
          }),
        }).optional(),
      },
      async execute(args, rawContext) {
        if (!dispatch) return JSON.stringify({ ok: false, error: "Fallback dispatcher is unavailable." })
        const agent = dispatch.agents[args.agent]
        if (!agent || agent.mode !== "subagent") {
          return JSON.stringify({ ok: false, error: "Unknown Orchestra subagent." })
        }
        if (!supportsFallbackDispatch(args.agent)) return JSON.stringify({ ok: false, error: "This agent cannot be dispatched through Orchestra." })
        const context = rawContext as ToolContextLike
        if (!context.sessionID) return JSON.stringify({ ok: false, error: "A parent session is required." })
        const parentSessionID = context.sessionID
        const parent = coordinator.sessionContext(parentSessionID)
        if (!parent && context.agent && context.agent !== "orch-lead") {
          return JSON.stringify({ ok: false, code: "delegation_denied", error: "Unmanaged worker sessions cannot start a new orchestration tree." })
        }
        if (parent && !NESTED_EVIDENCE_AGENTS.has(args.agent)) {
          return JSON.stringify({ ok: false, code: "delegation_denied", error: "Nested workers may delegate only to read-only evidence agents." })
        }
        if (parent && context.agent && context.agent !== parent.agent) {
          return JSON.stringify({ ok: false, code: "parent_mismatch", error: "The calling session is not attached to the claimed Orchestra parent." })
        }
        const models = fallbackModelsForAgent(config, args.agent, agent.model)
        if (models.length === 0) {
          return JSON.stringify({ ok: false, error: "No model is available for this agent." })
        }
        let directory = context.worktree || context.directory || dispatch.directory
        try {
          const budget = await syncTaskBudget(parentSessionID)
          if (budget?.status === "exceeded") {
            return JSON.stringify({ ok: false, code: "budget_exceeded", error: budget.reason, budget }, null, 2)
          }
        } catch {
          return JSON.stringify({ ok: false, code: "budget_accounting_error", error: "Unable to read task budget usage." }, null, 2)
        }
        const reservation = await coordinator.acquire({
          parentSessionID,
          nodeId: args.nodeId,
          agent: args.agent,
          task: args.task,
          ...(args.contract ? { contract: args.contract } : {}),
          ...(context.abort ? { signal: context.abort } : {}),
        })
        if (!reservation.ok) {
          return JSON.stringify({ ok: false, agent: args.agent, nodeId: args.nodeId, code: reservation.code, error: reservation.error, runtime: reservation.snapshot }, null, 2)
        }
        const lease = reservation.lease
        const dependencyResults = coordinator.dependencyOutputs(lease.rootSessionID, args.nodeId)
        const nodeLabel = args.nodeId.replace(/\s+/g, " ").trim().slice(0, 80) || args.agent
        let worktree: { path: string; branch: string } | undefined
        let successfulChild: { id: string; model: { providerID: string; modelID: string } } | undefined
        if (args.agent === "orch-editor") {
          const sealed = coordinator.sealedNode(parentSessionID, args.nodeId)
          if (sealed?.role !== "editor" || !sealed.baseRevision) {
            const runtime = coordinator.complete(lease, false, "Editor node has no sealed base revision.")
            return JSON.stringify({ ok: false, agent: args.agent, nodeId: args.nodeId, code: "worktree_unavailable", error: "Editor node has no sealed base revision.", runtime }, null, 2)
          }
          try {
            worktree = await createEditorWorktree(
              dispatch.git ?? systemGit,
              dispatch.directory,
              lease.rootSessionID,
              `${args.nodeId}-attempt-${lease.attempt}`,
              sealed.baseRevision,
              config.orchestration.worktreeRoot,
            )
            directory = path.resolve(dispatch.directory, worktree.path)
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unable to create editor worktree."
            const runtime = coordinator.complete(lease, false, message)
            return JSON.stringify({ ok: false, agent: args.agent, nodeId: args.nodeId, code: "worktree_create_failed", error: message.replace(/\s+/g, " ").trim().slice(0, 240), runtime }, null, 2)
          }
        } else if (args.agent === "orch-integrator") {
          directory = dispatch.directory
        }
        try {
          const result = await dispatchWithFallback(models, async (model, attempt) => {
            if (context.abort?.aborted) throw Object.assign(new Error("Dispatch cancelled."), { name: "AbortError" })
            const childResponse = await dispatch.client.session.create({
              body: {
                parentID: parentSessionID,
                title: `Orchestra ${nodeLabel} attempt ${attempt}`,
              },
              query: { directory },
              throwOnError: true,
            })
            const child = childResponse.data
            coordinator.attachSession(lease, child.id)
            const modelRef = splitModelId(model)
            let aborted = false
            const abortChild = () => {
              aborted = true
              void dispatch.client.session.abort({ path: { id: child.id }, query: { directory }, throwOnError: true }).catch(() => undefined)
            }
            context.abort?.addEventListener("abort", abortChild, { once: true })
            let response
            const initialUpdates = coordinator.pendingContext(lease)
            try {
              const integratorContext = args.agent === "orch-integrator"
                ? `\n\nValidated editor commits (use this exact deterministic set):\n${JSON.stringify(coordinator.validatedCommits(parentSessionID), null, 2)}`
                : ""
              const relayedContext = initialUpdates.length ? `\n\n${renderContextUpdates(initialUpdates)}` : ""
              response = await dispatch.client.session.prompt({
                path: { id: child.id },
                query: { directory },
                body: {
                  agent: args.agent,
                  model: modelRef,
                  parts: [{ type: "text", text: renderTaskContract(args.nodeId, args.task, lease.contract, lease.depth, dependencyResults) + integratorContext + relayedContext }],
                },
                ...(context.abort ? { signal: context.abort } : {}),
                throwOnError: true,
              })
            } finally {
              context.abort?.removeEventListener("abort", abortChild)
            }
            if (aborted || context.abort?.aborted) throw Object.assign(new Error("Dispatch cancelled."), { name: "AbortError" })
            const failure = assistantFailure(response.data.info, response.data.parts)
            if (failure) throw failure
            coordinator.acknowledgeContext(lease, initialUpdates.map((update) => update.id))
            const output = response.data.parts
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("")
              .trim()
            successfulChild = { id: child.id, model: modelRef }
            return output || "Worker completed without a text response."
          }, async (event) => {
            if (event.outcome === "succeeded") return
            await ledger.recordReliabilityEvent(lease.rootSessionID, { ...event, at: Date.now() })
          })
          if (!result.ok) {
            const runtime = coordinator.complete(lease, false, result.errorKind)
            return JSON.stringify({ ok: false, agent: args.agent, nodeId: args.nodeId, rootSessionID: lease.rootSessionID, depth: lease.depth, errorKind: result.errorKind, attempts: result.attempts, runtime }, null, 2)
          }
          let finalOutput = result.value
          while (true) {
            const completion = coordinator.completeIfContextDrained(lease, finalOutput)
            if (completion.completed) {
              return JSON.stringify({ ok: true, agent: args.agent, nodeId: args.nodeId, rootSessionID: lease.rootSessionID, depth: lease.depth, model: result.model, attempts: result.attempts, output: finalOutput, ...(worktree ? { worktree: { ...worktree, path: directory } } : {}), runtime: completion.snapshot }, null, 2)
            }
            if (!successfulChild) throw new Error("The successful worker session is unavailable for a context follow-up.")
            const followup = await dispatch.client.session.prompt({
              path: { id: successfulChild.id },
              query: { directory },
              body: {
                agent: args.agent,
                model: successfulChild.model,
                parts: [{ type: "text", text: renderContextUpdates(completion.updates) }],
              },
              ...(context.abort ? { signal: context.abort } : {}),
              throwOnError: true,
            })
            const failure = assistantFailure(followup.data.info, followup.data.parts)
            if (failure) throw failure
            coordinator.acknowledgeContext(lease, completion.updates.map((update) => update.id))
            const revised = followup.data.parts
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("")
              .trim()
            finalOutput += `\n\nParent context follow-up:\n${revised || "Worker incorporated the update without a text response."}`
          }
        } catch (error) {
          const message = "Unexpected dispatcher failure. Inspect local provider diagnostics."
          const runtime = coordinator.complete(lease, false, message)
          return JSON.stringify({ ok: false, agent: args.agent, nodeId: args.nodeId, rootSessionID: lease.rootSessionID, depth: lease.depth, code: "dispatcher_error", error: message.replace(/\s+/g, " ").trim().slice(0, 240), runtime }, null, 2)
        }
      },
    }),
    orchestra_route: tool({
      description: "Classify a complex task and return the recommended OpenCode Orchestra worker team for the active budget mode. This does not execute the team.",
      args: {
        task: tool.schema.string().min(1),
        profile: tool.schema.string().optional(),
        maxCostUSD: tool.schema.number().min(0).optional(),
        maxTokens: tool.schema.number().int().min(0).optional(),
        maxMinutes: tool.schema.number().min(0).max(24 * 60).optional(),
        unknownPricing: tool.schema.enum(["warn", "block"]).optional(),
      },
      async execute(args, context) {
        const requested = args.profile ? profileNameSchema.safeParse(args.profile) : undefined
        let cached = false
        let classification: Classification

        if (requested?.success) {
          classification = {
            ...classifyTask(args.task, config.orchestration.profiles),
            profile: requested.data,
            confidence: 1,
            matchedSignals: ["explicit profile"],
          }
        } else {
          const hit = classificationCache.get(args.task)
          if (hit) {
            classification = hit
            cached = true
          } else {
            classification = classifyTask(args.task, config.orchestration.profiles)
            classificationCache.set(args.task, classification)
          }
        }

        const profile = classification.profile
        const reusableKnowledge = await knowledge.query(args.task).catch(() => [])
        const enabledWorkers = Object.values(PROFILE_CATALOG)
          .filter((candidate) => config.orchestration.profiles[candidate.name] !== false)
          .flatMap((candidate) => candidate.workers)
        const initialPlanNodes = config.orchestration.adaptive.enabled && config.budget !== "ebobo"
          ? Math.min(config.orchestration.maxWorkers, config.orchestration.adaptive.initialWorkers + 1)
          : config.orchestration.maxWorkers
        const planOptions = {
          maxNodes: initialPlanNodes,
          dependencyAware: true,
          includeMerger: initialPlanNodes > 1,
          includeJudge: config.budget === "ebobo",
          researchSwarm: config.budget === "ebobo" && profile === "research",
          ...(config.budget === "ebobo" ? { secondaryWorkers: Array.from(new Set(enabledWorkers)) } : {}),
        }
        let plan = planTask(profile, classification.secondaryProfiles, planOptions)
        const planProblems = validatePlan(plan)
        if (planProblems.length) {
          return JSON.stringify({ ok: false, error: "Generated orchestration plan is invalid.", violations: planProblems, plan }, null, 2)
        }
        let plannedWorkers = plan.nodes
          .filter((node) => node.role === "specialist" || node.role === "reviewer")
          .map((node) => node.worker)
        const sessionID = (context as ToolContextLike).sessionID
        let session: Awaited<ReturnType<Ledger["getSession"]>> | undefined
        if (sessionID) {
          try {
            session = await ledger.getSession(sessionID)
          } catch {
            return SESSION_LEDGER_ERROR
          }
        }
        const paidBudget = paidBudgetFor(config.budget, {
          maxPaidCalls: config.orchestration.maxPremiumCallsPerTask,
        })
        const paidCallsUsed = session?.paidCallsUsed ?? 0
        const fallbackChains = config.models.fallback.enabled
          ? Object.fromEntries(Object.entries(config.models.worker).map(([capability, pool]) => {
              const chain = buildFallbackChain(pool, capability as Parameters<typeof buildFallbackChain>[1], config.budget, paidCallsUsed < paidBudget.maxPaidCalls, {
                paidCallsUsed,
                maxPaidCalls: paidBudget.maxPaidCalls,
              })
              return [capability, chain?.all.slice(0, config.models.fallback.maxRetries + 1) ?? []]
            }))
          : {}
        const fallbackAgentChains = config.models.fallback.enabled && dispatch
          ? Object.fromEntries(
              [...new Set([...plannedWorkers, "orch-merge", "orch-judge"])]
                .filter((agent) => dispatch.agents[agent])
                .map((agent) => [
                  agent,
                  fallbackModelsForAgent(config, agent, dispatch.agents[agent]?.model),
                ]),
            )
          : {}

        const guard = createBudgetGuard(paidBudget)
        for (let i = 0; i < paidCallsUsed; i++) guard.recordPaidCall("paid")
        const escalation = decideEscalation(config, {
          classification,
          ...(session?.consensus !== undefined ? { consensus: session.consensus } : {}),
          premiumCallsUsed: paidCallsUsed,
        })
        if (escalation.escalate !== planOptions.includeJudge) {
          plan = planTask(profile, classification.secondaryProfiles, { ...planOptions, includeJudge: escalation.escalate })
          plannedWorkers = plan.nodes.filter((node) => node.role === "specialist" || node.role === "reviewer").map((node) => node.worker)
        }
        if (sessionID) {
          try {
            await ledger.setProfile(sessionID, profile)
          } catch {
            return SESSION_LEDGER_ERROR
          }
        }
        // Pre-run estimate reserves the whole planned DAG against hard limits.
        let estimate: Awaited<ReturnType<typeof estimateCost>> | undefined
        if (config.pricing.estimate && pricing?.snapshot) {
          estimate = await estimateCost({
            budget: config.budget,
            plan,
            workerPools: config.models.worker,
            leadPool: config.models.lead,
            judgePool: config.models.judge,
            workerPoolOf: workerPoolKey,
            workerCapabilityOf: workerCapability,
            snapshot: pricing.snapshot,
            tokens: { workerTokens: 4000, leadTokens: 6000, judgeTokens: 4000 },
            ...(pricing.aliases?.length ? { aliases: pricing.aliases } : {}),
            ...(pricing.openRouter ? { openRouter: pricing.openRouter } : {}),
          })
        }
        const taskBudget = {
          ...config.orchestration.taskBudget,
          ...(args.maxCostUSD !== undefined ? { maxCostUSD: args.maxCostUSD } : {}),
          ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
          ...(args.maxMinutes !== undefined ? { maxMinutes: args.maxMinutes } : {}),
          ...(args.unknownPricing !== undefined ? { unknownPricing: args.unknownPricing } : {}),
        }
        const estimatedTokens = Math.ceil((plan.nodes.length * 4_000 + 6_000) * 1.2)
        const preflightProblems = [
          ...(taskBudget.maxCostUSD > 0 && estimate && estimate.total > taskBudget.maxCostUSD
            ? [`Estimated cost $${estimate.total.toFixed(2)} exceeds the $${taskBudget.maxCostUSD.toFixed(2)} task budget.`]
            : []),
          ...(taskBudget.maxTokens > 0 && estimatedTokens > taskBudget.maxTokens
            ? [`Estimated token use ${estimatedTokens} exceeds the ${taskBudget.maxTokens} task budget.`]
            : []),
          ...(taskBudget.unknownPricing === "block" && (!estimate || estimate.breakdown.unknownCalls > 0)
            ? [estimate ? `${estimate.breakdown.unknownCalls} planned call(s) have unknown pricing.` : "A cost estimate is unavailable, so the USD budget cannot be enforced before execution."]
            : []),
        ]
        if (preflightProblems.length) {
          return JSON.stringify({ ok: false, code: "budget_preflight_failed", errors: preflightProblems, taskBudget, estimate: estimate ?? null, estimatedTokens }, null, 2)
        }
        let run
        let runtimeBudget
        if (sessionID) {
          try {
            run = coordinator.registerPlan(sessionID, plan)
            runtimeBudget = coordinator.configureBudget(sessionID, taskBudget, {
              ...(estimate ? { costUSD: estimate.total, unknownPriceCalls: estimate.breakdown.unknownCalls } : {}),
              tokens: estimatedTokens,
            })
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unable to seal the orchestration plan."
            return JSON.stringify({ ok: false, error: message }, null, 2)
          }
        }

        const eboboHint = config.budget === "ebobo"
          ? plan.strategy?.kind === "research-swarm"
            ? " EBOBO RESEARCH SWARM: execute the plan round by round. Pass every dependency result, labeled by node ID, to each cross-pollination node so it can update the shared hypothesis ledger and reallocate effort. Always consult orch-judge and accept only its explicit verdict."
            : " EBOBO MODE: run all level-0 branches concurrently and always consult orch-judge for frontier arbitration."
          : ""

        const routing = buildLeadRouting(config)

        return JSON.stringify(
          {
            profile,
            secondaryProfiles: classification.secondaryProfiles,
            confidence: classification.confidence,
            classificationFallback: classification.fallback,
            classificationWarning: classification.fallback ? "No domain signals matched; architecture is a provisional default." : null,
            critical: classification.critical,
            cached,
            workers: plannedWorkers,
            parallelWorkers: config.orchestration.parallelWorkers,
            plannedPeakWorkers: Math.min(config.orchestration.parallelWorkers, plan.maxParallel),
            limits: {
              maxWorkers: config.orchestration.maxWorkers,
              parallelWorkers: config.orchestration.parallelWorkers,
              maxDelegationDepth: config.orchestration.maxDelegationDepth,
            },
            plan,
            reusableKnowledge: reusableKnowledge.filter((entry) => entry.status === "valid"),
            staleKnowledge: reusableKnowledge.filter((entry) => entry.status === "stale").map((entry) => ({ id: entry.id, kind: entry.kind, staleReason: entry.staleReason, paths: entry.paths })),
            swarm: plan.strategy ?? null,
            ...(run ? { run } : {}),
            routing: {
              lead: {
                ...(routing.model ? { model: routing.model } : {}),
                ...(routing.reason ? { reason: routing.reason } : {}),
              },
              source: routing.source,
              budget: routing.budget,
            },
            paidBudget: {
              maxPaidCalls: paidBudget.maxPaidCalls,
              remaining: guard.remaining(),
              enabled: paidBudget.enabled,
              paidCallsUsed,
              sessionAccountingAvailable: sessionID !== undefined,
              warning: paidCallsUsed > 0 && paidCallsUsed >= Math.max(1, Math.ceil(paidBudget.maxPaidCalls * paidBudget.warnAt))
                ? "Premium budget is nearly exhausted. Paid models will be excluded at the cap."
                : null,
            },
            taskBudget: runtimeBudget ?? {
              limits: taskBudget,
              estimatedCostUSD: estimate?.total ?? null,
              estimatedTokens,
              status: "estimate-only",
              warning: !estimate || estimate.breakdown.unknownCalls > 0
                ? "Some model prices are unknown; those calls are excluded from the USD estimate."
                : null,
            },
            fallback: {
              enabled: config.models.fallback.enabled,
              maxRetries: config.models.fallback.maxRetries,
              chains: fallbackChains,
              agents: fallbackAgentChains,
              note: "orchestra_dispatch executes fallback and lifecycle accounting for every Orchestra subagent, including isolated editors and the integrator; only the primary lead remains native.",
            },
            escalation,
            ...(estimate ? { estimate } : {}),
            ...(estimate ? { warning: formatEstimateWarning(estimate, config.pricing.warnThresholdUSD) ?? null } : { warning: null }),
            next: "Execute the sealed plan as orch-lead. Pass each node's unchanged nodeId and TaskContract to orchestra_dispatch, release dependencies only after success, and call orch-merge exactly once. Register final verification gates, run them through normal permissioned tools, and call orchestration_complete before reporting verified completion." + eboboHint,
          },
          null,
          2,
        )
      },
    }),
    orchestration_adapt: tool({
      description: "Extend the sealed plan with a small specialist branch only when runtime evidence exposes a supported trigger. Every extension creates an auditable plan version.",
      args: {
        observations: tool.schema.array(tool.schema.object({
          trigger: tool.schema.enum(ADAPTIVE_TRIGGERS),
          detail: tool.schema.string().min(1),
          evidence: tool.schema.array(tool.schema.string().min(1)).optional(),
        })).min(1).max(8),
      },
      async execute(args, context) {
        if (!config.orchestration.adaptive.enabled) return JSON.stringify({ ok: false, error: "Adaptive team expansion is disabled." })
        const sessionID = (context as ToolContextLike).sessionID
        if (!sessionID) return JSON.stringify({ ok: false, error: "Cannot adapt: current session ID was not provided." })
        const current = coordinator.adaptiveContext(sessionID)
        if (!current) return JSON.stringify({ ok: false, error: "Register an orchestration plan before adapting it." })
        const extensions = current.triggers.length
        if (extensions >= config.orchestration.adaptive.maxExtensions) {
          return JSON.stringify({ ok: false, error: `Adaptive extension limit ${config.orchestration.adaptive.maxExtensions} is exhausted.`, planVersion: current.planVersion })
        }
        const insufficient = args.observations.filter((observation) => (observation.evidence ?? []).length < config.orchestration.adaptive.minEvidenceItems)
        if (insufficient.length) {
          return JSON.stringify({ ok: false, error: `Every adaptive observation requires at least ${config.orchestration.adaptive.minEvidenceItems} evidence item(s).`, triggers: insufficient.map((entry) => entry.trigger) })
        }
        const plan = planAdaptiveExtension({
          planVersion: current.planVersion,
          nodeIds: current.nodeIds,
          succeededNodeIds: current.succeededNodeIds,
          remainingSlots: current.remainingSlots,
          usedTriggers: current.triggers,
        }, args.observations)
        if (!plan) return JSON.stringify({ ok: false, code: "no_adaptive_change", error: "No new supported trigger or worker slot is available.", planVersion: current.planVersion })
        const triggers = [...new Set(args.observations.map((entry) => entry.trigger))]
        try {
          const run = coordinator.extendPlan(current.rootSessionID, plan, {
            reason: args.observations.map((entry) => `${entry.trigger}: ${entry.detail}`).join(" | "),
            trigger: triggers.join(","),
          })
          return JSON.stringify({
            ok: true,
            planVersion: run.planVersion,
            extension: plan,
            run,
            next: "Dispatch the new ready nodes with their unchanged nodeId and TaskContract, then execute the adaptive merge node after its dependencies succeed.",
          }, null, 2)
        } catch (error) {
          return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Unable to extend the orchestration plan." }, null, 2)
        }
      },
    }),
    orchestra_knowledge_query: tool({
      description: "Find locally stored verified decisions, test commands, and constraints, including provenance and stale status for changed paths.",
      args: {
        query: tool.schema.string().min(1),
        paths: tool.schema.array(tool.schema.string().min(1)).optional(),
      },
      async execute(args) {
        try {
          const matches = await knowledge.query(args.query, args.paths ?? [])
          return JSON.stringify({ ok: true, valid: matches.filter((entry) => entry.status === "valid"), stale: matches.filter((entry) => entry.status === "stale") }, null, 2)
        } catch (error) {
          return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Unable to query verified knowledge." })
        }
      },
    }),
    orchestra_knowledge_record: tool({
      description: "Record a reusable decision, test command, or constraint after this run has reached runtime-verified completion.",
      args: {
        kind: tool.schema.enum(["decision", "test-command", "constraint"]),
        value: tool.schema.string().min(1),
        evidence: tool.schema.array(tool.schema.string().min(1)).min(1).max(16),
        paths: tool.schema.array(tool.schema.string().min(1)).min(1).max(64),
        ttlDays: tool.schema.number().min(0).max(3650).optional(),
      },
      async execute(args, context) {
        const sessionID = (context as ToolContextLike).sessionID
        if (!sessionID) return JSON.stringify({ ok: false, error: "Cannot record knowledge: current session ID was not provided." })
        const completion = coordinator.completion(sessionID)
        const run = coordinator.snapshot(sessionID)
        if (completion?.status !== "verified" || !run) {
          return JSON.stringify({ ok: false, error: "Reusable knowledge can only be recorded after orchestration_complete returns verified completion." })
        }
        try {
          const entry = await knowledge.record({
            kind: args.kind,
            value: args.value,
            evidence: args.evidence,
            paths: args.paths,
            sourceRun: run.rootSessionID,
            sourcePlanVersion: run.planVersion,
            ...(args.ttlDays !== undefined ? { ttlDays: args.ttlDays } : {}),
          })
          return JSON.stringify({ ok: true, entry }, null, 2)
        } catch (error) {
          return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Unable to record verified knowledge." })
        }
      },
    }),
    orchestration_report: tool({
      description: "Record the current session's consensus for disagreement-aware orchestration.",
      args: {
        consensus: tool.schema.number().min(0).max(1),
        uncertainty: tool.schema.number().min(0).max(1).optional(),
        notes: tool.schema.string().optional(),
      },
      async execute(args, context) {
        const sessionID = (context as ToolContextLike).sessionID
        if (!sessionID) return JSON.stringify({ ok: false, error: "Cannot record consensus: current session ID was not provided." })
        const rootSessionID = coordinator.rootSessionID(sessionID)
        await ledger.setConsensus(rootSessionID, args.consensus, { ...(args.uncertainty !== undefined ? { uncertainty: args.uncertainty } : {}), ...(args.notes !== undefined ? { notes: args.notes } : {}) })
        return JSON.stringify({ ok: true, sessionID: rootSessionID, consensus: args.consensus, ...(args.uncertainty !== undefined ? { uncertainty: args.uncertainty } : {}), ...(args.notes !== undefined ? { notes: args.notes } : {}) })
      },
    }),
    orchestration_set_verification: tool({
      description: "Register the exact command and artifact gates that must pass before this Orchestra run can be marked verified.",
      args: {
        commands: tool.schema.array(tool.schema.object({
          id: tool.schema.string().min(1),
          label: tool.schema.string().min(1),
          command: tool.schema.string().min(1),
        })).max(config.orchestration.verification.maxGates).optional(),
        artifacts: tool.schema.array(tool.schema.object({
          id: tool.schema.string().min(1),
          label: tool.schema.string().min(1),
          path: tool.schema.string().min(1),
        })).max(config.orchestration.verification.maxGates).optional(),
      },
      async execute(args, context) {
        const sessionID = (context as ToolContextLike).sessionID
        if (!sessionID) return JSON.stringify({ ok: false, error: "Cannot register verification: current session ID was not provided." })
        const gates = [
          ...(args.commands ?? []).map((entry) => ({ ...entry, kind: "command" as const })),
          ...(args.artifacts ?? []).map((entry) => ({ ...entry, kind: "artifact" as const })),
        ]
        try {
          return JSON.stringify({ ok: true, completion: coordinator.setVerificationGates(sessionID, gates) }, null, 2)
        } catch (error) {
          return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Unable to register verification gates." }, null, 2)
        }
      },
    }),
    orchestration_complete: tool({
      description: "Claim completion and receive a verified result only when all orchestration nodes and registered verification gates have passed.",
      args: {
        summary: tool.schema.string().min(1),
      },
      async execute(args, context) {
        const sessionID = (context as ToolContextLike).sessionID
        if (!sessionID) return JSON.stringify({ ok: false, error: "Cannot complete: current session ID was not provided." })
        try {
          await syncTaskBudget(sessionID)
        } catch {
          return JSON.stringify({ ok: false, error: "Cannot verify completion because task budget usage is unavailable." })
        }
        const base = path.resolve((context as ToolContextLike).worktree ?? dispatch?.directory ?? process.cwd())
        for (const gate of coordinator.completion(sessionID)?.gates ?? []) {
          if (gate.kind !== "artifact") continue
          const candidate = path.resolve(base, gate.path)
          const relative = path.relative(base, candidate)
          if (relative.startsWith("..") || path.isAbsolute(relative)) {
            coordinator.recordArtifactVerification(sessionID, gate.id, false, `Path is outside the active workspace: ${gate.path}`)
            continue
          }
          try {
            const info = await stat(candidate)
            coordinator.recordArtifactVerification(sessionID, gate.id, true, `${gate.path} exists (${info.isDirectory() ? "directory" : `${info.size} bytes`}).`)
          } catch {
            coordinator.recordArtifactVerification(sessionID, gate.id, false, `${gate.path} does not exist.`)
          }
        }
        return JSON.stringify(coordinator.claimCompletion(sessionID, args.summary, config.orchestration.verification.required), null, 2)
      },
    }),
    orchestra_status: tool({
      description: "Show model, worker, escalation, cost, and consensus statistics for the current Orchestra session.",
      args: {},
      async execute(_args, context) {
        const sessionID = (context as ToolContextLike).sessionID
        if (!sessionID) return "Orchestra status is unavailable because the current session ID was not provided."
        const rootSessionID = coordinator.rootSessionID(sessionID)
        await syncTaskBudget(rootSessionID).catch(() => undefined)
        const run = coordinator.formatStatus(rootSessionID)
        const usage = await ledger.formatStatus(rootSessionID)
        return run ? `${run}\n\n${usage}` : usage
      },
    }),
    orchestra_resume: tool({
      description: "List or resume a locally checkpointed unfinished Orchestra run in the current OpenCode session.",
      args: {
        runId: tool.schema.string().optional(),
        list: tool.schema.boolean().optional(),
      },
      async execute(args, context) {
        const sessionID = (context as ToolContextLike).sessionID
        if (!sessionID) return JSON.stringify({ ok: false, error: "Cannot resume: current session ID was not provided." })
        const available = coordinator.resumableRuns()
        if (args.list) return JSON.stringify({ ok: true, runs: available }, null, 2)
        try {
          const resumed = coordinator.resume(sessionID, args.runId)
          return JSON.stringify({
            ok: true,
            ...resumed,
            next: resumed.ready.length > 0
              ? "Dispatch every ready node with its unchanged nodeId and TaskContract. Use orchestra_resume again after those nodes finish to obtain the next dependency wave."
              : "No node is ready. Inspect failed dependencies in the run snapshot before continuing.",
          }, null, 2)
        } catch (error) {
          return JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : "Unable to resume the saved Orchestra run.",
            runs: available,
          }, null, 2)
        }
      },
    }),
    orchestra_plugin_status: tool({
      description: "Show the OpenCode Orchestra plugin's own runtime status: loaded version, budget mode, model strategy, config source, model counts, and companion MCP status (Context7, Codebase Memory, MemoryGraph, Playwright, Git, ast-grep).",
      args: {},
      async execute() {
        if (!pluginStatus) return "OpenCode Orchestra plugin status is unavailable — no plugin status snapshot was captured."
        return formatPluginStatus(pluginStatus)
      },
    }),
  }
}
