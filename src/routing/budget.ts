import type { BudgetMode, ModelCost } from "../config/schema.js"

export interface BudgetPolicy {
  mode: BudgetMode
  freeBonus: number
  subscriptionBonus: number
  paidPenalty: number
  defaultWorkerCount: number
  judgePolicy: "rare" | "disagreement" | "always-for-critical"
}

const POLICIES: Record<BudgetMode, BudgetPolicy> = {
  eco: {
    mode: "eco",
    freeBonus: 80,
    subscriptionBonus: 20,
    paidPenalty: 200,
    defaultWorkerCount: 2,
    judgePolicy: "rare",
  },
  balanced: {
    mode: "balanced",
    freeBonus: 50,
    subscriptionBonus: 35,
    paidPenalty: 35,
    defaultWorkerCount: 3,
    judgePolicy: "disagreement",
  },
  quality: {
    mode: "quality",
    freeBonus: 15,
    subscriptionBonus: 25,
    paidPenalty: 5,
    defaultWorkerCount: 4,
    judgePolicy: "always-for-critical",
  },
  ebobo: {
    mode: "ebobo",
    freeBonus: 0,
    subscriptionBonus: 5,
    paidPenalty: 0,
    defaultWorkerCount: 12,
    judgePolicy: "always-for-critical",
  },
}

export function getBudgetPolicy(mode: BudgetMode): BudgetPolicy {
  return POLICIES[mode]
}

export function costAdjustment(cost: ModelCost, policy: BudgetPolicy): number {
  if (cost === "free") return policy.freeBonus
  if (cost === "subscription") return policy.subscriptionBonus
  return -policy.paidPenalty
}
