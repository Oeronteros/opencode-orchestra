import assert from "node:assert/strict"
import test from "node:test"
import type { TaskContract } from "../src/orchestration/contracts.js"
import { OrchestrationRunState } from "../src/orchestration/run-state.js"
import { planTask } from "../src/routing/planner.js"

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
