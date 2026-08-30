import assert from "node:assert/strict"
import test from "node:test"
import {
  createOpenRouterCache,
  parseOpenRouterModels,
  toModelEntries,
  type OpenRouterModel,
} from "../src/pricing/openrouter.js"
import { matchModel } from "../src/pricing/model-match.js"

const MINI_PAYLOAD = JSON.stringify({
  data: [
    {
      id: "openai/gpt-4o-mini",
      canonical_slug: "openai/gpt-4o-mini-20240718",
      name: "OpenAI: GPT-4o mini",
      created: 1717348800,
      description: "x",
      context_length: 128000,
      pricing: {
        prompt: "0.00000015",
        completion: "0.0000006",
        input_cache_read: "0.000000075",
      },
    },
  ],
})

function fetchFixture(body: string, ok = true, status = 200): typeof fetch {
  return (async () => ({
    ok,
    status,
    text: async () => body,
  })) as unknown as typeof fetch
}

test("parses string token prices into USD per 1M", () => {
  const models = parseOpenRouterModels(MINI_PAYLOAD)
  assert.equal(models.length, 1)
  const model = models[0]!
  assert.equal(model.id, "openai/gpt-4o-mini")
  assert.equal(model.pricing.input, 0.15)
  assert.equal(model.pricing.output, 0.6)
  assert.equal(model.pricing.cacheRead, 0.075)
  assert.equal(model.pricing.reasoning, undefined)
  assert.equal(model.isFreeVariant, false)
})

test("survives missing and malformed pricing keys", () => {
  const models = parseOpenRouterModels(JSON.stringify({
    data: [
      { id: "vendor/bare", pricing: { prompt: "abc", completion: null } },
      { id: "vendor/empty", pricing: {} },
      { id: "vendor/negative", pricing: { prompt: "-0.1", completion: "0.0000002" } },
      { id: "not-a-model", pricing: undefined },
    ],
  }))
  assert.equal(models.length, 4)
  assert.equal(models[0]!.pricing.input, undefined)
  assert.equal(models[0]!.pricing.output, undefined)
  assert.equal(models[1]!.pricing.input, undefined)
  assert.equal(models[2]!.pricing.input, undefined)
  assert.equal(models[2]!.pricing.output, 0.2)
})

test("detects free variants from the :free suffix", () => {
  const models = parseOpenRouterModels(JSON.stringify({
    data: [{ id: "cohere/north-mini-code:free", pricing: { prompt: "0", completion: "0" } }],
  }))
  assert.equal(models[0]!.isFreeVariant, true)
  assert.equal(models[0]!.variant, "free")
  assert.equal(models[0]!.pricing.input, 0)
  assert.equal(models[0]!.pricing.output, 0)
})

test("keeps per-request prices in their own units", () => {
  const models = parseOpenRouterModels(JSON.stringify({
    data: [{ id: "vendor/media", pricing: { prompt: "0", completion: "0", request: "0.005", image: "0.001" } }],
  }))
  assert.equal(models[0]!.pricing.request, 0.005)
  assert.equal(models[0]!.pricing.image, 0.001)
  assert.equal(models[0]!.pricing.input, 0)
})

test("rejects malformed envelopes without throwing", () => {
  assert.deepEqual(parseOpenRouterModels("not json"), [])
  assert.deepEqual(parseOpenRouterModels(JSON.stringify({ prices: [] })), [])
  assert.deepEqual(parseOpenRouterModels(JSON.stringify({ data: "nope" })), [])
  assert.deepEqual(parseOpenRouterModels(JSON.stringify({ data: [{ id: 42 }] })), [])
})

