import assert from "node:assert/strict"
import test from "node:test"
import { planTask, validatePlan } from "../src/routing/planner.js"
import { createBudgetGuard, paidBudgetFor } from "../src/routing/budget-guard.js"
import { createStreamObserver, scoreFinalText } from "../src/routing/observer.js"
import { createClassifierCache, fingerprint as cacheFingerprint } from "../src/routing/classifier-cache.js"
import type { Classification } from "../src/routing/classifier.js"
import { PROFILE_CATALOG } from "../src/profiles/catalog.js"

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
  assert.ok(plan.nodes.every((node) => node.contract.objective && node.contract.deliverable && node.contract.acceptanceCriteria.length > 0))
  assert.ok(plan.nodes.filter((node) => node.role === "specialist" || node.role === "reviewer").every((node) => node.contract.delegation.allowed && node.contract.delegation.maxChildren === 1))
  assert.deepEqual(plan.nodes.at(-1)?.contract.delegation, { allowed: false, maxChildren: 0 })

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

test("planner uses the profile catalog as its complete worker roster", () => {
  const plan = planTask("architecture", [], { maxNodes: 12 })
  const plannedWorkers = plan.nodes.filter((node) => node.role !== "merger").map((node) => node.worker).sort()
  assert.deepEqual(plannedWorkers, [...PROFILE_CATALOG.architecture.workers].sort())
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

test("planner adds isolated editor wave and deterministic integrator", () => {
  const plan = planTask("architecture", [], { maxNodes: 8, editorPartitions: [
    {
      id: "edit-api",
      description: "Implement API",
      ownership: ["src/api"],
      inputs: ["API design"],
      acceptanceCriteria: ["API tests pass"],
      exclusiveResources: ["api-test-database"],
      delegationMaxChildren: 1,
    },
    { id: "edit-ui", description: "Implement UI", ownership: ["src/ui"] },
  ] })
  assert.deepEqual(plan.levels.at(-2), ["edit-api", "edit-ui"])
  assert.equal(plan.nodes.find((node) => node.id === "edit-api")?.role, "editor")
  assert.deepEqual(plan.nodes.find((node) => node.id === "edit-api")?.contract, {
    objective: "Implement API",
    inputs: ["API design"],
    deliverable: "A committed implementation limited to the assigned ownership partition, with scoped verification evidence.",
    acceptanceCriteria: ["API tests pass"],
    allowedPaths: ["src/api"],
    exclusiveResources: ["api-test-database"],
    delegation: { allowed: true, maxChildren: 1 },
  })
  assert.deepEqual(plan.nodes.at(-1)?.dependsOn, ["edit-api", "edit-ui"])
  assert.equal(plan.nodes.at(-1)?.role, "integrator")
  assert.deepEqual(plan.nodes.at(-1)?.contract.delegation, { allowed: false, maxChildren: 0 })
  assert.deepEqual(validatePlan(plan), [])
})

test("planner rejects overlapping editor ownership", () => {
  const plan = planTask("architecture", [], { maxNodes: 8, editorPartitions: [
    { id: "a", description: "A", ownership: ["src"] },
    { id: "b", description: "B", ownership: ["src/api"] },
  ] })
  assert.ok(validatePlan(plan).some((problem) => problem.includes("ownership overlap")))
})

test("planner validates contract content, editor scope, and delegation bounds", () => {
  const plan = planTask("architecture", [], { maxNodes: 8, editorPartitions: [
    { id: "edit-api", description: "Implement API", ownership: ["src/api"] },
  ] })
  const specialist = plan.nodes.find((node) => node.role === "specialist")!
  const editor = plan.nodes.find((node) => node.role === "editor")!
  specialist.contract.objective = " "
  specialist.contract.deliverable = ""
  specialist.contract.acceptanceCriteria = []
  specialist.contract.delegation.maxChildren = -1
  editor.contract.allowedPaths = ["src/other"]

  const problems = validatePlan(plan)
  assert.ok(problems.some((problem) => problem.includes("empty contract objective")))
  assert.ok(problems.some((problem) => problem.includes("empty contract deliverable")))
  assert.ok(problems.some((problem) => problem.includes("empty contract acceptance criteria")))
  assert.ok(problems.some((problem) => problem.includes("negative delegation maxChildren")))
  assert.ok(problems.some((problem) => problem.includes("ownership does not match contract allowedPaths")))
})

test("planner rejects shared exclusive resources only for independent nodes", () => {
  const independent = planTask("debug", [], { maxNodes: 4, dependencyAware: false, includeMerger: false })
  independent.nodes[0]!.contract.exclusiveResources = ["shared-browser"]
  independent.nodes[1]!.contract.exclusiveResources = ["shared-browser"]
  assert.ok(validatePlan(independent).some((problem) => problem.includes("share exclusive resource shared-browser")))

  const dependent = planTask("security", [], { maxNodes: 6, dependencyAware: true })
  const specialist = dependent.nodes.find((node) => node.role === "specialist")!
  const merger = dependent.nodes.find((node) => node.role === "merger")!
  specialist.contract.exclusiveResources = ["shared-browser"]
  merger.contract.exclusiveResources = ["shared-browser"]
  assert.equal(validatePlan(dependent).some((problem) => problem.includes("share exclusive resource shared-browser")), false)
})
