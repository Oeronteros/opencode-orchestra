import type {
  BudgetMode,
  CapabilityName,
  ModelCandidateInput,
  ModelCost,
  ModelTier,
} from "../config/schema.js"
import { costAdjustment, getBudgetPolicy } from "./budget.js"

/**
 * Stable machine-readable routing decision identifier. The resolver only emits
 * the scoring codes; `exact_override` is reserved for an explicit orch-lead
 * agent override and is produced by the tool layer, not the resolver.
 */
export type RoutingReasonCode =
  | "frontier"
  | "preferred_tier"
  | "preferred_cost"
  | "capability_match"
  | "price"
  | "priority"
  | "exact_override"

export interface RoutingReason {
  code: RoutingReasonCode
  /** Bounded diagnostic copy; never contains secrets, prompts, or credentials. */
  text: string
  matchedCapabilities: CapabilityName[]
  score: number
  budget: BudgetMode
}

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
  /** Session-level cap: paid candidates are excluded once this is reached. */
  paidCallsUsed?: number
  maxPaidCalls?: number
}

/**
 * The shared resolution parameters for the orch-lead agent. Both the tool
 * layer (routing metadata) and `createLeadAgent` (the actually assigned model)
 * resolve the lead pool through this exact request so the reported lead always
 * matches the assigned one.
 */
export function leadResolveRequest(budget: BudgetMode): Omit<ResolveModelRequest, "pool" | "capability"> {
  return {
    budget,
    allowPaid: budget === "quality" || budget === "ebobo",
    preferredCosts: budget === "balanced"
      ? ["subscription"]
      : budget === "eco"
        ? ["free"]
        : [],
    preferredTiers: budget === "balanced"
      ? ["lead"]
      : budget === "quality" || budget === "ebobo"
        ? ["frontier", "lead"]
        : [],
  }
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
  /** Structured, machine-readable routing decision for the winning model. */
  routingReason?: RoutingReason
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

/**
 * Shared capability scoring helpers. `resolveModel` uses these for scoring and
 * `buildFallbackChain` uses them to filter and rank fallback alternatives.
 */

export function hasDeclaredCapability(candidate: ModelCandidate, capability: CapabilityName): boolean {
  return candidate.capabilities.includes(capability)
}

export function hasExplicitScore(candidate: ModelCandidate, capability: CapabilityName): boolean {
  return (candidate.scores[capability] ?? 0) > 0
}

/**
 * A candidate is compatible when it either declares the capability or carries
 * an explicit positive score for it.
 */
export function isCapabilityCompatible(candidate: ModelCandidate, capability: CapabilityName): boolean {
  return hasDeclaredCapability(candidate, capability) || hasExplicitScore(candidate, capability)
}

/**
 * A candidate is explicitly incompatible when it declares *some* capabilities,
 * does not declare the required one, and has no explicit score for it. Unknown
 * candidates (empty capabilities) are NOT incompatible: they stay eligible but
 * rank at lower confidence.
 */
export function isCapabilityIncompatible(candidate: ModelCandidate, capability: CapabilityName): boolean {
  return candidate.capabilities.length > 0
    && !hasDeclaredCapability(candidate, capability)
    && !hasExplicitScore(candidate, capability)
}

const COST_ORDER: Record<ModelCost, number> = { paid: 2, subscription: 1, free: 0 }

function compareCodepoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

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
    .filter((candidate) => candidate.cost !== "paid" || request.maxPaidCalls === undefined || (request.paidCallsUsed ?? 0) < request.maxPaidCalls)
    .map((candidate) => {
      const explicit = candidate.scores[request.capability] ?? 0
      const declared = hasDeclaredCapability(candidate, request.capability) ? 18 : 0
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
      return {
        candidate,
        score,
        reason,
        explicit,
        declared,
        frontierBonus,
        preferredCostBonus,
        preferredTierBonus,
        priceAdj,
      }
    })
    .sort((a, b) => b.score - a.score || compareCodepoints(a.candidate.id, b.candidate.id))

  const winner = ranked[0]
  if (!winner) return undefined

  const fallback = ranked
    .slice(1)
    .sort((a, b) => COST_ORDER[a.candidate.cost] - COST_ORDER[b.candidate.cost] || a.score - b.score || compareCodepoints(a.candidate.id, b.candidate.id))
    .map((item) => item.candidate.id)

  const matchedCapabilities: CapabilityName[] =
    winner.explicit || winner.declared ? [request.capability] : []

  // Deterministic reason code by dominant scoring signal, strongest first.
  let code: RoutingReasonCode
  let component: string
  if (winner.frontierBonus > 0) {
    code = "frontier"
    component = "frontier=" + winner.frontierBonus
  } else if (winner.preferredTierBonus > 0) {
    code = "preferred_tier"
    component = "tier=" + winner.candidate.tier
  } else if (winner.preferredCostBonus > 0) {
    code = "preferred_cost"
    component = "cost=" + winner.candidate.cost
  } else if (winner.explicit || winner.declared) {
    code = "capability_match"
    component = "capability=" + (winner.explicit ? "explicit" : "declared")
  } else if (winner.priceAdj !== 0) {
    code = "price"
    component = "price=" + winner.priceAdj
  } else {
    code = "priority"
    component = "priority=" + winner.candidate.priority
  }

  const routingReason: RoutingReason = {
    code,
    text: `id=${winner.candidate.id} cost=${winner.candidate.cost} ${component} score=${winner.score}`,
    matchedCapabilities,
    score: winner.score,
    budget: request.budget,
  }

  return {
    id: winner.candidate.id,
    score: winner.score,
    cost: winner.candidate.cost,
    ...(winner.candidate.priceInput !== undefined ? { priceInput: winner.candidate.priceInput } : {}),
    ...(winner.candidate.priceOutput !== undefined ? { priceOutput: winner.candidate.priceOutput } : {}),
    reason: winner.reason,
    fallback,
    routingReason,
  }
}
