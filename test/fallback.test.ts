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

test("classifyError detects auth and invalid-request as terminal", () => {
  assert.equal(classifyError({ status: 401 }).kind, "auth")
  assert.equal(classifyError({ status: 403, message: "forbidden" }).kind, "auth")
  assert.equal(classifyError(new Error("unauthorized")).kind, "auth")
  assert.equal(classifyError(new Error("invalid api key")).kind, "auth")
  assert.equal(classifyError(new Error("authentication failed")).kind, "auth")
  assert.equal(classifyError({ status: 400 }).kind, "invalid-request")
  assert.equal(classifyError({ status: 404, message: "not found" }).kind, "invalid-request")
  assert.equal(classifyError(new Error("bad request")).kind, "invalid-request")
  assert.equal(classifyError(new Error("invalid request")).kind, "invalid-request")
  assert.equal(classifyError({ status: 503 }).kind, "server")
  assert.equal(classifyError(new Error("service unavailable")).kind, "server")
});

test("isRetryable retries rate-limit, server, and timeout only", () => {
  assert.ok(isRetryable("rate-limit"))
  assert.ok(isRetryable("server"))
  assert.ok(isRetryable("timeout"))
  assert.ok(!isRetryable("auth"))
  assert.ok(!isRetryable("invalid-request"))
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

test("explicitly incompatible candidates are excluded from alternatives", () => {
  const visionPool: ModelCandidateInput[] = [
    { id: "vendor/vision", cost: "free", tier: "worker", priority: 50, capabilities: ["vision"], scores: { vision: 5 } },
    { id: "vendor/code-only", cost: "free", tier: "worker", priority: 90, capabilities: ["code"], scores: {} },
  ]
  const chain = buildFallbackChain(visionPool, "vision", "quality", true)!
  assert.equal(chain.primary, "vendor/vision")
  assert.deepEqual(chain.alternatives.map((entry) => entry.id), [])
});

test("unknown-capability candidates stay eligible but rank below compatible candidates", () => {
  const visionPool: ModelCandidateInput[] = [
    { id: "vendor/primary", cost: "paid", tier: "frontier", priority: 90, capabilities: ["vision"], scores: { vision: 10 } },
    { id: "vendor/compatible", cost: "paid", tier: "worker", priority: 50, capabilities: ["vision"], scores: {} },
    { id: "vendor/unknown", cost: "free", tier: "worker", priority: 50, capabilities: [], scores: {} },
  ]
  const chain = buildFallbackChain(visionPool, "vision", "quality", true)!
  const ids = chain.alternatives.map((entry) => entry.id)
  assert.ok(ids.includes("vendor/unknown"), "unknown candidate should stay eligible")
  assert.deepEqual(ids, ["vendor/compatible", "vendor/unknown"])
});

test("a compatible candidate outranks a cheaper, higher-priority unknown candidate", () => {
  const visionPool: ModelCandidateInput[] = [
    { id: "vendor/primary", cost: "paid", tier: "frontier", priority: 90, capabilities: ["vision"], scores: { vision: 10 } },
    { id: "vendor/compatible", cost: "paid", tier: "worker", priority: 40, capabilities: ["vision"], scores: {} },
    { id: "vendor/unknown", cost: "free", tier: "worker", priority: 60, capabilities: [], scores: {} },
  ]
  const chain = buildFallbackChain(visionPool, "vision", "quality", true)!
  assert.equal(chain.alternatives[0]!.id, "vendor/compatible")
});

test("FallbackEntry exposes compatible, priority, and tier metadata", () => {
  const visionPool: ModelCandidateInput[] = [
    { id: "vendor/primary", cost: "paid", tier: "frontier", priority: 90, capabilities: ["vision"], scores: { vision: 10 } },
    { id: "vendor/unknown", cost: "free", tier: "worker", priority: 55, capabilities: [], scores: {} },
  ]
  const chain = buildFallbackChain(visionPool, "vision", "quality", true)!
  const unknown = chain.all.find((entry) => entry.id === "vendor/unknown")!
  assert.equal(unknown.compatible, false)
  assert.equal(unknown.priority, 55)
  assert.equal(unknown.tier, "worker")
  assert.equal(unknown.cost, "free")
  assert.equal(unknown.costRank, 0)
  const primary = chain.all.find((entry) => entry.id === "vendor/primary")!
  assert.equal(primary.compatible, true)
  assert.equal(primary.tier, "frontier")
});

test("paid candidates are excluded from alternatives when paid is not allowed", () => {
  const codePool: ModelCandidateInput[] = [
    { id: "vendor/free", cost: "free", tier: "worker", priority: 50, capabilities: ["code"], scores: { code: 5 } },
    { id: "vendor/paid", cost: "paid", tier: "frontier", priority: 90, capabilities: ["code"], scores: { code: 10 } },
  ]
  const chain = buildFallbackChain(codePool, "code", "quality", false)!
  assert.equal(chain.primary, "vendor/free")
  assert.deepEqual(chain.alternatives.map((entry) => entry.id), [])
});

test("paid candidates are excluded from alternatives once the paid cap is reached", () => {
  const codePool: ModelCandidateInput[] = [
    { id: "vendor/free", cost: "free", tier: "worker", priority: 50, capabilities: ["code"], scores: { code: 5 } },
    { id: "vendor/paid", cost: "paid", tier: "frontier", priority: 90, capabilities: ["code"], scores: { code: 10 } },
  ]
  const chain = buildFallbackChain(codePool, "code", "quality", true, { paidCallsUsed: 2, maxPaidCalls: 2 })!
  assert.equal(chain.primary, "vendor/free")
  assert.deepEqual(chain.alternatives.map((entry) => entry.id), [])
});

test("an all-paid pool under an eco budget yields no fallback chain", () => {
  const codePool: ModelCandidateInput[] = [
    { id: "vendor/paid-frontier", cost: "paid", tier: "frontier", priority: 90, capabilities: ["code"], scores: { code: 10 } },
    { id: "vendor/paid-worker", cost: "paid", tier: "worker", priority: 50, capabilities: ["code"], scores: { code: 7 } },
  ]
  const chain = buildFallbackChain(codePool, "code", "eco", false)
  assert.equal(chain, undefined)
});

test("eco cost tie-break prefers free over paid at equal priority/tier/compatibility", () => {
  const codePool: ModelCandidateInput[] = [
    { id: "vendor/primary", cost: "free", tier: "frontier", priority: 95, capabilities: ["code"], scores: { code: 10 } },
    { id: "vendor/free-alt", cost: "free", tier: "worker", priority: 50, capabilities: ["code"], scores: {} },
    { id: "vendor/paid-alt", cost: "paid", tier: "worker", priority: 50, capabilities: ["code"], scores: {} },
  ]
  const chain = buildFallbackChain(codePool, "code", "eco", true)!
  assert.equal(chain.primary, "vendor/primary")
  assert.deepEqual(chain.alternatives.map((entry) => entry.id), ["vendor/free-alt", "vendor/paid-alt"])
});

test("balanced cost tie-break orders subscription, free, then paid", () => {
  const codePool: ModelCandidateInput[] = [
    { id: "vendor/primary", cost: "free", tier: "frontier", priority: 95, capabilities: ["code"], scores: { code: 10 } },
    { id: "vendor/free-alt", cost: "free", tier: "worker", priority: 50, capabilities: ["code"], scores: {} },
    { id: "vendor/sub-alt", cost: "subscription", tier: "worker", priority: 50, capabilities: ["code"], scores: {} },
    { id: "vendor/paid-alt", cost: "paid", tier: "worker", priority: 50, capabilities: ["code"], scores: {} },
  ]
  const chain = buildFallbackChain(codePool, "code", "balanced", true)!
  assert.equal(chain.primary, "vendor/primary")
  assert.deepEqual(chain.alternatives.map((entry) => entry.id), ["vendor/sub-alt", "vendor/free-alt", "vendor/paid-alt"])
});

test("an ebobo incompatible frontier never becomes primary", () => {
  const visionPool: ModelCandidateInput[] = [
    { id: "vendor/incompatible-frontier", cost: "paid", tier: "frontier", priority: 90, capabilities: ["reasoning"], scores: {} },
    { id: "vendor/compatible-worker", cost: "free", tier: "worker", priority: 50, capabilities: ["vision"], scores: { vision: 5 } },
  ]
  const chain = buildFallbackChain(visionPool, "vision", "ebobo", true)!
  assert.equal(chain.primary, "vendor/compatible-worker")
  assert.deepEqual(chain.alternatives.map((entry) => entry.id), [])
});

test("a fully incompatible pool yields no fallback chain", () => {
  const visionPool: ModelCandidateInput[] = [
    { id: "vendor/code-only", cost: "paid", tier: "frontier", priority: 90, capabilities: ["code"], scores: {} },
  ]
  const chain = buildFallbackChain(visionPool, "vision", "ebobo", true)
  assert.equal(chain, undefined)
});
