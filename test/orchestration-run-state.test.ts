import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import type { TaskContract } from "../src/orchestration/contracts.js"
import { OrchestrationRunState } from "../src/orchestration/run-state.js"
import { OrchestrationStateStore } from "../src/orchestration/state-store.js"
import { OrchestrationActionInbox } from "../src/orchestration/action-inbox.js"
import { planAdaptiveExtension } from "../src/orchestration/adaptive.js"
import { planTask, type TaskPlan } from "../src/routing/planner.js"

function contract(options: {
  resource?: string
  delegate?: boolean
  maxChildren?: number
  objective?: string
} = {}): TaskContract {
  return {
    objective: options.objective ?? "Inspect one bounded concern.",
    inputs: [],
    deliverable: "Evidence-backed result.",
    acceptanceCriteria: ["Report findings, assumptions, decisions, and blockers."],
    allowedPaths: [],
    exclusiveResources: options.resource ? [options.resource] : [],
    delegation: {
      allowed: options.delegate ?? false,
      maxChildren: options.maxChildren ?? (options.delegate ? 1 : 0),
    },
  }
}

function assertLease(result: Awaited<ReturnType<OrchestrationRunState["acquire"]>>) {
  if (!result.ok) assert.fail(result.error)
  return result.lease
}

test("tree-wide semaphore queues root workers and never exceeds its parallel cap", async () => {
  const state = new OrchestrationRunState({ maxWorkers: 8, parallelWorkers: 2, maxDelegationDepth: 2 })
  const first = assertLease(await state.acquire({ parentSessionID: "root", nodeId: "a", agent: "orch-repo", task: "a", contract: contract() }))
  const second = assertLease(await state.acquire({ parentSessionID: "root", nodeId: "b", agent: "orch-tests", task: "b", contract: contract() }))
  let thirdSettled = false
  const thirdPromise = state.acquire({ parentSessionID: "root", nodeId: "c", agent: "orch-docs", task: "c", contract: contract() })
    .then((result) => {
      thirdSettled = true
      return result
    })

  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(thirdSettled, false)
  assert.equal(state.snapshot("root")?.activeWorkers, 2)
  assert.equal(state.snapshot("root")?.queuedWorkers, 1)

  state.complete(first, true)
  const third = assertLease(await thirdPromise)
  assert.equal(state.snapshot("root")?.activeWorkers, 2)
  state.complete(second, true)
  state.complete(third, true)
  assert.equal(state.snapshot("root")?.activeWorkers, 0)
})

test("eight workers may run concurrently and the ninth waits", async () => {
  const state = new OrchestrationRunState({ maxWorkers: 12, parallelWorkers: 8, maxDelegationDepth: 2 })
  const leases = []
  for (let index = 0; index < 8; index += 1) {
    leases.push(assertLease(await state.acquire({
      parentSessionID: "root",
      nodeId: `worker-${index}`,
      agent: "orch-repo",
      task: `worker ${index}`,
      contract: contract(),
    })))
  }
  let ninthSettled = false
  const ninthPromise = state.acquire({ parentSessionID: "root", nodeId: "worker-8", agent: "orch-tests", task: "worker 8", contract: contract() })
    .then((result) => {
      ninthSettled = true
      return result
    })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(ninthSettled, false)
  assert.equal(state.snapshot("root")?.activeWorkers, 8)

  state.complete(leases.shift()!, true)
  const ninth = assertLease(await ninthPromise)
  assert.equal(state.snapshot("root")?.activeWorkers, 8)
  for (const lease of leases) state.complete(lease, true)
  state.complete(ninth, true)
})

test("total cap counts sequential workers in the same root tree", async () => {
  const state = new OrchestrationRunState({ maxWorkers: 2, parallelWorkers: 2, maxDelegationDepth: 2 })
  const first = assertLease(await state.acquire({ parentSessionID: "root", nodeId: "a", agent: "orch-repo", task: "a", contract: contract() }))
  state.complete(first, true)
  const second = assertLease(await state.acquire({ parentSessionID: "root", nodeId: "b", agent: "orch-tests", task: "b", contract: contract() }))
  state.complete(second, true)

  const denied = await state.acquire({ parentSessionID: "root", nodeId: "c", agent: "orch-docs", task: "c", contract: contract() })
  assert.equal(denied.ok, false)
  if (!denied.ok) assert.equal(denied.code, "total_limit")
  assert.equal(state.snapshot("root")?.totalStarted, 2)
})

