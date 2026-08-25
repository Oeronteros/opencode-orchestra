import assert from "node:assert/strict"
import test from "node:test"
import { resolvePricing, resolvePricingSync, type ModelAliasEntry } from "../src/pricing/resolver.js"
import { parseOpenRouterModels, type OpenRouterModel } from "../src/pricing/openrouter.js"
import type { PriceSnapshot } from "../src/routing/pricing/prices.js"

const SNAPSHOT: PriceSnapshot = {
  updatedAt: "2026-01",
  prices: {
    "openai/gpt-5-6-sol": { input: 1.25, output: 10 },
    "vendor/zero-model": { input: 0, output: 0 },
  },
}

const OPENROUTER_MODELS = parseOpenRouterModels(JSON.stringify({
  data: [
    { id: "vendor/gpt-5-6-sol", pricing: { prompt: "0.000002", completion: "0.00002" } },
    { id: "vendor/gpt-5-6-mini", pricing: { prompt: "0.0000001", completion: "0.000001" } },
    { id: "vendor/gpt-5-6-pro", pricing: { prompt: "0.00001", completion: "0.0001" } },
    { id: "vendor/m-free:free", pricing: { prompt: "0", completion: "0" } },
    { id: "vendor/media", pricing: { prompt: "0", completion: "0", image: "0.04" } },
    { id: "vendor/x-model", pricing: { prompt: "0.000009", completion: "0.000009" } },
  ],
}))

function openRouterDep(models: OpenRouterModel[] = OPENROUTER_MODELS) {
  return { getModels: async () => models }
}

test("provider snapshot price wins over OpenRouter", async () => {
  const result = await resolvePricing({ id: "CX/GPT-5.6 Sol" }, { snapshot: SNAPSHOT, openRouter: openRouterDep() })
  assert.equal(result.status, "paid")
  assert.equal(result.input, 1.25)
  assert.equal(result.output, 10)
  assert.equal(result.source, "snapshot")
  assert.equal(result.canonicalId, "gpt-5-6-sol")
  assert.equal(result.method, "exact")
})

test("falls back to OpenRouter when the snapshot has no price", async () => {
  const snapshot: PriceSnapshot = { updatedAt: "2026-01", prices: {} }
  const result = await resolvePricing({ id: "provider/custom-prefix/GPT-5.6 Sol" }, { snapshot, openRouter: openRouterDep() })
  assert.equal(result.status, "paid")
  assert.equal(result.input, 2)
  assert.equal(result.output, 20)
  assert.equal(result.source, "openrouter")
  assert.equal(result.canonicalId, "gpt-5-6-sol")
})

test("explicit configured price beats snapshot and OpenRouter", async () => {
  const result = await resolvePricing(
    { id: "openai/gpt-5-6-sol", explicitPrice: { input: 5, output: 20 } },
    { snapshot: SNAPSHOT, openRouter: openRouterDep() },
  )
  assert.equal(result.status, "paid")
  assert.equal(result.input, 5)
  assert.equal(result.output, 20)
  assert.equal(result.source, "config")
})

test("declared free models report free even when a snapshot price exists", async () => {
  const result = await resolvePricing(
    { id: "openai/gpt-5-6-sol", declaredCost: "free" },
    { snapshot: SNAPSHOT, openRouter: openRouterDep() },
  )
  assert.equal(result.status, "free")
  assert.equal(result.input, undefined)
  assert.equal(result.output, undefined)
})

test("declared subscription models are never priced", async () => {
  const result = await resolvePricing(
    { id: "openai/gpt-5-6-sol", declaredCost: "subscription" },
    { snapshot: SNAPSHOT, openRouter: openRouterDep() },
  )
  assert.equal(result.status, "subscription")
  assert.equal(result.input, undefined)
})

test("unknown model yields unknown status in sync and async resolution", async () => {
  const snapshot: PriceSnapshot = { updatedAt: "2026-01", prices: {} }
  const sync = resolvePricingSync({ id: "brand-new-model" }, { snapshot })
  assert.equal(sync.status, "unknown")
  assert.equal(sync.needsFallback, true)
  const result = await resolvePricing({ id: "brand-new-model" }, { snapshot, openRouter: openRouterDep() })
  assert.equal(result.status, "unknown")
  assert.equal(result.canonicalId, "brand-new-model")
})

test("similar models never pick a wrong price", async () => {
  const snapshot: PriceSnapshot = { updatedAt: "2026-01", prices: {} }
  const result = await resolvePricing({ id: "GPT-5.6" }, { snapshot, openRouter: openRouterDep() })
  assert.equal(result.status, "unknown")
})

test("config alias shadows a different OpenRouter model", async () => {
  const aliases: ModelAliasEntry[] = [{ canonical: "gpt-5-6-sol", aliases: ["x-model"] }]
  const result = await resolvePricing(
    { id: "x-model" },
    { snapshot: SNAPSHOT, aliases, openRouter: openRouterDep() },
  )
  assert.equal(result.status, "paid")
  assert.equal(result.input, 1.25)
  assert.equal(result.source, "snapshot")
  assert.equal(result.canonicalId, "gpt-5-6-sol")
})

test("OpenRouter free variant resolves as free", async () => {
  const snapshot: PriceSnapshot = { updatedAt: "2026-01", prices: {} }
  const result = await resolvePricing({ id: "vendor/m-free" }, { snapshot, openRouter: openRouterDep() })
  assert.equal(result.status, "free")
  assert.equal(result.source, "openrouter")
})

test("media model with zero token prices stays unknown, not free", async () => {
  const snapshot: PriceSnapshot = { updatedAt: "2026-01", prices: {} }
  const result = await resolvePricing({ id: "vendor/media" }, { snapshot, openRouter: openRouterDep() })
  assert.equal(result.status, "unknown")
})

test("zero snapshot price resolves as free", async () => {
  const result = await resolvePricing({ id: "zero-model" }, { snapshot: SNAPSHOT, openRouter: openRouterDep() })
  assert.equal(result.status, "free")
  assert.equal(result.source, "snapshot")
})

test("async resolution without an OpenRouter source stays unknown", async () => {
  const snapshot: PriceSnapshot = { updatedAt: "2026-01", prices: {} }
  const result = await resolvePricing({ id: "vendor/gpt-5-6-sol" }, { snapshot })
  assert.equal(result.status, "unknown")
  assert.equal(result.needsFallback, true)
})

test("OpenRouter paid model carries reasoning and cache prices", async () => {
  const models = parseOpenRouterModels(JSON.stringify({
    data: [
      {
        id: "vendor/reasoner",
        pricing: {
          prompt: "0.000001",
          completion: "0.00001",
          internal_reasoning: "0.000002",
          input_cache_read: "0.0000001",
        },
      },
    ],
  }))
  const result = await resolvePricing(
    { id: "reasoner" },
    { snapshot: { updatedAt: "2026-01", prices: {} }, openRouter: { getModels: async () => models } },
  )
  assert.equal(result.status, "paid")
  assert.equal(result.input, 1)
  assert.equal(result.output, 10)
  assert.equal(result.reasoning, 2)
  assert.equal(result.cacheRead, 0.1)
})

test("a raw :free id never takes the canonical paid price", async () => {
  const result = await resolvePricing(
    { id: "openai/gpt-5-6-sol:free" },
    { snapshot: SNAPSHOT, openRouter: openRouterDep() },
  )
  assert.equal(result.status, "free")
  assert.equal(result.input, undefined)
})
