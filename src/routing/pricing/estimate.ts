import type { BudgetMode, ModelCandidateInput } from "../../config/schema.js"
import { resolveModel } from "../model-resolver.js"
import type { PriceSnapshot } from "./prices.js"
import { combinedPrice, lookupPrice } from "./prices.js"
import type { TaskPlan } from "../planner.js"
import { resolvePricing, type ModelAliasEntry, type OpenRouterSource, type ResolverConfig, type ResolvedPricing, type ResolverInput } from "../../pricing/resolver.js"

// Where money actually flows: a resolved model id maps to a price. Free /
// subscription pools cost nothing here (actual spend is the ledger's job).
export interface PriceResolution {
  /** Price source used for the estimate (where a paid price was found). */
  source: "snapshot" | "remote"
  /** Price (USD per 1M tokens) resolved for a model id, if paid and known. */
  price: ModelPriceLike | undefined
}

type ModelPriceLike = { input: number; output: number }

// Heuristic token assumptions per orchestration call, in thousands of tokens.
// These are deliberately conservative so the estimate is an upper bound.
export interface TokenEstimates {
  /** Input+output tokens for one worker call. */
  workerTokens: number
  /** Input+output tokens for one lead synthesis. */
  leadTokens: number
  /** Input+output tokens for one judge arbitration. */
  judgeTokens: number
}

export const DEFAULT_TOKEN_ESTIMATES: TokenEstimates = {
  workerTokens: 4_000,
  leadTokens: 6_000,
  judgeTokens: 4_000,
}

export interface CostEstimateInput {
  budget: BudgetMode
  plan: TaskPlan
  /** Worker slots for each capability pool (same shape as config.models.worker). */
  workerPools: Record<"code" | "reasoning" | "research" | "vision" | "image", ModelCandidateInput[]>
  leadPool: ModelCandidateInput[]
  judgePool: ModelCandidateInput[]
  /** Worker-name -> capability-pool key (from workers.ts WORKERS spec). */
  workerPoolOf: (worker: string) => keyof CostEstimateInput["workerPools"]
  /** Worker-name -> actual capability; review/security share reasoning pools. */
  workerCapabilityOf?: (worker: string) => Parameters<typeof resolveModel>[0]["capability"]
  snapshot: PriceSnapshot
  tokens?: TokenEstimates
  /** User-defined model aliases (config pricing.aliases). */
  aliases?: ModelAliasEntry[]
  /** Optional OpenRouter fallback source (config pricing.openrouter). */
  openRouter?: OpenRouterSource
}

export interface CostBreakdown {
  workers: number
  workersCost: number
  leadCost: number
  judgeCost: number
  subtotal: number
  /** Conservative +20% buffer for retries / cache misses / reasoning tokens. */
  total: number
  /** Calls whose price could not be determined; excluded from all totals. */
  unknownCalls: number
  /** Calls priced $0 because the model is free (tokens still counted). */
  freeCalls: number
  /** Calls priced $0 because the model runs inside a subscription. */
  subscriptionCalls: number
  /** Calls priced with a known USD rate. */
  paidCalls: number
}

export interface CostEstimate {
  budget: BudgetMode
  /** Estimated USD for this task under the given budget mode. */
  total: number
  breakdown: CostBreakdown
  /** Human-readable summary line for pre-run confirmation. */
  summary: string
}

function costOfTokens(price: ModelPriceLike | undefined, tokens: number): number {
  if (!price) return 0
  // Assume a 3:1 input:output split within the token budget.
  const output = tokens * 0.25
  const input = tokens * 0.75
  return (input * price.input + output * price.output) / 1_000_000
}

/**
 * Resolve the pool's chosen model for a budget/capability, then resolve its
 * pricing through the full ladder (config declarations -> explicit price ->
 * aliases -> provider snapshot -> OpenRouter fallback).
 */
async function resolvePoolPricing(
  pool: ModelCandidateInput[],
  budget: BudgetMode,
  capability: Parameters<typeof resolveModel>[0]["capability"],
  config: ResolverConfig,
): Promise<{ id?: string; resolution?: ResolvedPricing }> {
  const resolved = resolveModel({
    pool,
    capability,
    budget,
    allowPaid: budget === "quality" || budget === "ebobo",
    preferredCosts: budget === "eco" || budget === "balanced" ? ["free"] : [],
    preferredTiers: budget === "ebobo"
      ? ["frontier", "lead"]
      : budget === "quality"
        ? ["lead", "frontier"]
        : ["worker"],
  })
  if (!resolved) return {}
  const input: ResolverInput = {
    id: resolved.id,
    declaredCost: resolved.cost,
    ...(resolved.priceInput !== undefined && resolved.priceOutput !== undefined
      ? { explicitPrice: { input: resolved.priceInput, output: resolved.priceOutput } }
      : {}),
  }
  const resolution = await resolvePricing(input, config)
  return { id: resolved.id, resolution }
}

