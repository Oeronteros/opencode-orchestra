import assert from "node:assert/strict"
import test from "node:test"
import {
  DEFAULT_PRICES,
  emptyPriceSnapshot,
  lookupPrice,
  combinedPrice,
} from "../src/routing/pricing/prices.js"
import { refreshPrices } from "../src/routing/pricing/refresh.js"
import { estimateCost, formatEstimateWarning, DEFAULT_TOKEN_ESTIMATES } from "../src/routing/pricing/estimate.js"
import { planTask } from "../src/routing/planner.js"
import type { ModelCandidateInput } from "../src/config/schema.js"

test("snapshot ships known prices and combinedPrice sums them", () => {
  const snapshot = emptyPriceSnapshot()
  assert.ok(snapshot.prices["anthropic/claude-sonnet-4-5"])
  const p = lookupPrice(snapshot, "anthropic/claude-sonnet-4-5")!
  assert.equal(combinedPrice(p), p.input + p.output)
});

test("lookupPrice tolerates case and bare model ids", () => {
  const snapshot = emptyPriceSnapshot()
  assert.ok(lookupPrice(snapshot, "ANTHROPIC/CLAUDE-SONNET-4-5"))
  assert.ok(lookupPrice(snapshot, "claude-sonnet-4-5"))
});

test("refreshPrices merges remote over snapshot and survives failure", async () => {
  const snapshot = emptyPriceSnapshot()
  const ok = await refreshPrices(snapshot, { endpoint: "http://x/prices", refreshIntervalHours: 1 }, (async () => {
    return { ok: true, text: async () => JSON.stringify({ updatedAt: "2027-01", prices: { "vendor/new": { input: 1, output: 2 } } }) }
  }) as unknown as typeof fetch)
  assert.ok(ok.lastRefreshedAt)
  assert.equal(ok.snapshot.prices["vendor/new"]!.input, 1)
  assert.deepEqual(ok.snapshot.prices["vendor/new"], { input: 1, output: 2 })
  // snapshot entries are preserved
  assert.ok(ok.snapshot.prices["anthropic/claude-sonnet-4-5"])

  const fail = await refreshPrices(snapshot, { endpoint: "http://x/prices", refreshIntervalHours: 1 }, (async () => {
    return { ok: false, status: 500, text: async () => "oops" }
  }) as unknown as typeof fetch)
  assert.ok(fail.lastError)
  assert.deepEqual(fail.snapshot, snapshot)
});

test("estimateCost sums worker/lead/judge and applies buffer", async () => {
  const pool: ModelCandidateInput[] = [
    { id: "vendor/paid", cost: "paid", tier: "lead", priority: 80, capabilities: ["code", "reasoning", "review"], scores: { code: 8, reasoning: 8, review: 8 }, priceInput: 5, priceOutput: 20 },
  ]
  const plan = planTask("debug", [], { maxNodes: 2 })
  const estimate = await estimateCost({
    budget: "quality",
    plan,
    workerPools: { code: pool, reasoning: pool, research: pool, vision: pool, image: pool },
    leadPool: pool,
    judgePool: pool,
    workerPoolOf: () => "code",
    snapshot: emptyPriceSnapshot(),
  })
  // Explicit candidate prices override the empty/default snapshot.
  assert.ok(estimate.total > 0)
  assert.ok(estimate.breakdown.workersCost > 0)
  assert.equal(estimate.breakdown.workers, plan.nodes.length)
  assert.equal(estimate.breakdown.unknownCalls, 0)
  assert.ok(estimate.breakdown.paidCalls > 0)
  assert.ok(estimate.summary.includes("quality"))
})

test("estimateCost excludes unknown-price calls from the total but counts them", async () => {
  const pool: ModelCandidateInput[] = [
    { id: "vendor/mystery", cost: "paid", tier: "worker", priority: 50, capabilities: [], scores: {} },
  ]
  const plan = planTask("debug", [], { maxNodes: 2 })
  const estimate = await estimateCost({
    budget: "quality",
    plan,
    workerPools: { code: pool, reasoning: [], research: [], vision: [], image: [] },
    leadPool: [],
    judgePool: [],
    workerPoolOf: () => "code",
    snapshot: { updatedAt: "2026-01", prices: {} },
  })
  assert.equal(estimate.total, 0)
  assert.equal(estimate.breakdown.workersCost, 0)
  assert.equal(estimate.breakdown.unknownCalls, plan.nodes.length)
  assert.ok(estimate.summary.includes("unknown"))
})

test("estimateCost reports free and subscription calls with zero cost", async () => {
  const freePool: ModelCandidateInput[] = [
    { id: "vendor/free", cost: "free", tier: "worker", priority: 50, capabilities: [], scores: {} },
  ]
  const subPool: ModelCandidateInput[] = [
    { id: "vendor/sub", cost: "subscription", tier: "lead", priority: 80, capabilities: [], scores: {} },
  ]
  const plan = planTask("debug", [], { maxNodes: 2 })
  const estimate = await estimateCost({
    budget: "quality",
    plan,
    workerPools: { code: freePool, reasoning: [], research: [], vision: [], image: [] },
    leadPool: subPool,
    judgePool: [],
    workerPoolOf: () => "code",
    snapshot: { updatedAt: "2026-01", prices: {} },
  })
  assert.equal(estimate.total, 0)
  assert.equal(estimate.breakdown.freeCalls, plan.nodes.length)
  assert.equal(estimate.breakdown.subscriptionCalls, 1)
  assert.equal(estimate.breakdown.unknownCalls, 0)
})

test("formatEstimateWarning triggers above threshold only", () => {
  const base = { total: 1.0, budget: "quality" as const, breakdown: { workers: 1, workersCost: 0, leadCost: 0, judgeCost: 0, subtotal: 1, total: 1.2, unknownCalls: 0, freeCalls: 0, subscriptionCalls: 0, paidCalls: 1 }, summary: "x" }
  assert.ok(formatEstimateWarning(base, 0.5))
  assert.equal(formatEstimateWarning({ ...base, total: 0.01 }, 0.5), undefined)
});
