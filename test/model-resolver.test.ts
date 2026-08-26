import assert from "node:assert/strict"
import test from "node:test"
import type { ModelCandidateInput } from "../src/config/schema.js"
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
})
