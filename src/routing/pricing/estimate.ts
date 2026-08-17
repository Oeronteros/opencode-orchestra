import type { BudgetMode, ModelCandidateInput } from "../../config/schema.js"
import { normalizeCandidate, resolveModel } from "../model-resolver.js"
import type { PriceSnapshot } from "./prices.js"
import { lookupPrice, combinedPrice } from "./prices.js"
import type { TaskPlan } from "../planner.js"

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
}

export interface CostBreakdown {
  workers: number
  workersCost: number
  leadCost: number
  judgeCost: number
  subtotal: number
  /** Conservative +20% buffer for retries / cache misses / reasoning tokens. */
  total: number
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

function resolvePoolPriceId(
  pool: ModelCandidateInput[],
  budget: BudgetMode,
  capability: Parameters<typeof resolveModel>[0]["capability"],
  snapshot: PriceSnapshot,
): { id?: string; price?: ModelPriceLike } {
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
  const configuredPrice = resolved.priceInput !== undefined && resolved.priceOutput !== undefined
    ? { input: resolved.priceInput, output: resolved.priceOutput }
    : undefined
  const price = configuredPrice ?? lookupPrice(snapshot, resolved.id)
  // Only paid models carry a dollar estimate; free/subscription resolve to 0.
  const resolvedPrice = resolved.cost === "paid" ? price : undefined
  return { id: resolved.id, ...(resolvedPrice ? { price: resolvedPrice } : {}) }
}

export function estimateCost(input: CostEstimateInput): CostEstimate {
  const tokens = input.tokens ?? DEFAULT_TOKEN_ESTIMATES
  const lead = resolvePoolPriceId(input.leadPool, input.budget, "reasoning", input.snapshot)
  const judge = resolvePoolPriceId(input.judgePool, input.budget, "review", input.snapshot)

  const workersCost = input.plan.nodes.reduce((sum, node) => {
    const poolKey = input.workerPoolOf(node.worker)
    const pool = input.workerPools[poolKey] ?? []
    const capability = input.workerCapabilityOf?.(node.worker)
      ?? (poolKey === "image" ? "image" : poolKey === "vision" ? "vision" : poolKey === "research" ? "research" : poolKey === "reasoning" ? "reasoning" : "code")
    const { price } = resolvePoolPriceId(pool, input.budget, capability, input.snapshot)
    return sum + costOfTokens(price, tokens.workerTokens)
  }, 0)

  const leadCost = costOfTokens(lead.price, tokens.leadTokens)
  const judgeCost = costOfTokens(judge.price, tokens.judgeTokens)
  const subtotal = workersCost + leadCost + judgeCost
  const total = subtotal * 1.2

  const breakdown: CostBreakdown = {
    workers: input.plan.nodes.length,
    workersCost,
    leadCost,
    judgeCost,
    subtotal,
    total,
  }

  return {
    budget: input.budget,
    total,
    breakdown,
    summary: `This task in ${input.budget} mode will cost roughly $${total.toFixed(2)} (${breakdown.workers} worker calls, lead, ${judge.price ? "plus judge" : "no judge"} arbitration).`,
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
