import assert from "node:assert/strict"
import test from "node:test"
import type { BudgetMode, CapabilityName, ModelCandidateInput } from "../src/config/schema.js"
import { resolveModel } from "../src/routing/model-resolver.js"

const pool: ModelCandidateInput[] = [
  {
    id: "vendor/free-code",
    cost: "free",
    tier: "worker",
    priority: 55,
    capabilities: ["code"],
    scores: { code: 7 },
  },
  {
    id: "vendor/paid-code",
    cost: "paid",
    tier: "frontier",
    priority: 80,
    capabilities: ["code"],
    scores: { code: 10 },
  },
]

test("eco mode prefers a capable free model", () => {
  const result = resolveModel({ pool, capability: "code", budget: "eco", allowPaid: true })

  assert.equal(result?.id, "vendor/free-code")
})

test("paid models are excluded when premium use is not allowed", () => {
  const result = resolveModel({ pool, capability: "code", budget: "quality", allowPaid: false })

  assert.equal(result?.id, "vendor/free-code")
})

test("paid models are excluded after the session cap", () => {
  const result = resolveModel({ pool, capability: "code", budget: "quality", allowPaid: true, paidCallsUsed: 2, maxPaidCalls: 2 })
  assert.equal(result?.id, "vendor/free-code")
})

test("returns undefined for an empty pool so OpenCode can preserve user defaults", () => {
  const result = resolveModel({ pool: [], capability: "reasoning", budget: "balanced", allowPaid: false })

  assert.equal(result, undefined)
})

test("ebobo mode prefers a frontier model regardless of price", () => {
  const result = resolveModel({ pool, capability: "code", budget: "ebobo", allowPaid: true })

  assert.equal(result?.id, "vendor/paid-code")
  assert.ok(result?.reason.some((reason) => reason.startsWith("frontier=")))
  assert.equal(result?.routingReason?.code, "frontier")
  assert.deepEqual(result?.routingReason?.matchedCapabilities, ["code"])
  assert.equal(result?.routingReason?.budget, "ebobo")
})

test("explicit capability scoring produces a capability_match reason", () => {
  const explicitPool: ModelCandidateInput[] = [
    { id: "vendor/a", cost: "free", tier: "worker", priority: 45, capabilities: ["reasoning"], scores: { reasoning: 8 } },
    { id: "vendor/b", cost: "free", tier: "worker", priority: 50, capabilities: ["reasoning"], scores: {} },
  ]
  const result = resolveModel({ pool: explicitPool, capability: "reasoning", budget: "balanced", allowPaid: true })

  assert.equal(result?.id, "vendor/a")
  assert.equal(result?.routingReason?.code, "capability_match")
  assert.deepEqual(result?.routingReason?.matchedCapabilities, ["reasoning"])
})

test("declared capabilities produce a capability_match reason", () => {
  const declaredPool: ModelCandidateInput[] = [
    { id: "vendor/declared", cost: "free", tier: "worker", priority: 45, capabilities: ["reasoning"], scores: {} },
    { id: "vendor/undeclared", cost: "free", tier: "worker", priority: 55, capabilities: [], scores: {} },
  ]
  const result = resolveModel({ pool: declaredPool, capability: "reasoning", budget: "balanced", allowPaid: true })

  assert.equal(result?.id, "vendor/declared")
  assert.equal(result?.routingReason?.code, "capability_match")
  assert.deepEqual(result?.routingReason?.matchedCapabilities, ["reasoning"])
})

test("a preferred tier produces a preferred_tier reason", () => {
  const tierPool: ModelCandidateInput[] = [
    { id: "vendor/lead", cost: "free", tier: "lead", priority: 70, capabilities: ["reasoning"], scores: {} },
    { id: "vendor/worker", cost: "free", tier: "worker", priority: 40, capabilities: ["reasoning"], scores: {} },
  ]
  const result = resolveModel({
    pool: tierPool,
    capability: "reasoning",
    budget: "balanced",
    allowPaid: true,
    preferredTiers: ["lead"],
  })

  assert.equal(result?.id, "vendor/lead")
  assert.equal(result?.routingReason?.code, "preferred_tier")
})

test("a preferred cost class produces a preferred_cost reason", () => {
  const costPool: ModelCandidateInput[] = [
    { id: "vendor/free", cost: "free", tier: "worker", priority: 40, capabilities: ["reasoning"], scores: {} },
    { id: "vendor/subscription", cost: "subscription", tier: "worker", priority: 40, capabilities: ["reasoning"], scores: {} },
  ]
  const result = resolveModel({
    pool: costPool,
    capability: "reasoning",
    budget: "balanced",
    allowPaid: true,
    preferredCosts: ["free"],
  })

  assert.equal(result?.id, "vendor/free")
  assert.equal(result?.routingReason?.code, "preferred_cost")
})

test("cheaper explicit pricing produces a price reason", () => {
  const pricePool: ModelCandidateInput[] = [
    { id: "vendor/cheap", cost: "free", tier: "worker", priority: 50, capabilities: [], scores: {}, priceInput: 1 },
    { id: "vendor/pricey", cost: "free", tier: "worker", priority: 50, capabilities: [], scores: {}, priceInput: 2 },
  ]
  const result = resolveModel({ pool: pricePool, capability: "code", budget: "quality", allowPaid: true })

  assert.equal(result?.id, "vendor/cheap")
  assert.equal(result?.routingReason?.code, "price")
})

test("priority is the reason when no stronger signal applies", () => {
  const priorityPool: ModelCandidateInput[] = [
    { id: "vendor/high", cost: "free", tier: "worker", priority: 80, capabilities: [], scores: {} },
    { id: "vendor/low", cost: "free", tier: "worker", priority: 30, capabilities: [], scores: {} },
  ]
  const result = resolveModel({ pool: priorityPool, capability: "code", budget: "balanced", allowPaid: true })

  assert.equal(result?.id, "vendor/high")
  assert.equal(result?.routingReason?.code, "priority")
})

test("a non-empty paid-only pool is undefined under a budget exclusion", () => {
  const paidPool: ModelCandidateInput[] = [
    { id: "vendor/paid-a", cost: "paid", tier: "frontier", priority: 80, capabilities: ["reasoning"], scores: {} },
    { id: "vendor/paid-b", cost: "paid", tier: "lead", priority: 70, capabilities: ["reasoning"], scores: {} },
  ]
  const result = resolveModel({ pool: paidPool, capability: "reasoning", budget: "quality", allowPaid: false })

  assert.equal(result, undefined)
})
