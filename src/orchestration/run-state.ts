import type { TaskContract } from "./contracts.js"
import type { PlanNode, TaskPlan } from "../routing/planner.js"

export type RunNodeStatus = "pending" | "queued" | "running" | "succeeded" | "failed" | "blocked" | "cancelled"

export interface RunLimits {
  /** Maximum logical worker calls in one root orchestration tree. */
  maxWorkers: number
  /** Maximum worker calls executing at once. The primary lead is not counted. */
  parallelWorkers: number
  /** Lead is depth 0, its workers are depth 1. */
  maxDelegationDepth: number
}

export interface DispatchRequest {
  parentSessionID: string
  nodeId: string
  agent: string
  task: string
  contract?: TaskContract
  signal?: AbortSignal
}

export interface RunNodeSnapshot {
  id: string
  agent: string
  status: RunNodeStatus
  depth: number
  parentNodeId?: string
  dependsOn: string[]
  exclusiveResources: string[]
  error?: string
}

export interface RunSnapshot {
  rootSessionID: string
  activeWorkers: number
  queuedWorkers: number
  totalStarted: number
  limits: RunLimits
  nodes: RunNodeSnapshot[]
}

export interface DispatchLease {
  rootSessionID: string
  nodeId: string
  depth: number
  contract: TaskContract
}

export type AcquireResult =
  | { ok: true; lease: DispatchLease; snapshot: RunSnapshot }
  | { ok: false; code: "unknown_node" | "agent_mismatch" | "contract_required" | "contract_mismatch" | "duplicate_node" | "dependency_pending" | "dependency_failed" | "total_limit" | "parallel_limit" | "depth_limit" | "delegation_denied" | "delegation_limit" | "delegation_cycle" | "resource_busy" | "cancelled"; error: string; snapshot: RunSnapshot }

type DeniedResult = Extract<AcquireResult, { ok: false }>

interface MutableRunNode {
  id: string
  agent: string
  role?: PlanNode["role"]
  status: RunNodeStatus
  depth: number
  parentNodeId?: string
  dependsOn: string[]
  contract: TaskContract
  baseRevision?: string
  validatedCommit?: string
  currentSessionID?: string
  childrenStarted: number
  active: boolean
  error?: string
}

interface PendingDispatch {
  node: MutableRunNode
  resolve: (result: AcquireResult) => void
  abort?: () => void
}

interface RunState {
  rootSessionID: string
  planRegistered: boolean
  nodes: Map<string, MutableRunNode>
  activeWorkers: number
  totalStarted: number
  resources: Map<string, string>
  queue: PendingDispatch[]
  touchedAt: number
}

const MAX_RUNS = 128

function normalizeResource(value: string): string {
  return value.trim().toLocaleLowerCase("en-US")
}

function cloneContract(contract: TaskContract): TaskContract {
  return {
    objective: contract.objective,
    inputs: [...contract.inputs],
    deliverable: contract.deliverable,
    acceptanceCriteria: [...contract.acceptanceCriteria],
    allowedPaths: [...contract.allowedPaths],
    exclusiveResources: [...contract.exclusiveResources],
    delegation: { ...contract.delegation },
  }
}

function contractsEqual(left: TaskContract, right: TaskContract): boolean {
  const sameArray = (a: string[], b: string[]) => a.length === b.length && a.every((value, index) => value === b[index])
  return left.objective === right.objective
    && sameArray(left.inputs, right.inputs)
    && left.deliverable === right.deliverable
    && sameArray(left.acceptanceCriteria, right.acceptanceCriteria)
    && sameArray(left.allowedPaths, right.allowedPaths)
    && sameArray(left.exclusiveResources, right.exclusiveResources)
    && left.delegation.allowed === right.delegation.allowed
    && left.delegation.maxChildren === right.delegation.maxChildren
}

