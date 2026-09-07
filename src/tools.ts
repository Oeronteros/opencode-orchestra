import { tool, type PluginInput, type ToolDefinition } from "@opencode-ai/plugin"
import type { OrchestraConfig, ProfileName } from "./config/schema.js"
import type { AgentSet } from "./agents/types.js"
import { profileNameSchema } from "./config/schema.js"
import { PROFILE_CATALOG } from "./profiles/catalog.js"
import { classifyTask, type Classification } from "./routing/classifier.js"
import { createClassifierCache } from "./routing/classifier-cache.js"
import { decideEscalation } from "./routing/escalation.js"
import { planTask, validatePlan } from "./routing/planner.js"
import { validateOwnership, validateChangedFiles } from "./orchestration/ownership.js"
import { assertCommitDescendsFromBase, collectCommitChanges, systemGit } from "./orchestration/worktrees.js"
import type { TaskContract } from "./orchestration/contracts.js"
import { OrchestrationRunState } from "./orchestration/run-state.js"
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

function renderTaskContract(nodeId: string, task: string, contract: TaskContract, depth: number): string {
  const lines = [
    `Orchestra node: ${nodeId}`,
    `Delegation depth: ${depth}`,
    "Sealed TaskContract:",
    JSON.stringify(contract, null, 2),
    "Caller context (may clarify, but must not widen, the sealed contract):",
    task,
    "Return verified findings plus explicit decisions, assumptions, blockers, and provenance to your direct parent.",
  ]
  return lines.join("\n\n")
}

function splitModelId(id: string): { providerID: string; modelID: string } {
  const separator = id.indexOf("/")
  if (separator <= 0 || separator === id.length - 1) {
    throw Object.assign(new Error("Model ID must use provider/model format"), { status: 400 })
  }
  return { providerID: id.slice(0, separator), modelID: id.slice(separator + 1) }
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
        return JSON.stringify({ ok: true, plan, ...(run ? { run } : {}), parallelEditors: Math.min(config.orchestration.parallelEditors, args.partitions.length), worktreeRoot: config.orchestration.worktreeRoot ?? ".orchestra/worktrees" }, null, 2)
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
        if (!supportsFallbackDispatch(args.agent)) {
          return JSON.stringify({ ok: false, error: "This agent requires the native workspace-aware dispatch path." })
        }
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
        const directory = context.directory || context.worktree || dispatch.directory
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
        const nodeLabel = args.nodeId.replace(/\s+/g, " ").trim().slice(0, 80) || args.agent
        try {
          const result = await dispatchWithFallback(models, async (model, attempt) => {
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
            const response = await dispatch.client.session.prompt({
              path: { id: child.id },
              query: { directory },
              body: {
                agent: args.agent,
                model: modelRef,
                parts: [{ type: "text", text: renderTaskContract(args.nodeId, args.task, lease.contract, lease.depth) }],
              },
              throwOnError: true,
            })
            const output = response.data.parts
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("")
              .trim()
            return output || "Worker completed without a text response."
          }, async (event) => {
            if (event.outcome === "succeeded") return
            await ledger.recordReliabilityEvent(lease.rootSessionID, { ...event, at: Date.now() })
          })
          const runtime = coordinator.complete(lease, result.ok, result.ok ? undefined : result.errorKind)
          return result.ok
            ? JSON.stringify({ ok: true, agent: args.agent, nodeId: args.nodeId, rootSessionID: lease.rootSessionID, depth: lease.depth, model: result.model, attempts: result.attempts, output: result.value, runtime }, null, 2)
            : JSON.stringify({ ok: false, agent: args.agent, nodeId: args.nodeId, rootSessionID: lease.rootSessionID, depth: lease.depth, errorKind: result.errorKind, attempts: result.attempts, runtime }, null, 2)
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
        const enabledWorkers = Object.values(PROFILE_CATALOG)
          .filter((candidate) => config.orchestration.profiles[candidate.name] !== false)
          .flatMap((candidate) => candidate.workers)
        const planOptions = {
          maxNodes: config.orchestration.maxWorkers,
          dependencyAware: true,
          includeMerger: true,
          includeJudge: config.budget === "ebobo",
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
        let run
        if (sessionID) {
          try {
            run = coordinator.registerPlan(sessionID, plan)
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unable to seal the orchestration plan."
            return JSON.stringify({ ok: false, error: message }, null, 2)
          }
        }

        // Pre-run cost estimate (informational; does not block execution).
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

        const eboboHint = config.budget === "ebobo"
          ? " EBOBO MODE: run all level-0 branches concurrently and always consult orch-judge for frontier arbitration."
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
            fallback: {
              enabled: config.models.fallback.enabled,
              maxRetries: config.models.fallback.maxRetries,
              chains: fallbackChains,
              agents: fallbackAgentChains,
              note: "orchestra_dispatch executes fallback for evidence/review/merge/judge subagents; lead and workspace editor calls remain native OpenCode dispatches.",
            },
            escalation,
            ...(estimate ? { estimate } : {}),
            ...(estimate ? { warning: formatEstimateWarning(estimate, config.pricing.warnThresholdUSD) ?? null } : { warning: null }),
            next: "Execute the sealed plan as orch-lead. Pass each node's unchanged nodeId and TaskContract to orchestra_dispatch, release dependencies only after success, and call orch-merge exactly once." + eboboHint,
          },
          null,
          2,
        )
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
    orchestra_status: tool({
      description: "Show model, worker, escalation, cost, and consensus statistics for the current Orchestra session.",
      args: {},
      async execute(_args, context) {
        const sessionID = (context as ToolContextLike).sessionID
        if (!sessionID) return "Orchestra status is unavailable because the current session ID was not provided."
        const rootSessionID = coordinator.rootSessionID(sessionID)
        const run = coordinator.formatStatus(rootSessionID)
        const usage = await ledger.formatStatus(rootSessionID)
        return run ? `${run}\n\n${usage}` : usage
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