export async function estimateCost(input: CostEstimateInput): Promise<CostEstimate> {
  const tokens = input.tokens ?? DEFAULT_TOKEN_ESTIMATES
  const config: ResolverConfig = {
    snapshot: input.snapshot,
    ...(input.aliases?.length ? { aliases: input.aliases } : {}),
    ...(input.openRouter ? { openRouter: input.openRouter } : {}),
  }
  const lead = await resolvePoolPricing(input.leadPool, input.budget, "reasoning", config)
  const judge = await resolvePoolPricing(input.judgePool, input.budget, "review", config)

  let workersCost = 0
  let paidCalls = 0
  let freeCalls = 0
  let subscriptionCalls = 0
  let unknownCalls = 0

  for (const node of input.plan.nodes) {
    const poolKey = input.workerPoolOf(node.worker)
    const pool = input.workerPools[poolKey] ?? []
    const capability = input.workerCapabilityOf?.(node.worker)
      ?? (poolKey === "image" ? "image" : poolKey === "vision" ? "vision" : poolKey === "research" ? "research" : poolKey === "reasoning" ? "reasoning" : "code")
    const { resolution } = await resolvePoolPricing(pool, input.budget, capability, config)
    if (!resolution) continue
    if (resolution.status === "paid") {
      workersCost += costOfTokens({ input: resolution.input ?? 0, output: resolution.output ?? 0 }, tokens.workerTokens)
      paidCalls += 1
    } else if (resolution.status === "free") {
      freeCalls += 1
    } else if (resolution.status === "subscription") {
      subscriptionCalls += 1
    } else {
      unknownCalls += 1
    }
  }

  const leadCost = lead.resolution?.status === "paid"
    ? costOfTokens({ input: lead.resolution.input ?? 0, output: lead.resolution.output ?? 0 }, tokens.leadTokens)
    : 0
  const judgeCost = judge.resolution?.status === "paid"
    ? costOfTokens({ input: judge.resolution.input ?? 0, output: judge.resolution.output ?? 0 }, tokens.judgeTokens)
    : 0
  if (lead.resolution) {
    if (lead.resolution.status === "paid") paidCalls += 1
    else if (lead.resolution.status === "free") freeCalls += 1
    else if (lead.resolution.status === "subscription") subscriptionCalls += 1
    else unknownCalls += 1
  }
  if (judge.resolution) {
    if (judge.resolution.status === "paid") paidCalls += 1
    else if (judge.resolution.status === "free") freeCalls += 1
    else if (judge.resolution.status === "subscription") subscriptionCalls += 1
    else unknownCalls += 1
  }

  const subtotal = workersCost + leadCost + judgeCost
  const total = subtotal * 1.2

  const breakdown: CostBreakdown = {
    workers: input.plan.nodes.length,
    workersCost,
    leadCost,
    judgeCost,
    subtotal,
    total,
    unknownCalls,
    freeCalls,
    subscriptionCalls,
    paidCalls,
  }

  const unknownNote = unknownCalls > 0 ? `, ${unknownCalls} call(s) with unknown price excluded` : ""
  return {
    budget: input.budget,
    total,
    breakdown,
    summary: `This task in ${input.budget} mode will cost roughly $${total.toFixed(2)} (${breakdown.workers} worker calls, lead, ${judge.resolution?.status === "paid" ? "plus judge" : "no judge"} arbitration${unknownNote}).`,
  }
}

/** Compare an estimate against a warning threshold; returns a pre-run message. */
export function formatEstimateWarning(estimate: CostEstimate, thresholdUSD = 0.5): string | undefined {
  if (estimate.total >= thresholdUSD) {
    return `Heads up: this task in ${estimate.budget} mode is estimated at approximately $${estimate.total.toFixed(2)}. Proceed only if that is acceptable.`
  }
  return undefined
}

/** Total combined price for a model id or 0 when unknown/free. */
export function priceOfModel(snapshot: PriceSnapshot, modelId: string): number {
  return combinedPrice(lookupPrice(snapshot, modelId))
}
