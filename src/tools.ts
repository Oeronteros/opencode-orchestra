import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { OrchestraConfig, ProfileName } from "./config/schema.js"
import { profileNameSchema } from "./config/schema.js"
import { PROFILE_CATALOG } from "./profiles/catalog.js"
import { classifyTask, type Classification } from "./routing/classifier.js"
import { createClassifierCache } from "./routing/classifier-cache.js"
import { decideEscalation } from "./routing/escalation.js"
import { planTask } from "./routing/planner.js"
import { createBudgetGuard, paidBudgetFor } from "./routing/budget-guard.js"
import { estimateCost, formatEstimateWarning } from "./routing/pricing/estimate.js"
import type { PriceSnapshot } from "./routing/pricing/prices.js"
import { workerCapability, workerPoolKey } from "./agents/workers.js"
import type { Ledger } from "./telemetry/ledger.js"
import { formatPluginStatus, type PluginStatus } from "./plugin-status.js"

interface ToolContextLike {
  sessionID?: string
}

const classificationCache = createClassifierCache()

export interface PricingContext {
  snapshot: PriceSnapshot
}

export function createOrchestraTools(
  config: OrchestraConfig,
  ledger: Ledger,
  pluginStatus?: PluginStatus,
  pricing?: PricingContext,
): Record<string, ToolDefinition> {
  return {
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

        const planOptions = {
          maxNodes: config.orchestration.maxWorkers,
          dependencyAware: config.budget !== "ebobo",
          ...(config.budget === "ebobo" ? { secondaryWorkers: Array.from(new Set(enabledWorkers)) } : {}),
        }
        const plan = planTask(profile, classification.secondaryProfiles, planOptions)

        const paidBudget = paidBudgetFor(config.budget, {
          maxPaidCalls: config.orchestration.maxPremiumCallsPerTask,
        })
        const guard = createBudgetGuard(paidBudget)

        const escalation = decideEscalation(config, { classification })
        const sessionID = (context as ToolContextLike).sessionID
        if (sessionID) await ledger.setProfile(sessionID, profile)

        // Pre-run cost estimate (informational; does not block execution).
        let estimate: ReturnType<typeof estimateCost> | undefined
        if (config.pricing.estimate && pricing?.snapshot) {
          estimate = estimateCost({
            budget: config.budget,
            plan,
            workerPools: config.models.worker,
            leadPool: config.models.lead,
            judgePool: config.models.judge,
            workerPoolOf: workerPoolKey,
            workerCapabilityOf: workerCapability,
            snapshot: pricing.snapshot,
            tokens: { workerTokens: 4000, leadTokens: 6000, judgeTokens: 4000 },
          })
        }

        const eboboHint = config.budget === "ebobo"
          ? " EBOBO MODE: run all level-0 branches concurrently and always consult orch-judge for frontier arbitration."
          : ""

        return JSON.stringify(
          {
            profile,
            secondaryProfiles: classification.secondaryProfiles,
            confidence: classification.confidence,
            critical: classification.critical,
            cached,
            workers,
            parallelWorkers: Math.min(config.orchestration.parallelWorkers, workers.length),
            plan,
            paidBudget: {
              maxPaidCalls: paidBudget.maxPaidCalls,
              remaining: guard.remaining(),
              enabled: paidBudget.enabled,
            },
            escalation,
            ...(estimate ? { estimate } : {}),
            ...(estimate ? { warning: formatEstimateWarning(estimate, config.pricing.warnThresholdUSD) ?? null } : { warning: null }),
            next: "Delegate the full task once to orch-lead with profile=" + profile + ". Let orch-lead dispatch workers per the plan levels: level 0 branches in parallel, then level 1 synthesis." + eboboHint,
          },
          null,
          2,
        )
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
      description: "Show the OpenCode Orchestra plugin's own runtime status: loaded version, budget mode, model strategy, config source, model counts, and companion MCP status (Context7, Codebase Memory, MemoryGraph, Supermemory).",
      args: {},
      async execute() {
        if (!pluginStatus) return "OpenCode Orchestra plugin status is unavailable — no plugin status snapshot was captured."
        return formatPluginStatus(pluginStatus)
      },
    }),
  }
}