function fallbackContract(task: string, canDelegate: boolean): TaskContract {
  return {
    objective: task.trim(),
    inputs: [],
    deliverable: "Return an evidence-backed result to the direct parent.",
    acceptanceCriteria: ["Separate verified findings, assumptions, decisions, and blockers."],
    allowedPaths: [],
    exclusiveResources: [],
    delegation: { allowed: canDelegate, maxChildren: canDelegate ? 1 : 0 },
  }
}

function fromPlanNode(node: PlanNode): MutableRunNode {
  return {
    id: node.id,
    agent: node.worker,
    role: node.role,
    status: "pending",
    depth: 1,
    dependsOn: [...node.dependsOn],
    contract: cloneContract(node.contract),
    ...(node.worktree?.baseRevision ? { baseRevision: node.worktree.baseRevision } : {}),
    childrenStarted: 0,
    active: false,
  }
}

/**
 * In-memory execution registry shared by every Orchestra dispatcher in one
 * plugin instance. It turns prompt-level limits into an enforced tree-wide
 * budget and keeps parent/child sessions attached to the same root run.
 */
export class OrchestrationRunState {
  private readonly runs = new Map<string, RunState>()
  private readonly sessions = new Map<string, { rootSessionID: string; nodeId: string }>()

  constructor(private readonly limits: RunLimits) {}

  registerPlan(rootSessionID: string, plan: TaskPlan): RunSnapshot {
    const current = this.runs.get(rootSessionID)
    if (current && current.totalStarted > 0 && [...current.nodes.values()].some((node) => node.status === "pending")) {
      throw new Error("Cannot replace a started plan with unfinished nodes; complete the sealed plan first.")
    }
    if (current && (current.activeWorkers > 0 || current.queue.length > 0)) {
      throw new Error("Cannot replace an orchestration plan while its workers are active.")
    }
    if (plan.nodes.length > this.limits.maxWorkers) {
      throw new Error(`Plan has ${plan.nodes.length} nodes but maxWorkers is ${this.limits.maxWorkers}.`)
    }
    const nodes = new Map<string, MutableRunNode>()
    for (const planNode of plan.nodes) {
      if (nodes.has(planNode.id)) throw new Error(`Duplicate plan node ${planNode.id}.`)
      nodes.set(planNode.id, fromPlanNode(planNode))
    }
    const run: RunState = {
      rootSessionID,
      planRegistered: true,
      nodes,
      activeWorkers: 0,
      totalStarted: 0,
      resources: new Map(),
      queue: [],
      touchedAt: Date.now(),
    }
    for (const [sessionID, link] of this.sessions) {
      if (link.rootSessionID === rootSessionID) this.sessions.delete(sessionID)
    }
    this.runs.set(rootSessionID, run)
    this.pruneRuns()
    return this.snapshotForRun(run)
  }

  extendPlan(rootSessionID: string, plan: TaskPlan): RunSnapshot {
    const run = this.runs.get(this.rootSessionID(rootSessionID))
    if (!run) return this.registerPlan(rootSessionID, plan)
    if (run.activeWorkers > 0 || run.queue.length > 0) {
      throw new Error("Cannot extend an orchestration plan while its workers are active.")
    }
    const reserved = [...run.nodes.values()].filter((node) => node.status === "pending").length
    if (run.totalStarted + reserved + plan.nodes.length > this.limits.maxWorkers) {
      throw new Error(`Extended plan would exceed maxWorkers=${this.limits.maxWorkers}.`)
    }
    for (const planNode of plan.nodes) {
      if (run.nodes.has(planNode.id)) throw new Error(`Duplicate plan node ${planNode.id}.`)
    }
    for (const planNode of plan.nodes) run.nodes.set(planNode.id, fromPlanNode(planNode))
    run.planRegistered = true
    run.touchedAt = Date.now()
    return this.snapshotForRun(run)
  }

