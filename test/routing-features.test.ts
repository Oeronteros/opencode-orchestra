import assert from "node:assert/strict"
import test from "node:test"
import { planTask, validatePlan } from "../src/routing/planner.js"
import { createBudgetGuard, paidBudgetFor } from "../src/routing/budget-guard.js"
import { createStreamObserver, scoreFinalText } from "../src/routing/observer.js"
import { createClassifierCache, fingerprint as cacheFingerprint } from "../src/routing/classifier-cache.js"
import type { Classification } from "../src/routing/classifier.js"

test("planner builds a dependency-aware DAG with a synthesis level", () => {
  const plan = planTask("security", [], { maxNodes: 6, dependencyAware: true })

  assert.ok(plan.levels.length >= 1)
  const first = plan.levels[0]
  assert.ok(first && first.length > 0)
  assert.ok(first && plan.maxParallel >= first.length)
  assert.deepEqual(validatePlan(plan), [])
  assert.equal(plan.nodes.at(-1)?.role, "merger")
  assert.equal(plan.nodes.at(-1)?.worker, "orch-merge")
  assert.deepEqual(plan.levels.at(-1), [plan.mergerNodeId])
  assert.ok(plan.nodes.at(-1)?.dependsOn.length)

  const ids = new Set(plan.nodes.map((n) => n.id))
  assert.equal(ids.size, plan.nodes.length)
})

test("planner flattens to a single level in greedy mode", () => {
  const plan = planTask("debug", [], { maxNodes: 4, dependencyAware: false, includeMerger: false })

  assert.equal(plan.levels.length, 1)
  for (const node of plan.nodes) assert.deepEqual(node.dependsOn, [])
  assert.deepEqual(validatePlan(plan), [])
})

test("planner respects the maxNodes cap", () => {
  const plan = planTask("research", ["review", "security", "ops"], { maxNodes: 3 })
  assert.ok(plan.nodes.length <= 3)
})

test("budget guard terminates a branch once paid allowance is burned", () => {
  const limit = paidBudgetFor("balanced", { maxPaidCalls: 2 })
  const guard = createBudgetGuard(limit)

  assert.equal(guard.remaining(), 2)
  assert.equal(guard.recordPaidCall("paid").terminated, false)
  assert.equal(guard.recordPaidCall("paid").terminated, true)
  assert.equal(guard.remaining(), 0)
})

test("budget guard ignores free and subscription calls", () => {
  const limit = paidBudgetFor("quality", { maxPaidCalls: 6 })
  const guard = createBudgetGuard(limit)

  guard.recordPaidCall("free")
  guard.recordPaidCall("subscription")
  assert.equal(guard.remaining(), 6)
  assert.equal(guard.recordPaidCall("paid").terminated, false)
})

test("paid budget derives tighter limits for eco and balanced", () => {
  assert.equal(paidBudgetFor("eco").maxPaidCalls, 0)
  assert.equal(paidBudgetFor("balanced").maxPaidCalls, 1)
  assert.ok(paidBudgetFor("ebobo").maxPaidCalls >= paidBudgetFor("quality").maxPaidCalls)
})

test("stream observer flags low confidence from hedging and disagreement", () => {
  const observer = createStreamObserver({ threshold: 0.6 })
  observer.push("I think this might be the cause, though I am not sure. ")
  const after = observer.push("The two reports contradict one another on the root cause.")

  assert.ok(after.flags.some((f) => f.includes("disagreement")))
})

test("stream observer needs minimum length before flagging", () => {
  const observer = createStreamObserver({ threshold: 0.9, minLength: 1000 })
  const observation = observer.push("maybe not sure perhaps")
  assert.equal(observation.lowConfidence, false)
})

test("scoreFinalText reports disagreement on a finished block", () => {
  const text = "The first worker says A, however the second explicitly disagrees and contradicts A."
  const observation = scoreFinalText(text)
  assert.ok(observation.flags.some((f) => f.includes("disagreement")))
})

test("classifier cache returns the same classification for near-duplicate tasks", () => {
  const cache = createClassifierCache()
  const classification: Classification = {
    profile: "debug",
    secondaryProfiles: ["security"],
    confidence: 0.8,
    matchedSignals: ["bug"],
    securityRelevant: true,
    critical: false,
  }
  cache.set("Fix the intermittent bug in auth", classification)

  const hit = cache.get("  fix the intermittent BUG in auth!!! ")
  assert.ok(hit)
  assert.equal(hit?.profile, "debug")
  assert.equal(cache.size(), 1)
})

test("classifier cache misses on genuinely different tasks", () => {
  const cache = createClassifierCache()
  cache.set("Fix the login bug", {
    profile: "debug", secondaryProfiles: [], confidence: 0.8, matchedSignals: ["bug"], securityRelevant: true, critical: false,
  })
  assert.equal(cache.get("Design a new dashboard"), undefined)
})

test("classifier cache evicts over its entry cap", () => {
  const cache = createClassifierCache({ maxEntries: 2 })
  const classification: Classification = {
    profile: "debug", secondaryProfiles: [], confidence: 0.5, matchedSignals: [], securityRelevant: false, critical: false,
  }
  cache.set("one", classification)
  cache.set("two", classification)
  cache.set("three", classification)
  assert.equal(cache.size(), 2)
  assert.equal(cache.get("one"), undefined)
})

test("fingerprints fold case and punctuation", () => {
  assert.equal(cacheFingerprint("Fix, the BUG!"), cacheFingerprint("fix the bug"))
})
