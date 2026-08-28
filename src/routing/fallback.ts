import type { BudgetMode, CapabilityName, ModelCandidateInput, ModelCost, ModelTier } from "../config/schema.js"
import {
  isCapabilityCompatible,
  isCapabilityIncompatible,
  normalizeCandidate,
  resolveModel,
  type ModelCandidate,
} from "./model-resolver.js"

// A fallback chain ranks the candidate models for a capability so that when a
// worker fails (429 / rate-limit / 5xx / timeout), the next attempt uses the
// next most-compatible candidate rather than re-hitting the one that failed.

export interface FallbackEntry {
  id: string
  cost: ModelCost
  /** Static cost-class rank: paid (2) > subscription (1) > free (0). */
  costRank: number
  /** True when the capability is declared or explicitly scored; false when unknown. */
  compatible: boolean
  priority: number
  tier: ModelTier
}

export interface FallbackChain {
  /** The winning model id (first choice). */
  primary: string
  /** Ordered alternatives after the primary (compatibility first). */
  alternatives: FallbackEntry[]
  /** All entries (primary + alternatives) in failover order. */
  all: FallbackEntry[]
}

const COST_RANK: Record<ModelCost, number> = { paid: 2, subscription: 1, free: 0 }

const TIER_RANK: Record<ModelTier, number> = { frontier: 2, lead: 1, worker: 0 }

/**
 * Budget-aware cost-class preference applied as the tie-break after priority
 * and tier. `ModelCost` is a closed union, so an unknown cost can never be
 * coerced into a cheaper class.
 */
const BUDGET_COST_PREFERENCE: Record<BudgetMode, ModelCost[]> = {
  eco: ["free", "subscription", "paid"],
  balanced: ["subscription", "free", "paid"],
  quality: ["subscription", "paid", "free"],
  ebobo: ["paid", "subscription", "free"],
}

function compareCodepoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function costPreferenceOrder(budget: BudgetMode, preferredCosts?: ModelCost[]): ModelCost[] {
  if (preferredCosts && preferredCosts.length > 0) return preferredCosts
  return BUDGET_COST_PREFERENCE[budget]
}

function costPreferenceRank(cost: ModelCost, order: ModelCost[]): number {
  const index = order.indexOf(cost)
  return index === -1 ? order.length : index
}

function isBudgetEligible(candidate: ModelCandidate, allowPaid: boolean, paidCallsUsed: number, maxPaidCalls?: number): boolean {
  if (candidate.cost !== "paid") return true
  if (!allowPaid) return false
  return maxPaidCalls === undefined || paidCallsUsed < maxPaidCalls
}

export type ErrorKind = "rate-limit" | "server" | "timeout" | "auth" | "invalid-request" | "other"

interface RetryableError {
  /** Retryable failures trigger failover; auth and invalid-request are terminal. */
  kind: ErrorKind
}

/**
 * Classify an error into policy categories. Only rate-limit, timeout, and
 * server failures are retryable; auth and invalid-request stop the chain.
 */
export function classifyError(error: unknown): RetryableError {
  const candidate = typeof error === "object" && error !== null ? error as { message?: unknown; status?: number; statusCode?: number } : undefined
  const message = typeof error === "string"
    ? error
    : candidate?.message
      ? String(candidate.message)
      : error instanceof Error
        ? error.message
        : String(error)
  const status = candidate?.status ?? candidate?.statusCode
  const text = (status !== undefined ? String(status) + " " : "") + message.toLowerCase()

  if (status === 401 || status === 403 || text.includes("unauthorized") || text.includes("forbidden") || text.includes("invalid api key") || text.includes("authentication")) {
    return { kind: "auth" }
  }
  if (status === 400 || status === 404 || text.includes("not found") || text.includes("bad request") || text.includes("invalid request")) {
    return { kind: "invalid-request" }
  }
  if (status === 429 || text.includes("429") || text.includes("rate limit") || text.includes("rate-limit") || text.includes("too many requests")) {
    return { kind: "rate-limit" }
  }
  if (status === 408 || text.includes("timeout") || text.includes("timed out")) {
    return { kind: "timeout" }
  }
  if ((status !== undefined && status >= 500) || text.includes("internal server error") || text.includes("service unavailable") || text.includes("overloaded")) {
    return { kind: "server" }
  }
  return { kind: "other" }
}

export function isRetryable(kind: RetryableError["kind"]): boolean {
  return kind === "rate-limit" || kind === "server" || kind === "timeout"
}