test("cancelled requests and completed parents cannot launch workers", async () => {
  const state = new OrchestrationRunState({ maxWorkers: 8, parallelWorkers: 8, maxDelegationDepth: 2 })
  const request = { parentSessionID: "root", nodeId: "parent", agent: "orch-repo", task: "inspect", contract: contract({ delegate: true }) }
  const abort = new AbortController()
  abort.abort()
  const cancelled = await state.acquire({ ...request, signal: abort.signal })
  assert.equal(cancelled.ok, false)
  assert.equal(state.snapshot("root")?.totalStarted, 0)
  const lease = assertLease(await state.acquire(request))
  state.attachSession(lease, "child-session")
  state.complete(lease, true)
  const late = await state.acquire({ ...request, parentSessionID: "child-session", nodeId: "late", agent: "orch-tests" })
  assert.equal(late.ok, false)
  if (!late.ok) assert.equal(late.code, "delegation_denied")
})

test("nested work cannot consume budget reserved for sealed downstream nodes", async () => {
  const plan = planTask("debug", [], { maxNodes: 3 })
  const state = new OrchestrationRunState({ maxWorkers: plan.nodes.length, parallelWorkers: 8, maxDelegationDepth: 2 })
  state.registerPlan("root", plan)
  const node = plan.nodes[0]!
  const lease = assertLease(await state.acquire({ parentSessionID: "root", nodeId: node.id, agent: node.worker, task: node.description, contract: node.contract }))
  state.attachSession(lease, "child-session")
  const child = await state.acquire({ parentSessionID: "child-session", nodeId: "nested", agent: "orch-docs", task: "inspect", contract: contract() })
  assert.equal(child.ok, false)
  if (!child.ok) assert.equal(child.code, "total_limit")
  assert.equal(state.snapshot("root")?.nodes.length, plan.nodes.length)
  state.complete(lease, true)
})

test("integration requires validated completed editor commits", async () => {
  const state = new OrchestrationRunState({ maxWorkers: 8, parallelWorkers: 8, maxDelegationDepth: 2 })
  const plan = planTask("debug", [], { includeEvidence: false, editorPartitions: [{ id: "editor", description: "fix", ownership: ["src/**"] }] })
  state.registerPlan("root", plan)
  const editor = plan.nodes.find((node) => node.role === "editor")!
  const integrator = plan.nodes.find((node) => node.role === "integrator")!
  const request = (node: typeof editor) => ({ parentSessionID: "root", nodeId: node.id, agent: node.worker, task: node.description, contract: node.contract })
  const lease = assertLease(await state.acquire(request(editor)))
  assert.throws(() => state.recordValidatedCommit("root", editor.id, "abc1234"), /completed/)
  state.complete(lease, true)
  assert.equal((await state.acquire(request(integrator))).ok, false)
  state.recordValidatedCommit("root", editor.id, "abc1234")
  const integration = assertLease(await state.acquire(request(integrator)))
  state.complete(integration, true)
})

test("nested workers share limits, require contracts, and reject ancestry cycles", async () => {
  const state = new OrchestrationRunState({ maxWorkers: 8, parallelWorkers: 3, maxDelegationDepth: 3 })
  const parent = assertLease(await state.acquire({
    parentSessionID: "root",
    nodeId: "parent",
    agent: "orch-repo",
    task: "parent",
    contract: contract({ delegate: true }),
  }))
  state.attachSession(parent, "parent-session")

  const missing = await state.acquire({ parentSessionID: "parent-session", nodeId: "missing-contract", agent: "orch-tests", task: "child" })
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.code, "contract_required")

  const child = assertLease(await state.acquire({
    parentSessionID: "parent-session",
    nodeId: "child",
    agent: "orch-tests",
    task: "child",
    contract: contract({ delegate: true }),
  }))
  state.attachSession(child, "child-session")
  const cycle = await state.acquire({
    parentSessionID: "child-session",
    nodeId: "cycle",
    agent: "orch-repo",
    task: "cycle",
    contract: contract(),
  })
  assert.equal(cycle.ok, false)
  if (!cycle.ok) assert.equal(cycle.code, "delegation_cycle")

  state.complete(child, true)
  state.complete(parent, true)
})

