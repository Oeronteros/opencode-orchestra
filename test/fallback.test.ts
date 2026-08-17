import assert from "node:assert/strict"
import test from "node:test"
import type { ModelCandidateInput } from "../src/config/schema.js"
import {
  buildFallbackChain,
  classifyError,
  isRetryable,
  nextAfterFailure,
} from "../src/routing/fallback.js"
import { resolveModel } from "../src/routing/model-resolver.js"

const pool: ModelCandidateInput[] = [
  { id: "vendor/paid", cost: "paid", tier: "frontier", priority: 80, capabilities: ["code"], scores: { code: 10 }, priceInput: 3, priceOutput: 15 },
  { id: "vendor/cheap", cost: "paid", tier: "worker", priority: 50, capabilities: ["code"], scores: { code: 7 }, priceInput: 0.1, priceOutput: 0.4 },
  { id: "vendor/free", cost: "free", tier: "worker", priority: 55, capabilities: ["code"], scores: { code: 6 } },
]

test("classifyError detects rate-limit, timeout, and server errors", () => {
  assert.equal(classifyError({ status: 429, message: "rate limit" }).kind, "rate-limit")
  assert.equal(classifyError(new Error("exceeded rate limit")).kind, "rate-limit")
  assert.equal(classifyError({ status: 504, message: "timeout" }).kind, "timeout")
  assert.equal(classifyError({ status: 500 }).kind, "server")
  assert.equal(classifyError(new Error("syntax error")).kind, "other")
  assert.ok(isRetryable("rate-limit"))
  assert.ok(!isRetryable("other"))
});

test("resolveModel returns a cheaper-first fallback chain", () => {
  const resolved = resolveModel({ pool, capability: "code", budget: "quality", allowPaid: true })
  assert.ok(resolved)
  // fallback is ordered by cost: free (0) before subscription (1) before paid (2)
  const costOrder = { free: 0, subscription: 1, paid: 2 }
  const costs = resolved!.fallback.map((id) => {
    const entry = pool.find((p) => typeof p !== "string" && p.id === id) as { cost: string } | undefined
    return costOrder[entry?.cost as "free" | "subscription" | "paid"] ?? -1
  })
  for (let i = 1; i < costs.length; i++) assert.ok(costs[i - 1]! <= costs[i]!)
});

test("buildFallbackChain steps down in price after a failure", () => {
  const chain = buildFallbackChain(pool, "code", "quality", true)
  assert.ok(chain)
  assert.equal(chain!.all[0]!.id, chain!.primary)
  const next = nextAfterFailure(chain!, chain!.primary)
  assert.ok(next)
  // the alternative should be cheaper than the primary
  const primaryEntry = pool.find((p) => typeof p !== "string" && p.id === chain!.primary) as { cost: string } | undefined
  const nextEntry = pool.find((p) => typeof p !== "string" && p.id === next) as { cost: string } | undefined
  assert.ok(nextEntry)
  const rank = { paid: 2, subscription: 1, free: 0 }
  assert.ok(rank[nextEntry!.cost as keyof typeof rank] <= rank[primaryEntry!.cost as keyof typeof rank])
});

test("nextAfterFailure returns undefined when chain exhausted", () => {
  const chain = buildFallbackChain(pool, "code", "quality", true)!
  const last = chain.all[chain.all.length - 1]!.id
  assert.equal(nextAfterFailure(chain, last), undefined)
});
