import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { rankModels } from "../dashboard/src/lib/model-search.js"

const models = [
  "openai/gpt-5-mini",
  "openai/gpt-5.6-sol",
  "anthropic/claude-sonnet-4-5",
  "google/gemini-2.5-pro",
]

describe("rankModels", () => {
  it("matches model names without requiring the provider prefix", () => {
    assert.equal(rankModels(models, "claude sonnet")[0]?.id, "anthropic/claude-sonnet-4-5")
  })

  it("ranks exact and prefix matches before loose token matches", () => {
    assert.deepEqual(rankModels(models, "gpt 5").map((item) => item.id), [
      "openai/gpt-5-mini",
      "openai/gpt-5.6-sol",
    ])
  })

  it("matches providers and ignores case and separators", () => {
    assert.deepEqual(rankModels(models, "OPENAI").map((item) => item.id), [
      "openai/gpt-5-mini",
      "openai/gpt-5.6-sol",
    ])
    assert.equal(rankModels(models, "gemini_2 5")[0]?.id, "google/gemini-2.5-pro")
  })

  it("removes duplicates and returns no unrelated entries", () => {
    assert.equal(rankModels([...models, models[0]!], "gpt").length, 2)
    assert.deepEqual(rankModels(models, "llama"), [])
  })
})
