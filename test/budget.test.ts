import assert from "node:assert/strict"
import test from "node:test"
import { applyBudgetPreset } from "../src/config/defaults.js"
import { orchestraConfigSchema } from "../src/config/schema.js"
import { decideEscalation } from "../src/routing/escalation.js"
import { classifyTask } from "../src/routing/classifier.js"

test("ebobo preset maximizes orchestration and premium arbitration", () => {
  const config = applyBudgetPreset(orchestraConfigSchema.parse({ budget: "ebobo" }))

  assert.equal(config.orchestration.parallelWorkers, 8)
  assert.equal(config.orchestration.maxWorkers, 12)
  assert.equal(config.orchestration.premiumEscalation, true)
  assert.equal(config.orchestration.maxPremiumCallsPerTask, 5)
  assert.equal(config.orchestration.confidenceThreshold, 0.95)
})

test("eco judge requires both criticality and worker disagreement", () => {
  const config = orchestraConfigSchema.parse({ budget: "eco" })
  const classification = { ...classifyTask("critical production security incident"), critical: true }

  assert.equal(decideEscalation(config, { classification }).escalate, false)
  assert.equal(decideEscalation(config, { classification, consensus: 0.1 }).escalate, true)
})

test("budget presets apply to implicit defaults and preserve explicit caps", () => {
  assert.equal(applyBudgetPreset(orchestraConfigSchema.parse({ budget: "eco" })).orchestration.maxPremiumCallsPerTask, 0)
  assert.equal(applyBudgetPreset(orchestraConfigSchema.parse({ budget: "quality" })).orchestration.maxPremiumCallsPerTask, 6)
  assert.equal(applyBudgetPreset(orchestraConfigSchema.parse({ budget: "quality", orchestration: { maxPremiumCallsPerTask: 9 } })).orchestration.maxPremiumCallsPerTask, 9)
})

test("opaque classifier fallback alone does not request a judge", () => {
  const config = orchestraConfigSchema.parse({ budget: "balanced" })
  const classification = classifyTask("Please handle the requested change")
  assert.equal(classification.fallback, true)
  assert.equal(decideEscalation(config, { classification }).escalate, false)
})
