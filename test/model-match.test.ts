import assert from "node:assert/strict"
import test from "node:test"
import { matchModel, normalizeModelName, parseModelId, type ModelEntry } from "../src/pricing/model-match.js"

const GPT_SOL: ModelEntry = {
  id: "gpt-5-6-sol",
  aliases: ["GPT-5.6 Sol", "gpt 5.6 solar"],
}

const CLAUDE_45: ModelEntry = { id: "claude-sonnet-4-5", aliases: ["Claude Sonnet 4.5"] }

function entries(...list: ModelEntry[]): ModelEntry[] {
  return list
}

test("normalizeModelName folds case and separators", () => {
  assert.equal(normalizeModelName("GPT-5.6 Sol"), "gpt-5-6-sol")
  assert.equal(normalizeModelName("  gpt_5.6 sol  "), "gpt-5-6-sol")
  assert.equal(normalizeModelName("GPT-5.6-Sol"), "gpt-5-6-sol")
  assert.equal(normalizeModelName("custom-gpt-5.6-sol"), "custom-gpt-5-6-sol")
})

test("parseModelId splits provider on the first slash and exposes the variant", () => {
  assert.deepEqual(parseModelId("CX/GPT-5.6 Sol"), { provider: "cx", model: "gpt-5-6-sol", raw: "CX/GPT-5.6 Sol" })
  assert.deepEqual(parseModelId("gpt-5.6-sol"), { provider: "", model: "gpt-5-6-sol", raw: "gpt-5.6-sol" })
  assert.deepEqual(parseModelId("x:free"), { provider: "", model: "x", variant: "free", raw: "x:free" })
  assert.deepEqual(parseModelId("openai/gpt-5.6-sol:thinking"), {
    provider: "openai",
    model: "gpt-5-6-sol",
    variant: "thinking",
    raw: "openai/gpt-5.6-sol:thinking",
  })
})

test("wrapped and renamed ids resolve to one canonical model", () => {
  const catalog = entries(GPT_SOL)
  const expected = { canonical: "gpt-5-6-sol", method: "exact" }
  assert.deepEqual(matchModel("GPT-5.6 Sol", catalog), expected)
  assert.deepEqual(matchModel("CX/GPT-5.6 Sol", catalog), expected)
  assert.deepEqual(matchModel("OpenAI/GPT-5.6 Sol", catalog), expected)
  assert.deepEqual(matchModel("GPT-5.6-Sol", catalog), expected)
  assert.deepEqual(matchModel("gpt-5.6-sol", catalog), expected)
  assert.deepEqual(matchModel("proxy/GPT-5.6 Sol", catalog), expected)
})

test("wrapper namespaces are stripped down to the base model", () => {
  const catalog = entries(GPT_SOL)
  const match = matchModel("provider/custom-prefix/GPT-5.6 Sol", catalog)
  assert.equal(match.canonical, "gpt-5-6-sol")
  assert.equal(match.method, "exact")
})

test("gateway ids like anymodel/am/kimi-k3 resolve to the base model", () => {
  const catalog = entries({ id: "kimi-k3", aliases: ["MoonshotAI: Kimi K3"] })
  const match = matchModel("anymodel/am/kimi-k3", catalog)
  assert.equal(match.canonical, "kimi-k3")
  assert.equal(match.method, "exact")
})

test("aliases resolve when the alias normalizes differently from the canonical id", () => {
  const match = matchModel("GPT 5.6 Solar", entries(GPT_SOL))
  assert.equal(match.canonical, "gpt-5-6-sol")
  assert.equal(match.method, "alias")
})

test("variant suffixes do not block matching the base model", () => {
  const match = matchModel("gpt-5.6-sol:free", entries(GPT_SOL))
  assert.equal(match.canonical, "gpt-5-6-sol")
  assert.equal(match.method, "exact")
})

test("similar family members never collapse into one model", () => {
  const catalog = entries(
    { id: "gpt-5-6-mini" },
    { id: "gpt-5-6-pro" },
    GPT_SOL,
  )
  const match = matchModel("GPT-5.6", catalog)
  assert.equal(match.method, "none")
  assert.equal(match.familyAmbiguous, true)
})

test("family members still resolve individually with their discriminator", () => {
  const catalog = entries({ id: "gpt-5-6" }, { id: "gpt-5-6-mini" }, { id: "gpt-5-6-pro" }, GPT_SOL)
  assert.deepEqual(matchModel("GPT-5.6", catalog), { canonical: "gpt-5-6", method: "exact" })
  assert.equal(matchModel("GPT-5.6 Mini", catalog).canonical, "gpt-5-6-mini")
  assert.equal(matchModel("GPT-5.6 Pro", catalog).canonical, "gpt-5-6-pro")
  assert.equal(matchModel("GPT-5.6 Sol", catalog).canonical, "gpt-5-6-sol")
})

test("unknown model resolves to none without guessing", () => {
  const match = matchModel("brand-new-model", entries(GPT_SOL, CLAUDE_45))
  assert.equal(match.method, "none")
  assert.equal(match.canonical, "brand-new-model")
  assert.equal(match.familyAmbiguous, undefined)
})

test("empty normalized ids never keyword-match the catalog", () => {
  const match = matchModel("---", entries(GPT_SOL))
  assert.equal(match.method, "none")
  assert.equal(match.canonical, "")
})

test("fuzzy tier matches a close name when confident", () => {
  const match = matchModel("claude-sonnet-45", entries(CLAUDE_45))
  assert.equal(match.canonical, "claude-sonnet-4-5")
  assert.equal(match.method, "fuzzy")
  assert.ok(match.margin !== undefined)
})

test("fuzzy tier refuses when below the configured threshold", () => {
  const match = matchModel("claude-sonnet-45", entries(CLAUDE_45), { fuzzyThreshold: 0.99 })
  assert.equal(match.method, "none")
})

test("fuzzy tier refuses ambiguous close candidates", () => {
  const catalog = entries(
    { id: "claude-sonnet-4-5" },
    { id: "claude-sonnet-4-5x" },
  )
  const match = matchModel("claude-sonnet-45", catalog, { fuzzyThreshold: 0.7, fuzzyMargin: 0.05 })
  assert.equal(match.method, "none")
  assert.equal(match.familyAmbiguous, true)
})