test("cache fetches once, serves from memory, and refetches after TTL", async () => {
  let calls = 0
  let clock = 1_000_000
  const cache = createOpenRouterCache({
    ttlMs: 60_000,
    now: () => clock,
    fetchImpl: (async () => {
      calls += 1
      return { ok: true, status: 200, text: async () => MINI_PAYLOAD }
    }) as unknown as typeof fetch,
  })

  const first = await cache.getModels()
  assert.equal(first.length, 1)
  const second = await cache.getModels()
  assert.equal(calls, 1)
  assert.equal(second[0]!.pricing.input, 0.15)

  clock += 61_000
  await cache.getModels()
  assert.equal(calls, 2)
})

test("force refresh bypasses TTL", async () => {
  let calls = 0
  const cache = createOpenRouterCache({
    ttlMs: 60_000,
    fetchImpl: (async () => {
      calls += 1
      return { ok: true, status: 200, text: async () => MINI_PAYLOAD }
    }) as unknown as typeof fetch,
  })
  await cache.getModels()
  await cache.getModels(true)
  assert.equal(calls, 2)
})

test("concurrent calls share a single in-flight fetch", async () => {
  let calls = 0
  const cache = createOpenRouterCache({
    ttlMs: 60_000,
    fetchImpl: (async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { ok: true, status: 200, text: async () => MINI_PAYLOAD }
    }) as unknown as typeof fetch,
  })
  const [a, b] = await Promise.all([cache.getModels(), cache.getModels()])
  assert.equal(calls, 1)
  assert.equal(a.length, 1)
  assert.equal(b.length, 1)
})

test("failed fetch keeps the previous snapshot and records the error", async () => {
  let failing = false
  const cache = createOpenRouterCache({
    ttlMs: 60_000,
    fetchImpl: (async () => {
      if (failing) return { ok: false, status: 500, text: async () => "oops" }
      return { ok: true, status: 200, text: async () => MINI_PAYLOAD }
    }) as unknown as typeof fetch,
  })
  await cache.getModels()
  failing = true
  const models = await cache.getModels(true)
  assert.equal(models.length, 1)
  assert.equal(models[0]!.pricing.input, 0.15)
  assert.ok(cache.lastError)
})

test("offline cache with no snapshot yields an empty list, not a crash", async () => {
  const cache = createOpenRouterCache({
    ttlMs: 60_000,
    fetchImpl: fetchFixture("not json", false, 503),
  })
  const models = await cache.getModels()
  assert.deepEqual(models, [])
  assert.ok(cache.lastError)
})

test("cache exposes already-fetched models without refetching", async () => {
  let calls = 0
  const cache = createOpenRouterCache({
    ttlMs: 60_000,
    fetchImpl: (async () => {
      calls += 1
      return { ok: true, status: 200, text: async () => MINI_PAYLOAD }
    }) as unknown as typeof fetch,
  })
  const before = cache.cachedModels
  assert.equal(before, undefined)
  await cache.getModels()
  assert.equal(calls, 1)
  const cached = cache.cachedModels
  assert.equal(cached?.length, 1)
  assert.equal(cached?.[0]?.id, "openai/gpt-4o-mini")
  assert.equal(calls, 1)
})

test("toModelEntries builds a catalog matchModel can resolve wrapped ids against", () => {
  const models: OpenRouterModel[] = parseOpenRouterModels(MINI_PAYLOAD)
  const entries = toModelEntries(models)
  assert.equal(entries.length, 1)
  assert.equal(entries[0]!.id, "gpt-4o-mini")
  assert.equal(entries[0]!.provider, "openai")
  const match = matchModel("CX/GPT-4o mini", entries)
  assert.equal(match.canonical, "gpt-4o-mini")
  assert.equal(match.method, "exact")
})

test("toModelEntries exposes the canonical slug as an alias", () => {
  const models: OpenRouterModel[] = parseOpenRouterModels(MINI_PAYLOAD)
  const entries = toModelEntries(models)
  const match = matchModel("gpt-4o-mini-20240718", entries)
  assert.equal(match.canonical, "gpt-4o-mini")
  assert.equal(match.method, "alias")
})
