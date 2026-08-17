import assert from "node:assert/strict"
import test from "node:test"
import { orchestraConfigSchema } from "../src/config/schema.js"
import { applyDiscoveredModels, discoverConnectedModels } from "../src/routing/model-discovery.js"

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