  async acquire(request: DispatchRequest): Promise<AcquireResult> {
    const parentLink = this.sessions.get(request.parentSessionID)
    const rootSessionID = parentLink?.rootSessionID ?? request.parentSessionID
    const run = this.runs.get(rootSessionID) ?? this.createAdHocRun(rootSessionID)
    run.touchedAt = Date.now()
    const parent = parentLink ? run.nodes.get(parentLink.nodeId) : undefined
    if (request.signal?.aborted) return this.denied(run, "cancelled", "Dispatch was already cancelled.")
    if (parentLink && (!parent || parent.status !== "running" || parent.currentSessionID !== request.parentSessionID)) {
      return this.denied(run, "delegation_denied", "Only the current running parent session may delegate.")
    }

    const prepared = this.prepareNode(run, request, parent)
    if (!prepared.ok) return prepared
    const node = prepared.node

    const dependencyProblem = this.checkDependencies(run, node)
    if (dependencyProblem) return dependencyProblem

    const reserved = parent && run.planRegistered
      ? [...run.nodes.values()].filter((candidate) => candidate.status === "pending" && candidate !== node && !candidate.parentNodeId).length
      : 0
    if (run.totalStarted + reserved >= this.limits.maxWorkers) {
      if (!run.planRegistered || parent) run.nodes.delete(node.id)
      return this.denied(run, "total_limit", `maxWorkers=${this.limits.maxWorkers} is exhausted for this orchestration tree.`)
    }

    run.totalStarted += 1
    if (parent) parent.childrenStarted += 1

    const resourceOwner = this.busyResourceOwner(run, node)
    const capacityAvailable = run.activeWorkers < this.limits.parallelWorkers
    if (capacityAvailable && !resourceOwner) return this.start(run, node)

    // A running worker waiting for a queued child can deadlock the whole pool.
    // Nested dispatch therefore fails fast; the parent can continue itself or
    // retry after another branch completes. Root-level branches remain queued.
    if (parent) {
      this.undoReservation(run, node, parent)
      return resourceOwner
        ? this.denied(run, "resource_busy", `Exclusive resource ${resourceOwner.resource} is owned by ${resourceOwner.owner}.`)
        : this.denied(run, "parallel_limit", `parallelWorkers=${this.limits.parallelWorkers} is full; nested dispatch was not queued to avoid deadlock.`)
    }

    node.status = "queued"
    return new Promise<AcquireResult>((resolve) => {
      const pending: PendingDispatch = { node, resolve }
      if (request.signal) {
        const abort = () => {
          const index = run.queue.indexOf(pending)
          if (index < 0) return
          run.queue.splice(index, 1)
          run.totalStarted = Math.max(0, run.totalStarted - 1)
          node.status = "cancelled"
          node.error = "Dispatch cancelled while waiting for a worker slot."
          pending.abort?.()
          this.blockFailedDependants(run)
          resolve(this.denied(run, "cancelled", node.error))
        }
        pending.abort = () => request.signal?.removeEventListener("abort", abort)
        request.signal.addEventListener("abort", abort, { once: true })
      }
      run.queue.push(pending)
    })
  }

  attachSession(lease: DispatchLease, childSessionID: string): void {
    const run = this.runs.get(lease.rootSessionID)
    const node = run?.nodes.get(lease.nodeId)
    if (!run || !node || node.status !== "running") {
      throw new Error(`Cannot attach session to inactive node ${lease.nodeId}.`)
    }
    this.sessions.set(childSessionID, { rootSessionID: lease.rootSessionID, nodeId: lease.nodeId })
    node.currentSessionID = childSessionID
    run.touchedAt = Date.now()
  }

  complete(lease: DispatchLease, succeeded: boolean, error?: string): RunSnapshot {
    const run = this.runs.get(lease.rootSessionID)
    const node = run?.nodes.get(lease.nodeId)
    if (!run || !node) throw new Error(`Unknown orchestration node ${lease.nodeId}.`)
    if (node.status !== "running") return this.snapshotForRun(run)

    node.active = false
    node.status = succeeded ? "succeeded" : "failed"
    if (!succeeded && error) node.error = error.replace(/\s+/g, " ").trim().slice(0, 240)
    run.activeWorkers = Math.max(0, run.activeWorkers - 1)
    for (const resource of node.contract.exclusiveResources.map(normalizeResource)) {
      if (run.resources.get(resource) === node.id) run.resources.delete(resource)
    }
    run.touchedAt = Date.now()
    this.blockFailedDependants(run)
    this.drainQueue(run)
    return this.snapshotForRun(run)
  }