test("depth cap and child budget are enforced before dispatch", async () => {
  const state = new OrchestrationRunState({ maxWorkers: 8, parallelWorkers: 3, maxDelegationDepth: 2 })
  const parent = assertLease(await state.acquire({ parentSessionID: "root", nodeId: "parent", agent: "orch-repo", task: "parent", contract: contract({ delegate: true }) }))
  state.attachSession(parent, "parent-session")
  const child = assertLease(await state.acquire({ parentSessionID: "parent-session", nodeId: "child", agent: "orch-tests", task: "child", contract: contract({ delegate: true }) }))
  state.attachSession(child, "child-session")

  const tooDeep = await state.acquire({ parentSessionID: "child-session", nodeId: "grandchild", agent: "orch-docs", task: "grandchild", contract: contract() })
  assert.equal(tooDeep.ok, false)
  if (!tooDeep.ok) assert.equal(tooDeep.code, "depth_limit")
  const secondChild = await state.acquire({ parentSessionID: "parent-session", nodeId: "second-child", agent: "orch-docs", task: "second", contract: contract() })
  assert.equal(secondChild.ok, false)
  if (!secondChild.ok) assert.equal(secondChild.code, "delegation_limit")

  state.complete(child, true)
  state.complete(parent, true)
})

test("exclusive resources have one active owner and release to the next root node", async () => {
  const state = new OrchestrationRunState({ maxWorkers: 8, parallelWorkers: 2, maxDelegationDepth: 2 })
  const first = assertLease(await state.acquire({ parentSessionID: "root", nodeId: "a", agent: "orch-tests", task: "a", contract: contract({ resource: "Browser:default" }) }))
  let secondSettled = false
  const secondPromise = state.acquire({ parentSessionID: "root", nodeId: "b", agent: "orch-security", task: "b", contract: contract({ resource: "browser:DEFAULT" }) })
    .then((result) => {
      secondSettled = true
      return result
    })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(secondSettled, false)

  state.complete(first, true)
  const second = assertLease(await secondPromise)
  state.complete(second, true)
})

test("sealed plan enforces contracts, dependencies, and failure propagation", async () => {
  const state = new OrchestrationRunState({ maxWorkers: 8, parallelWorkers: 8, maxDelegationDepth: 2 })
  const plan = planTask("debug", [], { maxNodes: 8 })
  state.registerPlan("root", plan)
  const firstLevel = plan.levels[0] ?? []
  const later = plan.nodes.find((node) => node.dependsOn.length > 0)!

  const early = await state.acquire({ parentSessionID: "root", nodeId: later.id, agent: later.worker, task: later.description, contract: later.contract })
  assert.equal(early.ok, false)
  if (!early.ok) assert.equal(early.code, "dependency_pending")

  const firstNode = plan.nodes.find((node) => node.id === firstLevel[0])!
  const changed = { ...firstNode.contract, deliverable: "Widened by caller" }
  const mismatch = await state.acquire({ parentSessionID: "root", nodeId: firstNode.id, agent: firstNode.worker, task: firstNode.description, contract: changed })
  assert.equal(mismatch.ok, false)
  if (!mismatch.ok) assert.equal(mismatch.code, "contract_mismatch")

  for (const id of firstLevel) {
    const node = plan.nodes.find((candidate) => candidate.id === id)!
    const lease = assertLease(await state.acquire({ parentSessionID: "root", nodeId: node.id, agent: node.worker, task: node.description, contract: node.contract }))
    state.complete(lease, id !== firstLevel[0])
  }
  const snapshot = state.snapshot("root")!
  assert.ok(snapshot.nodes.some((node) => node.status === "failed"))
  assert.ok(snapshot.nodes.some((node) => node.status === "blocked"))
  const blocked = await state.acquire({ parentSessionID: "root", nodeId: later.id, agent: later.worker, task: later.description, contract: later.contract })
  assert.equal(blocked.ok, false)
  if (!blocked.ok) assert.ok(["dependency_failed", "duplicate_node"].includes(blocked.code))
})

