import assert from "node:assert/strict"
import test from "node:test"
import { calcCost, type PricingResolution } from "../src/pricing/cost.js"

test("paid resolution prices input/output/reasoning/cache tokens", () => {
  const resolution: PricingResolution = {
    status: "paid",
    input: 1.25,
    output: 10,
    reasoning: 2,
    cacheRead: 0.1,
  }
  const result = calcCost(resolution, { input: 100_000, output: 20_000, reasoning: 5_000, cacheRead: 10_000 })
  // (100000*1.25 + 20000*10 + 5000*2 + 10000*0.1) / 1e6 = 336000/1e6
  assert.equal(result.cost, 0.336)
  assert.equal(result.inputTokens, 100_000)
  assert.equal(result.outputTokens, 20_000)
  assert.equal(result.reasoningTokens, 5_000)
  assert.equal(result.cacheReadTokens, 10_000)
  assert.equal(result.totalTokens, 135_000)
  assert.equal(result.pricingStatus, "paid")
})

test("free model counts tokens and costs zero", () => {
  const result = calcCost({ status: "free" }, { input: 12_000, output: 3_000 })
  assert.equal(result.cost, 0)
  assert.equal(result.totalTokens, 15_000)
  assert.equal(result.pricingStatus, "free")
})

test("subscription model costs zero but reports the subscription status", () => {
  const result = calcCost({ status: "subscription" }, { input: 12_000, output: 3_000 })
  assert.equal(result.cost, 0)
  assert.equal(result.totalTokens, 15_000)
  assert.equal(result.pricingStatus, "subscription")
})

test("unknown pricing keeps tokens and yields null cost", () => {
  const result = calcCost({ status: "unknown" }, { input: 12_000, output: 3_000 })
  assert.equal(result.cost, null)
  assert.equal(result.totalTokens, 15_000)
  assert.equal(result.pricingStatus, "unknown")
})

test("negative token counts are clamped to zero", () => {
  const result = calcCost({ status: "paid", input: 1, output: 1 }, { input: -5, output: 3 })
  assert.equal(result.inputTokens, 0)
  assert.equal(result.totalTokens, 3)
})

test("unknown pricing is never silently treated as free", () => {
  const unknown = calcCost({ status: "unknown" }, { input: 10, output: 10 })
  const free = calcCost({ status: "free" }, { input: 10, output: 10 })
  assert.notEqual(unknown.cost, free.cost)
  assert.notEqual(unknown.pricingStatus, free.pricingStatus)
})