  snapshot(sessionID: string): RunSnapshot | undefined {
    const link = this.sessions.get(sessionID)
    const rootSessionID = link?.rootSessionID ?? sessionID
    const run = this.runs.get(rootSessionID)
    return run ? this.snapshotForRun(run) : undefined
  }

  rootSessionID(sessionID: string): string {
    return this.sessions.get(sessionID)?.rootSessionID ?? sessionID
  }

  sessionContext(sessionID: string): { rootSessionID: string; nodeId: string; depth: number; agent: string } | undefined {
    const link = this.sessions.get(sessionID)
    if (!link) return undefined
    const node = this.runs.get(link.rootSessionID)?.nodes.get(link.nodeId)
    return node
      ? { rootSessionID: link.rootSessionID, nodeId: node.id, depth: node.depth, agent: node.agent }
      : undefined
  }

  sealedNode(sessionID: string, nodeId: string): { id: string; agent: string; role?: PlanNode["role"]; contract: TaskContract; baseRevision?: string; status: RunNodeStatus } | undefined {
    const rootSessionID = this.rootSessionID(sessionID)
    const node = this.runs.get(rootSessionID)?.nodes.get(nodeId)
    return node
      ? {
          id: node.id,
          agent: node.agent,
          ...(node.role ? { role: node.role } : {}),
          contract: cloneContract(node.contract),
          ...(node.baseRevision ? { baseRevision: node.baseRevision } : {}),
          status: node.status,
        }
      : undefined
  }

  sealedEditorPartitions(sessionID: string): Array<{ id: string; ownership: string[] }> {
    const rootSessionID = this.rootSessionID(sessionID)
    const run = this.runs.get(rootSessionID)
    if (!run) return []
    return [...run.nodes.values()]
      .filter((node) => node.role === "editor")
      .map((node) => ({ id: node.id, ownership: [...node.contract.allowedPaths] }))
  }

  recordValidatedCommit(sessionID: string, nodeId: string, commit: string): void {
    const node = this.runs.get(this.rootSessionID(sessionID))?.nodes.get(nodeId)
    if (!node || node.role !== "editor" || node.status !== "succeeded") {
      throw new Error("Only a completed editor node can have a validated commit.")
    }
    node.validatedCommit = commit
  }

  validatedCommits(sessionID: string): Record<string, string> {
    const run = this.runs.get(this.rootSessionID(sessionID))
    return Object.fromEntries([...(run?.nodes.values() ?? [])]
      .filter((node) => node.role === "editor" && node.validatedCommit)
      .map((node) => [node.id, node.validatedCommit!]))
  }

  formatStatus(sessionID: string): string | undefined {
    const snapshot = this.snapshot(sessionID)
    if (!snapshot) return undefined
    const counts = new Map<RunNodeStatus, number>()
    for (const node of snapshot.nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1)
    const states = [...counts.entries()].map(([status, count]) => `${status}=${count}`).join(", ") || "none"
    return [
      `orchestration root: ${snapshot.rootSessionID}`,
      `workers: active=${snapshot.activeWorkers}/${snapshot.limits.parallelWorkers}, queued=${snapshot.queuedWorkers}, started=${snapshot.totalStarted}/${snapshot.limits.maxWorkers}`,
      `delegation depth: ${snapshot.limits.maxDelegationDepth}`,
      `nodes: ${states}`,
    ].join("\n")
  }

  dispose(): void {
    for (const run of this.runs.values()) {
      for (const pending of run.queue) {
        pending.abort?.()
        pending.node.status = "cancelled"
        pending.resolve(this.denied(run, "cancelled", "Orchestration runtime was disposed."))
      }
      run.queue.length = 0
    }
    this.runs.clear()
    this.sessions.clear()
  }

