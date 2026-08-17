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
  reason: string[]
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
  }
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
      const score = candidate.priority + explicit * 8 + declared + contextBonus + frontierBonus
        + preferredCostBonus + preferredTierBonus + costAdjustment(candidate.cost, policy)
      const reason = [
        `priority=${candidate.priority}`,
        `capability=${explicit || (declared ? "declared" : "unspecified")}`,
        `cost=${candidate.cost}`,
        ...(frontierBonus ? [`frontier=${frontierBonus}`] : []),
        ...(preferredCostBonus ? [`preferred-cost=${preferredCostBonus}`] : []),
        ...(preferredTierBonus ? [`preferred-tier=${preferredTierBonus}`] : []),
      ]
      return { candidate, score, reason }
    })
    .sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id))

  const winner = ranked[0]
  if (!winner) return undefined

  return {
    id: winner.candidate.id,
    score: winner.score,
    cost: winner.candidate.cost,
    reason: winner.reason,
  }
}
