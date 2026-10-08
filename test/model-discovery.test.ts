import assert from "node:assert/strict"
import test from "node:test"
import { orchestraConfigSchema } from "../src/config/schema.js"
import { applyDiscoveredModels, discoverConnectedModels } from "../src/routing/model-discovery.js"
import { resolveModel } from "../src/routing/model-resolver.js"
import { resolvePricingSync } from "../src/pricing/resolver.js"

test("missing and partial tariffs are never discovered as free", async () => {
  const models = await discoverConnectedModels({ provider: { list: async () => ({ data: {
    connected: ["vendor"], all: [{ id: "vendor", models: {
      unknown: { id: "unknown" }, partial: { id: "partial", cost: { input: 0 } },
      zero: { id: "zero", cost: { input: 0, output: 0 } },
    } }],
  } }) } })
  const [unknown, partial, free] = models
  assert.ok(unknown && typeof unknown !== "string")
  assert.ok(partial && typeof partial !== "string")
  assert.ok(free && typeof free !== "string")
  assert.equal(unknown.cost, "paid")
  assert.equal(partial.cost, "paid")
  assert.equal(partial.priceInput, undefined)
  assert.equal(free.cost, "free")
  assert.equal(resolveModel({ pool: [unknown, partial], capability: "code", budget: "eco", allowPaid: false }), undefined)
  assert.equal(resolvePricingSync({ id: unknown.id, declaredCost: unknown.cost }, { snapshot: { updatedAt: "2026-10", prices: {} } }).status, "unknown")
  const config = orchestraConfigSchema.parse({ orchestration: { taskBudget: { unknownPricing: "block" } } })
  assert.deepEqual(applyDiscoveredModels(config, models).models.worker.code, [free])
})

test("discovers only connected provider models and derives capabilities", async () => {
  const models = await discoverConnectedModels({
    provider: {
      list: async () => ({
        data: {
          connected: ["connected"],
          all: [
            {
              id: "connected",
              models: {
                smart: {
                  id: "smart",
                  reasoning: true,
                  tool_call: true,
                  cost: { input: 1, output: 2 },
                  limit: { context: 200_000, output: 64_000 },
                  modalities: { input: ["text", "image"], output: ["text"] },
                },
              },
            },
            { id: "offline", models: { ignored: { id: "ignored" } } },
          ],
        },
      }),
    },
  })

  assert.equal(models.length, 1)
  const model = models[0]
  if (!model) assert.fail("expected one discovered model")
  assert.equal(typeof model === "string" ? model : model.id, "connected/smart")
  assert.ok(typeof model !== "string" && model.capabilities.includes("reasoning"))
  assert.ok(typeof model !== "string" && model.capabilities.includes("vision"))
})

test("auto discovery fills only empty pools", () => {
  const config = orchestraConfigSchema.parse({ models: { lead: ["manual/lead"] } })
  const discovered = orchestraConfigSchema.parse({
    models: { worker: { code: ["auto/code"] } },
  }).models.worker.code
  const result = applyDiscoveredModels(config, discovered)

  assert.equal(result.models.lead[0], "manual/lead")
  assert.equal(result.models.worker.code[0], "auto/code")
})