  private createAdHocRun(rootSessionID: string): RunState {
    const run: RunState = {
      rootSessionID,
      planRegistered: false,
      nodes: new Map(),
      activeWorkers: 0,
      totalStarted: 0,
      resources: new Map(),
      queue: [],
      touchedAt: Date.now(),
    }
    this.runs.set(rootSessionID, run)
    this.pruneRuns()
    return run
  }

  private prepareNode(
    run: RunState,
    request: DispatchRequest,
    parent: MutableRunNode | undefined,
  ): { ok: true; node: MutableRunNode } | DeniedResult {
    const existing = run.nodes.get(request.nodeId)
    if (!parent && run.planRegistered) {
      if (!existing) return this.denied(run, "unknown_node", `Node ${request.nodeId} is not present in the sealed plan.`)
      if (existing.agent !== request.agent) {
        return this.denied(run, "agent_mismatch", `Node ${request.nodeId} is assigned to ${existing.agent}, not ${request.agent}.`)
      }
      if (existing.status !== "pending") {
        return this.denied(run, "duplicate_node", `Node ${request.nodeId} is already ${existing.status}.`)
      }
      if (!request.contract) {
        return this.denied(run, "contract_required", `Node ${request.nodeId} must include its sealed TaskContract.`)
      }
      if (!contractsEqual(request.contract, existing.contract)) {
        return this.denied(run, "contract_mismatch", `Node ${request.nodeId} does not match its sealed TaskContract.`)
      }
      return { ok: true, node: existing }
    }

    if (existing) return this.denied(run, "duplicate_node", `Node ${request.nodeId} already exists in this orchestration tree.`)
    const depth = parent ? parent.depth + 1 : 1
    if (depth > this.limits.maxDelegationDepth) {
      return this.denied(run, "depth_limit", `Delegation depth ${depth} exceeds maxDelegationDepth=${this.limits.maxDelegationDepth}.`)
    }
    if (parent) {
      if (!request.contract) {
        return this.denied(run, "contract_required", `Nested node ${request.nodeId} requires an explicit TaskContract.`)
      }
      if (!parent.contract.delegation.allowed) {
        return this.denied(run, "delegation_denied", `Node ${parent.id} is not allowed to delegate.`)
      }
      if (parent.childrenStarted >= parent.contract.delegation.maxChildren) {
        return this.denied(run, "delegation_limit", `Node ${parent.id} exhausted its child budget.`)
      }
      let ancestor: MutableRunNode | undefined = parent
      while (ancestor) {
        if (ancestor.agent === request.agent) {
          return this.denied(run, "delegation_cycle", `Delegation to ${request.agent} would repeat an ancestor agent.`)
        }
        ancestor = ancestor.parentNodeId ? run.nodes.get(ancestor.parentNodeId) : undefined
      }
    }
    const contract = cloneContract(request.contract ?? fallbackContract(request.task, depth < this.limits.maxDelegationDepth))
    const node: MutableRunNode = {
      id: request.nodeId,
      agent: request.agent,
      status: "pending",
      depth,
      ...(parent ? { parentNodeId: parent.id } : {}),
      dependsOn: [],
      contract,
      childrenStarted: 0,
      active: false,
    }
    run.nodes.set(node.id, node)
    return { ok: true, node }
  }

  private checkDependencies(run: RunState, node: MutableRunNode): DeniedResult | undefined {
    if (node.role === "integrator" && node.dependsOn.some((id) => !run.nodes.get(id)?.validatedCommit)) {
      return this.denied(run, "dependency_pending", "Every editor commit must pass orchestration_validate_commit before integration.")
    }
    const failed = node.dependsOn.find((id) => {
      const status = run.nodes.get(id)?.status
      return status === "failed" || status === "blocked" || status === "cancelled"
    })
    if (failed) {
      node.status = "blocked"
      node.error = `Dependency ${failed} did not succeed.`
      return this.denied(run, "dependency_failed", node.error)
    }
    const pending = node.dependsOn.find((id) => run.nodes.get(id)?.status !== "succeeded")
    return pending
      ? this.denied(run, "dependency_pending", `Dependency ${pending} is not complete.`)
      : undefined
  }

