import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { OrchestraConfig, ProfileName } from "./config/schema.js"
import { profileNameSchema } from "./config/schema.js"
import { PROFILE_CATALOG } from "./profiles/catalog.js"
import { classifyTask, type Classification } from "./routing/classifier.js"
import { createClassifierCache } from "./routing/classifier-cache.js"
import { decideEscalation } from "./routing/escalation.js"
import { planTask } from "./routing/planner.js"
import { validateOwnership, validateChangedFiles } from "./orchestration/ownership.js"
import { assertCommitDescendsFromBase, collectCommitChanges, systemGit } from "./orchestration/worktrees.js"
import { createBudgetGuard, paidBudgetFor } from "./routing/budget-guard.js"
import { estimateCost, formatEstimateWarning } from "./routing/pricing/estimate.js"
import type { PriceSnapshot } from "./routing/pricing/prices.js"
import type { ModelAliasEntry, OpenRouterSource } from "./pricing/resolver.js"
import { workerCapability, workerPoolKey } from "./agents/workers.js"
import type { Ledger } from "./telemetry/ledger.js"
import { formatPluginStatus, type PluginStatus } from "./plugin-status.js"
import { buildFallbackChain } from "./routing/fallback.js"
import { resolveModel, leadResolveRequest, boundReasonText, type RoutingReason } from "./routing/model-resolver.js"

interface ToolContextLike {
  sessionID?: string
}

const classificationCache = createClassifierCache()
const SESSION_LEDGER_ERROR = JSON.stringify({ ok: false, error: "Unable to route task because session ledger access failed." })

export interface PricingContext {
  snapshot: PriceSnapshot
  aliases?: ModelAliasEntry[]
  openRouter?: OpenRouterSource
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
): Record<string, ToolDefinition> {
  return {
    orchestration_prepare_edit_plan: tool({
      description: "Validate explicit non-overlapping ownership partitions and prepare an isolated editor DAG.",
      args: {
        task: tool.schema.string().min(1),
        profile: tool.schema.string().optional(),
        partitions: tool.schema.array(tool.schema.object({ id: tool.schema.string().min(1), description: tool.schema.string().min(1), ownership: tool.schema.array(tool.schema.string().min(1)).min(1) })).min(1),
      },
      async execute(args) {
        if (config.orchestration.parallelEditors === 0) return "Parallel editor mode is disabled (orchestration.parallelEditors is 0)."
        if (args.partitions.length > config.orchestration.parallelEditors) return JSON.stringify({ ok: false, violations: ["editor partition count exceeds parallelEditors"] }, null, 2)
        const violations = validateOwnership(args.partitions.map((p) => ({ id: p.id, paths: p.ownership })))
        if (violations.length) return JSON.stringify({ ok: false, violations }, null, 2)
        const classification = classifyTask(args.task, config.orchestration.profiles)
        const profile = args.profile && profileNameSchema.safeParse(args.profile).success ? args.profile as ProfileName : classification.profile
        const plan = planTask(profile, classification.secondaryProfiles, { maxNodes: config.orchestration.maxWorkers, editorPartitions: args.partitions, includeIntegrator: true })
        const planProblems = plan.nodes.length > config.orchestration.maxWorkers ? ["editor plan exceeds maxWorkers; reduce evidence workers or partitions"] : []
        if (planProblems.length) return JSON.stringify({ ok: false, violations: planProblems, plan }, null, 2)
        return JSON.stringify({ ok: true, plan, parallelEditors: Math.min(config.orchestration.parallelEditors, args.partitions.length), worktreeRoot: config.orchestration.worktreeRoot ?? ".orchestra/worktrees" }, null, 2)
      },
    }),
    orchestration_validate_commit: tool({
      description: "Validate an editor commit using the actual git diff and explicit ownership, never worker claims.",
      args: {
        baseSha: tool.schema.string().min(7), commitSha: tool.schema.string().min(7), nodeId: tool.schema.string().min(1),
        partitions: tool.schema.array(tool.schema.object({ id: tool.schema.string().min(1), ownership: tool.schema.array(tool.schema.string().min(1)).min(1) })).min(1),
      },
      async execute(args, context) {
        await assertCommitDescendsFromBase(systemGit, context.worktree, args.baseSha, args.commitSha)
        const changes = await collectCommitChanges(systemGit, context.worktree, args.baseSha, args.commitSha)
        const changed = Object.fromEntries(args.partitions.map((p) => [p.id, p.id === args.nodeId ? changes.flatMap((c) => c.oldPath ? [c.oldPath, c.path] : [c.path]) : []]))
        const ownership = args.partitions.map((p) => ({ id: p.id, paths: p.ownership }))
        const violations = validateChangedFiles(ownership, changed)
        return JSON.stringify({ ok: violations.length === 0, nodeId: args.nodeId, baseSha: args.baseSha, commitSha: args.commitSha, changes, violations }, null, 2)
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
        const definition = PROFILE_CATALOG[profile]
        const enabledWorkers = Object.values(PROFILE_CATALOG)
          .filter((candidate) => config.orchestration.profiles[candidate.name] !== false)
          .flatMap((candidate) => candidate.workers)
        const workerPool = config.budget === "ebobo"
          ? Array.from(new Set(enabledWorkers))
          : definition.workers
        const workers = workerPool.slice(0, config.orchestration.maxWorkers)
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

        const planOptions = {
          maxNodes: config.orchestration.maxWorkers,
          dependencyAware: true,
          includeMerger: true,
          ...(config.budget === "ebobo" ? { secondaryWorkers: Array.from(new Set(enabledWorkers)) } : {}),
        }
        const plan = planTask(profile, classification.secondaryProfiles, planOptions)

        const guard = createBudgetGuard(paidBudget)
        for (let i = 0; i < paidCallsUsed; i++) guard.recordPaidCall("paid")
        const escalation = decideEscalation(config, {
          classification,
          ...(session?.consensus !== undefined ? { consensus: session.consensus } : {}),
          premiumCallsUsed: paidCallsUsed,
        })
        if (sessionID) {
          try {
            await ledger.setProfile(sessionID, profile)
          } catch {
            return SESSION_LEDGER_ERROR
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
            workers,
            parallelWorkers: Math.min(config.orchestration.parallelWorkers, workers.length),
            plan,
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
              note: "Provider retry interception is not claimed; chains are surfaced for safe dispatch failover.",
            },
            escalation,
            ...(estimate ? { estimate } : {}),
            ...(estimate ? { warning: formatEstimateWarning(estimate, config.pricing.warnThresholdUSD) ?? null } : { warning: null }),
            next: "Delegate the full task and returned plan once to orch-lead with profile=" + profile + ". Execute ready nodes level-by-level, concurrently within parallelWorkers, then call orch-merge exactly once." + eboboHint,
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
        await ledger.setConsensus(sessionID, args.consensus, { ...(args.uncertainty !== undefined ? { uncertainty: args.uncertainty } : {}), ...(args.notes !== undefined ? { notes: args.notes } : {}) })
        return JSON.stringify({ ok: true, sessionID, consensus: args.consensus, ...(args.uncertainty !== undefined ? { uncertainty: args.uncertainty } : {}), ...(args.notes !== undefined ? { notes: args.notes } : {}) })
      },
    }),
    orchestra_status: tool({
      description: "Show model, worker, escalation, cost, and consensus statistics for the current Orchestra session.",
      args: {},
      async execute(_args, context) {
        const sessionID = (context as ToolContextLike).sessionID
        if (!sessionID) return "Orchestra status is unavailable because the current session ID was not provided."
        return ledger.formatStatus(sessionID)
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