/**
 * Build a failover chain for a capability pool. The primary is the current
 * winner; alternatives are the remaining candidates ranked deterministically:
 * capability compatibility, then priority, tier, budget-aware cost class, and
 * model id. Explicitly incompatible candidates are excluded before resolution
 * so the primary is always compatible; unknown-capability candidates stay
 * eligible but rank below compatible ones. Budget filters (paid exclusion)
 * apply to alternatives as well as the primary.
 */
export function buildFallbackChain(
  pool: ModelCandidateInput[],
  capability: Parameters<typeof resolveModel>[0]["capability"],
  budget: BudgetMode,
  allowPaid: boolean,
  options: {
    preferredCosts?: ModelCost[]
    preferredTiers?: Parameters<typeof resolveModel>[0]["preferredTiers"]
    paidCallsUsed?: number
    maxPaidCalls?: number
  } = {},
): FallbackChain | undefined {
  const normalized = pool.map(normalizeCandidate)
  if (normalized.length === 0) return undefined

  // The primary must always be capability-compatible: drop explicitly
  // incompatible candidates before resolution so a high-priority incompatible
  // model (e.g. an ebobo frontier) cannot take the primary slot.
  const compatiblePool = normalized.filter((candidate) => !isCapabilityIncompatible(candidate, capability))
  if (compatiblePool.length === 0) return undefined

  const winner = resolveModel({
    pool: compatiblePool,
    capability,
    budget,
    allowPaid,
    ...(options.preferredCosts ? { preferredCosts: options.preferredCosts } : {}),
    ...(options.preferredTiers ? { preferredTiers: options.preferredTiers } : {}),
    ...(options.paidCallsUsed !== undefined ? { paidCallsUsed: options.paidCallsUsed } : {}),
    ...(options.maxPaidCalls !== undefined ? { maxPaidCalls: options.maxPaidCalls } : {}),
  })
  // If every compatible candidate was budget-excluded (e.g. an all-paid pool
  // under an eco budget or a fully exhausted paid cap), `resolveModel` has no
  // winner and there is no valid primary — never fail open to the first raw
  // pool entry, which could surface a paid model as primary.
  if (!winner) return undefined

  const primary = winner.id

  const paidCallsUsed = options.paidCallsUsed ?? 0
  const costOrder = costPreferenceOrder(budget, options.preferredCosts)

  const byId = new Map(compatiblePool.map((candidate) => [candidate.id, candidate]))
  const primaryCandidate = byId.get(primary)
  const primaryEntry = primaryCandidate ? toEntry(primaryCandidate, capability) : undefined
  const alternatives = compatiblePool
    .filter((candidate) => candidate.id !== primary)
    .filter((candidate) => isBudgetEligible(candidate, allowPaid, paidCallsUsed, options.maxPaidCalls))
    .sort((a, b) => {
      const compat = compatibilityTier(b, capability) - compatibilityTier(a, capability)
      if (compat !== 0) return compat
      if (a.priority !== b.priority) return b.priority - a.priority
      const tier = TIER_RANK[b.tier] - TIER_RANK[a.tier]
      if (tier !== 0) return tier
      const cost = costPreferenceRank(a.cost, costOrder) - costPreferenceRank(b.cost, costOrder)
      if (cost !== 0) return cost
      return compareCodepoints(a.id, b.id)
    })
    .map((candidate) => toEntry(candidate, capability))

  return {
    primary,
    alternatives,
    all: primaryEntry ? [primaryEntry, ...alternatives] : alternatives,
  }
}

function compatibilityTier(candidate: ModelCandidate, capability: CapabilityName): number {
  return isCapabilityCompatible(candidate, capability) ? 1 : 0
}

function toEntry(candidate: ModelCandidate, capability: CapabilityName): FallbackEntry {
  return {
    id: candidate.id,
    cost: candidate.cost,
    costRank: COST_RANK[candidate.cost],
    compatible: isCapabilityCompatible(candidate, capability),
    priority: candidate.priority,
    tier: candidate.tier,
  }
}

/**
 * Given a chain and the id of a model that just failed, return the next
 * alternative to try, or undefined when the chain is exhausted.
 */
export function nextAfterFailure(chain: FallbackChain, failedId: string): string | undefined {
  const index = chain.all.findIndex((entry) => entry.id === failedId)
  if (index < 0) return undefined
  return chain.all[index + 1]?.id
}
