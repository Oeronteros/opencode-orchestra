import type { BudgetMode, ModelCost } from "../config/schema.js"

/** How much paid-model spend a single work branch is allowed before we cut it. */
export interface PaidBudgetLimit {
  /** Maximum paid-model calls a branch may make before termination. */
  maxPaidCalls: number
  /** Soft warning threshold (fraction of maxPaidCalls). */
  warnAt: number
  enabled: boolean
}

/**
 * Derive a paid-call budget for a branch of work from the global budget mode.
 * eco/balanced keep it tight (no or few paid calls); quality/ebobo open it up.
 *
 * "Early termination" here is budget-aware: a branch is stopped as soon as it
 * has burned its paid-call allowance, so paid models never silently overrun.
 */
export function paidBudgetFor(mode: BudgetMode, explicit?: Partial<PaidBudgetLimit>): PaidBudgetLimit {
  const base: Record<BudgetMode, Omit<PaidBudgetLimit, "enabled"> & { enabled: boolean }> = {
    eco: { maxPaidCalls: 0, warnAt: 0, enabled: false },
    balanced: { maxPaidCalls: 1, warnAt: 1, enabled: true },
    quality: { maxPaidCalls: 6, warnAt: 0.7, enabled: true },
    ebobo: { maxPaidCalls: 12, warnAt: 0.75, enabled: true },
  }
  const defaults = base[mode]
  return {
    ...defaults,
    ...explicit,
    enabled: (explicit?.enabled ?? defaults.enabled) && (explicit?.maxPaidCalls ?? defaults.maxPaidCalls) >= 0,
  }
}

export interface BudgetSnapshot {
  paidCallsUsed: number
  remaining: number
  terminated: boolean
  warning: boolean
}

export interface BudgetGuard {
  /** Record a paid call and report whether the branch should stop. */
  recordPaidCall(cost: ModelCost): BudgetSnapshot
  /** Current remaining paid-call allowance. */
  remaining(): number
  reset(): void
}

/**
 * Guard a single work branch. Only the costs of a *paid* model advance the
 * counter; free/subscription calls are free passes (mode already prices them
 * in elsewhere). Once paidCallsUsed reaches the cap the branch is terminated.
 */
export function createBudgetGuard(limit: PaidBudgetLimit): BudgetGuard {
  let paidCallsUsed = 0
  const cap = limit.maxPaidCalls
  const warnAt = Math.round(limit.warnAt * cap)

  const snapshot = (): BudgetSnapshot => {
    const remaining = Math.max(0, cap - paidCallsUsed)
    return {
      paidCallsUsed,
      remaining,
      terminated: cap > 0 && paidCallsUsed >= cap,
      warning: !limit.enabled ? false : cap > 0 && paidCallsUsed >= warnAt && paidCallsUsed < cap,
    }
  }

  return {
    recordPaidCall(cost) {
      if (cost === "paid") paidCallsUsed += 1
      return snapshot()
    },
    remaining: () => Math.max(0, cap - paidCallsUsed),
    reset() {
      paidCallsUsed = 0
    },
  }
}