  private start(run: RunState, node: MutableRunNode): AcquireResult {
    node.status = "running"
    node.active = true
    run.activeWorkers += 1
    for (const raw of node.contract.exclusiveResources) {
      const resource = normalizeResource(raw)
      if (resource) run.resources.set(resource, node.id)
    }
    return { ok: true, lease: { rootSessionID: run.rootSessionID, nodeId: node.id, depth: node.depth, contract: cloneContract(node.contract) }, snapshot: this.snapshotForRun(run) }
  }

  private busyResourceOwner(run: RunState, node: MutableRunNode): { resource: string; owner: string } | undefined {
    for (const raw of node.contract.exclusiveResources) {
      const resource = normalizeResource(raw)
      const owner = run.resources.get(resource)
      if (resource && owner && owner !== node.id) return { resource, owner }
    }
    return undefined
  }

  private undoReservation(run: RunState, node: MutableRunNode, parent: MutableRunNode): void {
    run.totalStarted = Math.max(0, run.totalStarted - 1)
    parent.childrenStarted = Math.max(0, parent.childrenStarted - 1)
    if (!run.planRegistered || node.parentNodeId) run.nodes.delete(node.id)
  }

  private drainQueue(run: RunState): void {
    let progressed = true
    while (progressed && run.activeWorkers < this.limits.parallelWorkers) {
      progressed = false
      const index = run.queue.findIndex(({ node }) => !this.busyResourceOwner(run, node))
      if (index < 0) break
      const [pending] = run.queue.splice(index, 1)
      if (!pending) break
      pending.abort?.()
      pending.resolve(this.start(run, pending.node))
      progressed = true
    }
  }

  private blockFailedDependants(run: RunState): void {
    let changed = true
    while (changed) {
      changed = false
      for (const node of run.nodes.values()) {
        if (node.status !== "pending" && node.status !== "queued") continue
        const failed = node.dependsOn.find((id) => {
          const status = run.nodes.get(id)?.status
          return status === "failed" || status === "blocked" || status === "cancelled"
        })
        if (!failed) continue
        const queued = run.queue.findIndex((entry) => entry.node === node)
        if (queued >= 0) {
          const [pending] = run.queue.splice(queued, 1)
          pending?.abort?.()
          pending?.resolve(this.denied(run, "dependency_failed", `Dependency ${failed} did not succeed.`))
        }
        node.status = "blocked"
        node.error = `Dependency ${failed} did not succeed.`
        changed = true
      }
    }
  }

  private denied(run: RunState, code: DeniedResult["code"], error: string): DeniedResult {
    return { ok: false, code, error, snapshot: this.snapshotForRun(run) }
  }

  private snapshotForRun(run: RunState): RunSnapshot {
    return {
      rootSessionID: run.rootSessionID,
      activeWorkers: run.activeWorkers,
      queuedWorkers: run.queue.length,
      totalStarted: run.totalStarted,
      limits: { ...this.limits },
      nodes: [...run.nodes.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((node) => ({
          id: node.id,
          agent: node.agent,
          status: node.status,
          depth: node.depth,
          ...(node.parentNodeId ? { parentNodeId: node.parentNodeId } : {}),
          dependsOn: [...node.dependsOn],
          exclusiveResources: [...node.contract.exclusiveResources],
          ...(node.error ? { error: node.error } : {}),
        })),
    }
  }

  private pruneRuns(): void {
    if (this.runs.size <= MAX_RUNS) return
    const removable = [...this.runs.values()]
      .filter((run) => run.activeWorkers === 0 && run.queue.length === 0)
      .sort((a, b) => a.touchedAt - b.touchedAt)
    while (this.runs.size > MAX_RUNS && removable.length) {
      const run = removable.shift()
      if (!run) break
      this.runs.delete(run.rootSessionID)
      for (const [sessionID, link] of this.sessions) {
        if (link.rootSessionID === run.rootSessionID) this.sessions.delete(sessionID)
      }
    }
  }
}