test("research swarm keeps cross-pollination behind the complete hypothesis round", async () => {
  const state = new OrchestrationRunState({ maxWorkers: 8, parallelWorkers: 8, maxDelegationDepth: 2 })
  const plan = planTask("research", ["review", "security"], {
    maxNodes: 8,
    includeJudge: true,
    researchSwarm: true,
    secondaryWorkers: ["orch-repo", "orch-tests"],
  })
  state.registerPlan("root", plan)
  const hypotheses = plan.nodes.filter((node) => node.id.startsWith("hypothesis-"))
  const refinement = plan.nodes.find((node) => node.id === "refinement-0")!
  const request = (node: typeof refinement) => ({
    parentSessionID: "root",
    nodeId: node.id,
    agent: node.worker,
    task: node.description,
    contract: node.contract,
  })

  for (const [index, node] of hypotheses.slice(0, -1).entries()) {
    const lease = assertLease(await state.acquire(request(node)))
    state.complete(lease, true, undefined, `hypothesis result ${index}`)
  }
  const early = await state.acquire(request(refinement))
  assert.equal(early.ok, false)
  if (!early.ok) assert.equal(early.code, "dependency_pending")

  const finalHypothesis = hypotheses.at(-1)!
  const finalLease = assertLease(await state.acquire(request(finalHypothesis)))
  state.complete(finalLease, true, undefined, "final hypothesis result")
  const sharedResults = state.dependencyOutputs("root", refinement.id)
  assert.equal(sharedResults.length, hypotheses.length)
  assert.deepEqual(sharedResults.map((result) => result.nodeId), hypotheses.map((node) => node.id))
  assert.match(sharedResults.at(-1)?.output ?? "", /final hypothesis result/)
  const refinementLease = assertLease(await state.acquire(request(refinement)))
  state.complete(refinementLease, true)
})

