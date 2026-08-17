import type {
  BudgetMode,
  CapabilityName,
  ModelCandidateInput,
  ModelCost,
  ModelTier,
} from "../config/schema.js"
import { costAdjustment, getBudgetPolicy } from "./budget.js"

export interface ModelCandidate {
  id: string
  cost: ModelCost
  tier: ModelTier
  priority: number
  capabilities: CapabilityName[]
  scores: Record<string, number>
  context?: "small" | "medium" | "large" | "xlarge"
  /** Explicit USD price per 1M input tokens, when configured. */
  priceInput?: number
  /** Explicit USD price per 1M output tokens, when configured. */
  priceOutput?: number
}

export interface ResolveModelRequest {
  pool: ModelCandidateInput[]
  capability: CapabilityName
  budget: BudgetMode
  allowPaid: boolean
  preferredCosts?: ModelCost[]
  preferredTiers?: ModelTier[]
}

export interface ResolvedModel {
  id: string
  score: number
  cost: ModelCost
  priceInput?: number
  priceOutput?: number
  reason: string[]
  /**
   * Ordered failover alternatives (cheaper first). When the primary fails
   * with a retryable error, step down this list instead of re-hitting it.
   */
  fallback: string[]
}

export function normalizeCandidate(input: ModelCandidateInput): ModelCandidate {
  if (typeof input === "string") {
    return {
      id: input,
      cost: "free",
      tier: "worker",
      priority: 50,
      capabilities: [],
      scores: {},
    }
  }

  return {
    id: input.id,
    cost: input.cost,
    tier: input.tier,
    priority: input.priority,
    capabilities: input.capabilities,
    scores: input.scores,
    ...(input.context ? { context: input.context } : {}),
    ...(input.priceInput !== undefined ? { priceInput: input.priceInput } : {}),
    ...(input.priceOutput !== undefined ? { priceOutput: input.priceOutput } : {}),
  }
}

const COST_ORDER: Record<ModelCost, number> = { paid: 2, subscription: 1, free: 0 }

function priceAdjustment(candidate: ModelCandidate): number {
  // A monetary price is a separate ranking signal from the coarse cost class:
  // all else equal, cheaper models win. Log-scale so differences are gentle.
  const price = (candidate.priceInput ?? 0) + (candidate.priceOutput ?? 0)
  if (price <= 0) return 0
  return -Math.round(Math.log10(1 + price) * 6)
}

export function resolveModel(request: ResolveModelRequest): ResolvedModel | undefined {
  const policy = getBudgetPolicy(request.budget)
  const ranked = request.pool
    .map(normalizeCandidate)
    .filter((candidate) => request.allowPaid || candidate.cost !== "paid")
    .map((candidate) => {
      const explicit = candidate.scores[request.capability] ?? 0
      const declared = candidate.capabilities.includes(request.capability) ? 18 : 0
      const contextBonus = candidate.context === "xlarge" ? 8 : candidate.context === "large" ? 4 : 0
      const frontierBonus = request.budget === "ebobo"
        ? candidate.tier === "frontier"
          ? 160
          : candidate.tier === "lead"
            ? 60
            : 0
        : 0
      const preferredCostIndex = request.preferredCosts?.indexOf(candidate.cost) ?? -1
      const preferredTierIndex = request.preferredTiers?.indexOf(candidate.tier) ?? -1
      const preferredCostBonus = preferredCostIndex >= 0 ? Math.max(30, 100 - preferredCostIndex * 30) : 0
      const preferredTierBonus = preferredTierIndex >= 0 ? Math.max(30, 100 - preferredTierIndex * 30) : 0
      const priceAdj = priceAdjustment(candidate)
      const score = candidate.priority + explicit * 8 + declared + contextBonus + frontierBonus
        + preferredCostBonus + preferredTierBonus + costAdjustment(candidate.cost, policy) + priceAdj
      const reason = [
        "priority=" + candidate.priority,
        "capability=" + (explicit || (declared ? "declared" : "unspecified")),
        "cost=" + candidate.cost,
        ...(frontierBonus ? ["frontier=" + frontierBonus] : []),
        ...(preferredCostBonus ? ["preferred-cost=" + preferredCostBonus] : []),
        ...(preferredTierBonus ? ["preferred-tier=" + preferredTierBonus] : []),
        ...(priceAdj !== 0 ? ["price=" + priceAdj] : []),
      ]
      return { candidate, score, reason }
    })
    .sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id))

  const winner = ranked[0]
  if (!winner) return undefined

  const fallback = ranked
    .slice(1)
    .sort((a, b) => COST_ORDER[a.candidate.cost] - COST_ORDER[b.candidate.cost] || a.score - b.score || a.candidate.id.localeCompare(b.candidate.id))
    .map((item) => item.candidate.id)

  return {
    id: winner.candidate.id,
    score: winner.score,
    cost: winner.candidate.cost,
    ...(winner.candidate.priceInput !== undefined ? { priceInput: winner.candidate.priceInput } : {}),
    ...(winner.candidate.priceOutput !== undefined ? { priceOutput: winner.candidate.priceOutput } : {}),
    reason: winner.reason,
    fallback,
  }
}
