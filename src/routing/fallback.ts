import type { BudgetMode, ModelCandidateInput, ModelCost } from "../config/schema.js"
import { normalizeCandidate, resolveModel, type ModelCandidate } from "./model-resolver.js"

// A fallback chain ranks the candidate models for a capability so that when a
// worker fails (429 / rate-limit / 5xx / timeout), the next attempt uses the
// next *cheaper* model rather than re-hitting the one that just failed.

export interface FallbackEntry {
  id: string
  cost: ModelCost
  /** Lower is cheaper; used to prefer cheaper fallbacks after a failure. */
  costRank: number
}

export interface FallbackChain {
  /** The winning model id (first choice). */
  primary: string
  /** Ordered cheaper alternatives after the primary. */
  alternatives: FallbackEntry[]
  /** All entries (primary + alternatives) in failover order. */
  all: FallbackEntry[]
}

const COST_RANK: Record<ModelCost, number> = { paid: 2, subscription: 1, free: 0 }

interface RetryableError {
  /** HTTP status or "timeout". Rate-limit (429) and 5xx are retryable. */
  kind: "rate-limit" | "server" | "timeout" | "other"
}

/**
 * Classify an error into retryable categories. A retryable failure should
 * trigger failover to a cheaper model in the chain.
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
 * winner; alternatives are the remaining candidates sorted by increasing cost
 * (cheaper first), so a retry steps down in price instead of up.
 */
export function buildFallbackChain(
  pool: ModelCandidateInput[],
  capability: Parameters<typeof resolveModel>[0]["capability"],
  budget: BudgetMode,
  allowPaid: boolean,
  options: {
    preferredCosts?: ModelCost[]
    preferredTiers?: Parameters<typeof resolveModel>[0]["preferredTiers"]
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
  })
  const primary = winner?.id ?? normalized[0]?.id
  if (!primary) return undefined

  const byId = new Map(normalized.map((candidate) => [candidate.id, candidate]))
  const primaryEntry = toEntry(byId.get(primary))
  const alternatives = normalized
    .filter((candidate) => candidate.id !== primary)
    .sort((a, b) => COST_RANK[a.cost] - COST_RANK[b.cost] || a.id.localeCompare(b.id))
    .map((candidate) => toEntry(candidate))

  return {
    primary,
    alternatives,
    all: primaryEntry ? [primaryEntry, ...alternatives] : alternatives,
  }
}

function toEntry(candidate: ModelCandidate | undefined): FallbackEntry {
  return {
    id: candidate?.id ?? "",
    cost: candidate?.cost ?? "free",
    costRank: COST_RANK[candidate?.cost ?? "free"],
  }
}

/**
 * Given a chain and the id of a model that just failed, return the next
 * cheaper alternative to try, or undefined when the chain is exhausted.
 */
export function nextAfterFailure(chain: FallbackChain, failedId: string): string | undefined {
  const index = chain.all.findIndex((entry) => entry.id === failedId)
  if (index < 0) return undefined
  return chain.all[index + 1]?.id
}
