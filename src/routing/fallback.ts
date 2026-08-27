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
  /** Cost class rank: paid (2) > subscription (1) > free (0). */
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

function compareCodepoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
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
 * capability compatibility, then priority, tier, cost class, and model id.
 * Explicitly incompatible candidates are excluded; unknown-capability
 * candidates stay eligible but rank below compatible ones.
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

  const winner = resolveModel({
    pool,
    capability,
    budget,
    allowPaid,
    ...(options.preferredCosts ? { preferredCosts: options.preferredCosts } : {}),
    ...(options.preferredTiers ? { preferredTiers: options.preferredTiers } : {}),
    ...(options.paidCallsUsed !== undefined ? { paidCallsUsed: options.paidCallsUsed } : {}),
    ...(options.maxPaidCalls !== undefined ? { maxPaidCalls: options.maxPaidCalls } : {}),
  })
  const primary = winner?.id ?? normalized[0]?.id
  if (!primary) return undefined

  const byId = new Map(normalized.map((candidate) => [candidate.id, candidate]))
  const primaryCandidate = byId.get(primary)
  const primaryEntry = primaryCandidate ? toEntry(primaryCandidate, capability) : undefined
  const alternatives = normalized
    .filter((candidate) => candidate.id !== primary)
    .filter((candidate) => !isCapabilityIncompatible(candidate, capability))
    .sort((a, b) => {
      const compat = compatibilityTier(b, capability) - compatibilityTier(a, capability)
      if (compat !== 0) return compat
      if (a.priority !== b.priority) return b.priority - a.priority
      const tier = TIER_RANK[b.tier] - TIER_RANK[a.tier]
      if (tier !== 0) return tier
      const cost = COST_RANK[b.cost] - COST_RANK[a.cost]
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