test("interrupted runs persist results and resume in a new session", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-runs-"))
  const limits = { maxWorkers: 8, parallelWorkers: 8, maxDelegationDepth: 2 }
  const firstContract = contract({ objective: "Find the cause." })
  const secondContract = contract({ objective: "Verify the cause." })
  const plan: TaskPlan = {
    nodes: [
      { id: "investigate", description: "Investigate", worker: "orch-repo", dependsOn: [], role: "specialist", contract: firstContract },
      { id: "verify", description: "Verify", worker: "orch-tests", dependsOn: ["investigate"], role: "reviewer", contract: secondContract },
    ],
    levels: [["investigate"], ["verify"]],
    maxParallel: 1,
  }
  const store = new OrchestrationStateStore(directory, ".orchestra/orchestration", true)
  try {
    const original = new OrchestrationRunState(limits, (snapshot) => store.schedule(snapshot))
    original.registerPlan("old-session", plan)
    const first = assertLease(await original.acquire({
      parentSessionID: "old-session", nodeId: "investigate", agent: "orch-repo", task: "Investigate", contract: firstContract,
    }))
    original.complete(first, true, undefined, "cause: stale cache")
    const interrupted = assertLease(await original.acquire({
      parentSessionID: "old-session", nodeId: "verify", agent: "orch-tests", task: "Verify", contract: secondContract,
    }))
    original.attachSession(interrupted, "lost-child-session")
    await store.flush()

    const restored = new OrchestrationRunState(limits)
    assert.equal(restored.restore(await store.load()), 1)
    const resumed = restored.resume("new-session", "old-session")
    assert.equal(restored.rootSessionID("new-session"), "old-session")
    assert.deepEqual(resumed.ready.map((node) => node.id), ["verify"])
    assert.deepEqual(resumed.ready[0]?.dependencyResults, [{ nodeId: "investigate", agent: "orch-repo", output: "cause: stale cache" }])
    assert.equal(resumed.run.activeWorkers, 0)
    assert.equal(resumed.run.nodes.find((node) => node.id === "verify")?.status, "pending")

    const retry = assertLease(await restored.acquire({
      parentSessionID: "new-session", nodeId: "verify", agent: "orch-tests", task: "Verify", contract: secondContract,
    }))
    assert.equal(retry.rootSessionID, "old-session")
    restored.complete(retry, true, undefined, "verified")
    assert.equal(restored.resumableRuns().length, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("completion claims remain distinct from runtime-verified completion", async () => {
  const state = new OrchestrationRunState({ maxWorkers: 8, parallelWorkers: 8, maxDelegationDepth: 2 })
  const lease = assertLease(await state.acquire({
    parentSessionID: "root", nodeId: "work", agent: "orch-tests", task: "work", contract: contract(),
  }))
  state.complete(lease, true, undefined, "done")
  state.setVerificationGates("root", [
    { id: "tests", label: "Unit tests", kind: "command", command: "npm test" },
    { id: "report", label: "Generated report", kind: "artifact", path: "out/report.json" },
  ])

  const early = state.claimCompletion("root", "finished")
  assert.equal(early.ok, false)
  assert.equal(early.completion.status, "claimed")
  assert.match(early.error ?? "", /pending/)

  assert.equal(state.recordCommandVerification("root", "npm test", false, "exit 1"), true)
  assert.equal(state.claimCompletion("root", "finished").completion.status, "failed")
  assert.equal(state.recordCommandVerification("root", "npm test", true, "10 tests passed"), true)
  assert.equal(state.recordArtifactVerification("root", "report", true, "out/report.json exists (12 bytes)."), true)
  const verified = state.claimCompletion("root", "finished")
  assert.equal(verified.ok, true)
  assert.equal(verified.completion.status, "verified")

  const restored = new OrchestrationRunState({ maxWorkers: 8, parallelWorkers: 8, maxDelegationDepth: 2 })
  restored.restore(state.exportState())
  assert.equal(restored.completion("root")?.status, "verified")
  assert.equal(restored.completion("root")?.gates.length, 2)
})

test("task budgets stop new work on cost, tokens, time, and unknown pricing", async () => {
  const plan = planTask("debug", [], { maxNodes: 3 })
  const makeState = () => {
    const state = new OrchestrationRunState({ maxWorkers: 8, parallelWorkers: 8, maxDelegationDepth: 2 })
    state.registerPlan("root", plan)
    return state
  }
  const request = (state: OrchestrationRunState) => {
    const node = plan.nodes[0]!
    return state.acquire({ parentSessionID: "root", nodeId: node.id, agent: node.worker, task: node.description, contract: node.contract })
  }

  const cost = makeState()
  cost.configureBudget("root", { maxCostUSD: 0.5, maxTokens: 0, maxMinutes: 0, unknownPricing: "warn" })
  assert.equal(cost.updateBudgetUsage("root", { costUSD: 0.5, tokens: 0, unknownPriceCalls: 0 })?.status, "exceeded")
  const costDenied = await request(cost)
  assert.equal(costDenied.ok, false)
  if (!costDenied.ok) assert.equal(costDenied.code, "budget_exceeded")

  const tokens = makeState()
  tokens.configureBudget("root", { maxCostUSD: 0, maxTokens: 100, maxMinutes: 0, unknownPricing: "warn" })
  assert.equal(tokens.updateBudgetUsage("root", { costUSD: 0, tokens: 100, unknownPriceCalls: 0 })?.status, "exceeded")

  const unknown = makeState()
  unknown.configureBudget("root", { maxCostUSD: 2, maxTokens: 0, maxMinutes: 0, unknownPricing: "block" })
  assert.equal(unknown.updateBudgetUsage("root", { costUSD: 0, tokens: 1, unknownPriceCalls: 1 })?.status, "exceeded")

  const timed = makeState()
  timed.configureBudget("root", { maxCostUSD: 0, maxTokens: 0, maxMinutes: 0.000001, unknownPricing: "warn" })
  await new Promise((resolve) => setTimeout(resolve, 2))
  assert.equal((await request(timed)).ok, false)

  const restored = makeState()
  restored.configureBudget("root", { maxCostUSD: 3, maxTokens: 500, maxMinutes: 15, unknownPricing: "warn" }, { costUSD: 2, tokens: 400 })
  restored.updateBudgetUsage("root", { costUSD: 1, tokens: 200, unknownPriceCalls: 0 })
  const replacement = new OrchestrationRunState({ maxWorkers: 8, parallelWorkers: 8, maxDelegationDepth: 2 })
  replacement.restore(restored.exportState())
  assert.equal(replacement.budget("root")?.actualCostUSD, 1)
  assert.equal(replacement.budget("root")?.limits.maxMinutes, 15)
})

test("dashboard actions cancel a branch and retry invalidates downstream results", async () => {
  const firstContract = contract()
  const secondContract = contract()
  const plan: TaskPlan = {
    nodes: [
      { id: "first", description: "first", worker: "orch-repo", dependsOn: [], role: "specialist", contract: firstContract },
      { id: "second", description: "second", worker: "orch-tests", dependsOn: ["first"], role: "reviewer", contract: secondContract },
    ],
    levels: [["first"], ["second"]], maxParallel: 1,
  }
  const state = new OrchestrationRunState({ maxWorkers: 8, parallelWorkers: 8, maxDelegationDepth: 2 })
  state.registerPlan("root", plan)
  const lease = assertLease(await state.acquire({ parentSessionID: "root", nodeId: "first", agent: "orch-repo", task: "first", contract: firstContract }))
  state.attachSession(lease, "child")
  const cancelled = state.cancelBranch("root", "first")
  assert.deepEqual(cancelled.affected, ["first", "second"])
  assert.deepEqual(cancelled.childSessionIDs, ["child"])
  assert.ok(cancelled.run.nodes.every((node) => node.status === "cancelled"))

  const retried = state.retryBranch("root", "first")
  assert.ok(retried.run.nodes.every((node) => node.status === "pending"))
  const retryLease = assertLease(await state.acquire({ parentSessionID: "root", nodeId: "first", agent: "orch-repo", task: "first", contract: firstContract }))
  state.complete(lease, true, undefined, "stale result")
  assert.equal(state.snapshot("root")?.nodes.find((node) => node.id === "first")?.status, "running")
  state.complete(retryLease, true, undefined, "new result")
  const downstream = assertLease(await state.acquire({ parentSessionID: "root", nodeId: "second", agent: "orch-tests", task: "second", contract: secondContract }))
  state.complete(downstream, true, undefined, "reviewed")
  assert.equal(state.snapshot("root")?.nodes.every((node) => node.status === "succeeded"), true)
})

test("action inbox processes each dashboard request once", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-actions-"))
  const seen: string[] = []
  const inbox = new OrchestrationActionInbox(directory, async (request) => { seen.push(request.requestId); return { affected: [request.nodeId] } })
  try {
    const actions = path.join(directory, "actions")
    await writeFile(path.join(directory, "placeholder"), "")
    await inbox.poll()
    await writeFile(path.join(actions, "request.json"), JSON.stringify({
      version: 1, requestId: "request", rootSessionID: "root", nodeId: "node", action: "cancel", requestedAt: Date.now(),
    }))
    await inbox.poll()
    await inbox.poll()
    assert.deepEqual(seen, ["request"])
    const result = JSON.parse(await readFile(path.join(actions, "request.result.json"), "utf8")) as { ok: boolean }
    assert.equal(result.ok, true)
  } finally {
    inbox.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test("adaptive extensions are versioned, evidence-triggered, and persisted", async () => {
  const state = new OrchestrationRunState({ maxWorkers: 6, parallelWorkers: 6, maxDelegationDepth: 2 })
  const initial: TaskPlan = {
    nodes: [{ id: "inspect", description: "inspect", worker: "orch-repo", dependsOn: [], role: "specialist", contract: contract() }],
    levels: [["inspect"]], maxParallel: 1,
  }
  assert.equal(state.registerPlan("root", initial).planVersion, 1)
  const lease = assertLease(await state.acquire({ parentSessionID: "root", nodeId: "inspect", agent: "orch-repo", task: "inspect", contract: initial.nodes[0]!.contract }))
  const before = state.progressFingerprint("root")
  state.complete(lease, true, undefined, "observed mismatch")
  assert.notEqual(state.progressFingerprint("root"), before)
  state.setVerificationGates("root", [{ id: "tests", label: "Tests", kind: "command", command: "npm test" }])
  state.recordCommandVerification("root", "npm test", true, "passed")
  assert.equal(state.claimCompletion("root", "initial complete").ok, true)

  const context = state.adaptiveContext("root")!
  const extension = planAdaptiveExtension({
    planVersion: context.planVersion,
    nodeIds: context.nodeIds,
    succeededNodeIds: context.succeededNodeIds,
    remainingSlots: context.remainingSlots,
    usedTriggers: context.triggers,
  }, [{ trigger: "contradictory_evidence", detail: "Two outputs disagree.", evidence: ["inspect: mismatch"] }])!
  const snapshot = state.extendPlan("root", extension, { reason: "Two outputs disagree.", trigger: "contradictory_evidence" })
  assert.equal(snapshot.planVersion, 2)
  assert.equal(snapshot.planChanges[1]?.trigger, "contradictory_evidence")
  assert.equal(snapshot.completion.status, "working")
  assert.equal(snapshot.completion.gates[0]?.status, "pending")
  assert.ok(extension.nodes.every((node) => node.id.startsWith("adapt-v2-")))

  const restored = new OrchestrationRunState({ maxWorkers: 6, parallelWorkers: 6, maxDelegationDepth: 2 })
  restored.restore(state.exportState())
  assert.equal(restored.snapshot("root")?.planVersion, 2)
  assert.equal(restored.adaptiveContext("root")?.triggers[0], "contradictory_evidence")
  assert.equal(planAdaptiveExtension({
    planVersion: 2, nodeIds: [], succeededNodeIds: [], remainingSlots: 2, usedTriggers: ["contradictory_evidence"],
  }, [{ trigger: "contradictory_evidence", detail: "same", evidence: ["same"] }]), undefined)
})
