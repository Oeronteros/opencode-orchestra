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

export type VerificationGate =
  | { id: string; label: string; kind: "command"; command: string; status: "pending" | "passed" | "failed"; evidence?: string; checkedAt?: number }
  | { id: string; label: string; kind: "artifact"; path: string; status: "pending" | "passed" | "failed"; evidence?: string; checkedAt?: number }

export type NewVerificationGate =
  | { id: string; label: string; kind: "command"; command: string }
  | { id: string; label: string; kind: "artifact"; path: string }

export interface CompletionSnapshot {
  status: "working" | "claimed" | "verified" | "failed"
  summary?: string
  claimedAt?: number
  verifiedAt?: number
  gates: VerificationGate[]
}

export interface TaskBudgetLimits {
  /** Zero means unlimited. */
  maxCostUSD: number
  /** Zero means unlimited. */
  maxTokens: number
  /** Zero means unlimited. */
  maxMinutes: number
  unknownPricing: "warn" | "block"
}

export interface TaskBudgetSnapshot {
  limits: TaskBudgetLimits
  startedAt: number
  estimatedCostUSD?: number
  estimatedTokens?: number
  actualCostUSD: number
  actualTokens: number
  unknownPriceCalls: number
  status: "active" | "warning" | "exceeded"
  reason?: string
}

export interface PlanChange {
  version: number
  at: number
  reason: string
  trigger?: string
  addedNodeIds: string[]
}

export interface PersistedRunNode {
  id: string
  description: string
  agent: string
  status: RunNodeStatus
  depth: number
  parentNodeId?: string
  role?: PlanNode["role"]
  dependsOn: string[]
  contract: TaskContract
  baseRevision?: string
  validatedCommit?: string
  currentSessionID?: string
  childrenStarted: number
  started: boolean
  attempt?: number
  error?: string
  output?: string
}

export interface PersistedRun {
  rootSessionID: string
  planRegistered: boolean
  totalStarted: number
  touchedAt: number
  nodes: PersistedRunNode[]
  completion?: CompletionSnapshot
  budget?: TaskBudgetSnapshot
  planVersion?: number
  planChanges?: PlanChange[]
  evidenceRevision?: number
}

export interface PersistedOrchestrationState {
  version: 1
  updatedAt: number
  runs: PersistedRun[]
}

export interface ResumeNode {
  id: string
  description: string
  agent: string
  role?: PlanNode["role"]
  dependsOn: string[]
  contract: TaskContract
  dependencyResults: Array<{ nodeId: string; agent: string; output: string }>
}

export interface ResumeResult {
  rootSessionID: string
  run: RunSnapshot
  ready: ResumeNode[]
  waiting: ResumeNode[]
}

export interface RunActionResult {
  rootSessionID: string
  nodeId: string
  affected: string[]
  childSessionIDs: string[]
  run: RunSnapshot
}

export interface RunSnapshot {
  rootSessionID: string
  activeWorkers: number
  queuedWorkers: number
  totalStarted: number
  limits: RunLimits
  nodes: RunNodeSnapshot[]
  completion: CompletionSnapshot
  budget: TaskBudgetSnapshot
  planVersion: number
  planChanges: PlanChange[]
}

export interface DispatchLease {
  rootSessionID: string
  nodeId: string
  depth: number
  contract: TaskContract
  attempt: number
}

export type AcquireResult =
  | { ok: true; lease: DispatchLease; snapshot: RunSnapshot }
  | { ok: false; code: "unknown_node" | "agent_mismatch" | "contract_required" | "contract_mismatch" | "duplicate_node" | "dependency_pending" | "dependency_failed" | "total_limit" | "parallel_limit" | "depth_limit" | "delegation_denied" | "delegation_limit" | "delegation_cycle" | "resource_busy" | "budget_exceeded" | "cancelled"; error: string; snapshot: RunSnapshot }

type DeniedResult = Extract<AcquireResult, { ok: false }>

interface MutableRunNode {
  id: string
  description: string
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
  started: boolean
  attempt: number
  active: boolean
  error?: string
  /** Successful text output retained only for the lifetime of this in-memory run. */
  output?: string
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
  completion: CompletionSnapshot
  budget: TaskBudgetSnapshot
  planVersion: number
  planChanges: PlanChange[]
  evidenceRevision: number
}

const MAX_RUNS = 128

function cloneGate(gate: VerificationGate): VerificationGate {
  return { ...gate }
}

function emptyCompletion(): CompletionSnapshot {
  return { status: "working", gates: [] }
}

function emptyBudget(): TaskBudgetSnapshot {
  return {
    limits: { maxCostUSD: 0, maxTokens: 0, maxMinutes: 0, unknownPricing: "warn" },
    startedAt: Date.now(),
    actualCostUSD: 0,
    actualTokens: 0,
    unknownPriceCalls: 0,
    status: "active",
  }
}

function cloneBudget(budget: TaskBudgetSnapshot): TaskBudgetSnapshot {
  return {
    limits: { ...budget.limits },
    startedAt: budget.startedAt,
    ...(budget.estimatedCostUSD !== undefined ? { estimatedCostUSD: budget.estimatedCostUSD } : {}),
    ...(budget.estimatedTokens !== undefined ? { estimatedTokens: budget.estimatedTokens } : {}),
    actualCostUSD: budget.actualCostUSD,
    actualTokens: budget.actualTokens,
    unknownPriceCalls: budget.unknownPriceCalls,
    status: budget.status,
    ...(budget.reason ? { reason: budget.reason } : {}),
  }
}

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
    description: node.description,
    agent: node.worker,
    role: node.role,
    status: "pending",
    depth: 1,
    dependsOn: [...node.dependsOn],
    contract: cloneContract(node.contract),
    ...(node.worktree?.baseRevision ? { baseRevision: node.worktree.baseRevision } : {}),
    childrenStarted: 0,
    started: false,
    attempt: 0,
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
  private readonly rootAliases = new Map<string, string>()

  constructor(
    private readonly limits: RunLimits,
    private readonly onChange?: (state: PersistedOrchestrationState) => void,
  ) {}

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
      completion: emptyCompletion(),
      budget: emptyBudget(),
      planVersion: 1,
      planChanges: [{ version: 1, at: Date.now(), reason: "Initial sealed plan.", addedNodeIds: plan.nodes.map((node) => node.id) }],
      evidenceRevision: 0,
    }
    for (const [sessionID, link] of this.sessions) {
      if (link.rootSessionID === rootSessionID) this.sessions.delete(sessionID)
    }
    this.runs.set(rootSessionID, run)
    this.pruneRuns()
    this.changed()
    return this.snapshotForRun(run)
  }

  extendPlan(rootSessionID: string, plan: TaskPlan, change: { reason: string; trigger?: string } = { reason: "Manual plan extension." }): RunSnapshot {
    const run = this.runs.get(this.rootSessionID(rootSessionID))
    if (!run) return this.registerPlan(rootSessionID, plan)
    if (run.activeWorkers > 0 || run.queue.length > 0) {
      throw new Error("Cannot extend an orchestration plan while its workers are active.")
    }
    const reserved = [...run.nodes.values()].filter((node) => node.status === "pending").length
    if (run.totalStarted + reserved + plan.nodes.length > this.limits.maxWorkers) {
      throw new Error(`Extended plan would exceed maxWorkers=${this.limits.maxWorkers}.`)
    }
    const newIds = new Set<string>()
    for (const planNode of plan.nodes) {
      if (run.nodes.has(planNode.id) || newIds.has(planNode.id)) throw new Error(`Duplicate plan node ${planNode.id}.`)
      newIds.add(planNode.id)
    }
    for (const planNode of plan.nodes) {
      const unknown = planNode.dependsOn.find((dependency) => !run.nodes.has(dependency) && !newIds.has(dependency))
      if (unknown) throw new Error(`Plan node ${planNode.id} references unknown dependency ${unknown}.`)
    }
    const visiting = new Set<string>(), visited = new Set<string>()
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error(`Extended plan contains a dependency cycle at ${id}.`)
      if (visited.has(id) || run.nodes.has(id)) return
      visiting.add(id)
      for (const dependency of plan.nodes.find((node) => node.id === id)?.dependsOn ?? []) visit(dependency)
      visiting.delete(id); visited.add(id)
    }
    for (const id of newIds) visit(id)
    for (const planNode of plan.nodes) run.nodes.set(planNode.id, fromPlanNode(planNode))
    run.planRegistered = true
    run.planVersion += 1
    run.planChanges.push({
      version: run.planVersion,
      at: Date.now(),
      reason: change.reason.trim().slice(0, 500) || "Plan extension.",
      ...(change.trigger?.trim() ? { trigger: change.trigger.trim().slice(0, 120) } : {}),
      addedNodeIds: plan.nodes.map((node) => node.id),
    })
    run.completion.status = "working"
    delete run.completion.summary
    delete run.completion.claimedAt
    delete run.completion.verifiedAt
    for (const gate of run.completion.gates) {
      gate.status = "pending"
      delete gate.evidence
      delete gate.checkedAt
    }
    run.touchedAt = Date.now()
    this.changed()
    return this.snapshotForRun(run)
  }

  async acquire(request: DispatchRequest): Promise<AcquireResult> {
    const parentLink = this.sessions.get(request.parentSessionID)
    const rootSessionID = parentLink?.rootSessionID ?? this.rootAliases.get(request.parentSessionID) ?? request.parentSessionID
    const run = this.runs.get(rootSessionID) ?? this.createAdHocRun(rootSessionID)
    run.touchedAt = Date.now()
    this.evaluateBudget(run)
    if (run.budget.status === "exceeded") {
      return this.denied(run, "budget_exceeded", run.budget.reason ?? "The task budget is exhausted.")
    }
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
    const firstStart = !node.started
    if (firstStart && run.totalStarted + reserved >= this.limits.maxWorkers) {
      if (!run.planRegistered || parent) run.nodes.delete(node.id)
      return this.denied(run, "total_limit", `maxWorkers=${this.limits.maxWorkers} is exhausted for this orchestration tree.`)
    }

    if (firstStart) {
      run.totalStarted += 1
      node.started = true
      if (parent) parent.childrenStarted += 1
    }

    const resourceOwner = this.busyResourceOwner(run, node)
    const capacityAvailable = run.activeWorkers < this.limits.parallelWorkers
    if (capacityAvailable && !resourceOwner) return this.start(run, node)

    // A running worker waiting for a queued child can deadlock the whole pool.
    // Nested dispatch therefore fails fast; the parent can continue itself or
    // retry after another branch completes. Root-level branches remain queued.
    if (parent) {
      this.undoReservation(run, node, parent, firstStart)
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
          if (firstStart) {
            run.totalStarted = Math.max(0, run.totalStarted - 1)
            node.started = false
          }
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
      this.changed()
    })
  }

  attachSession(lease: DispatchLease, childSessionID: string): void {
    const run = this.runs.get(lease.rootSessionID)
    const node = run?.nodes.get(lease.nodeId)
    if (!run || !node || node.status !== "running" || lease.attempt !== node.attempt) {
      throw new Error(`Cannot attach session to inactive node ${lease.nodeId}.`)
    }
    this.sessions.set(childSessionID, { rootSessionID: lease.rootSessionID, nodeId: lease.nodeId })
    node.currentSessionID = childSessionID
    run.touchedAt = Date.now()
    this.changed()
  }

  complete(lease: DispatchLease, succeeded: boolean, error?: string, output?: string): RunSnapshot {
    const run = this.runs.get(lease.rootSessionID)
    const node = run?.nodes.get(lease.nodeId)
    if (!run || !node) throw new Error(`Unknown orchestration node ${lease.nodeId}.`)
    if (node.status !== "running" || lease.attempt !== node.attempt) return this.snapshotForRun(run)

    node.active = false
    node.status = succeeded ? "succeeded" : "failed"
    if (succeeded) run.evidenceRevision += 1
    if (succeeded && output?.trim()) node.output = output
    else delete node.output
    if (!succeeded && error) node.error = error.replace(/\s+/g, " ").trim().slice(0, 240)
    run.activeWorkers = Math.max(0, run.activeWorkers - 1)
    for (const resource of node.contract.exclusiveResources.map(normalizeResource)) {
      if (run.resources.get(resource) === node.id) run.resources.delete(resource)
    }
    run.touchedAt = Date.now()
    this.blockFailedDependants(run)
    this.drainQueue(run)
    this.changed()
    return this.snapshotForRun(run)
  }

  snapshot(sessionID: string): RunSnapshot | undefined {
    const run = this.runs.get(this.rootSessionID(sessionID))
    return run ? this.snapshotForRun(run) : undefined
  }

  /**
   * Return successful direct dependency outputs for a sealed node. Results
   * stay in memory and are never exposed in status snapshots or telemetry.
   */
  dependencyOutputs(sessionID: string, nodeId: string): Array<{ nodeId: string; agent: string; output: string }> {
    const run = this.runs.get(this.rootSessionID(sessionID))
    const node = run?.nodes.get(nodeId)
    if (!run || !node) return []
    return node.dependsOn.flatMap((dependencyId) => {
      const dependency = run.nodes.get(dependencyId)
      return dependency?.status === "succeeded" && dependency.output
        ? [{ nodeId: dependency.id, agent: dependency.agent, output: dependency.output }]
        : []
    })
  }

  rootSessionID(sessionID: string): string {
    return this.sessions.get(sessionID)?.rootSessionID ?? this.rootAliases.get(sessionID) ?? sessionID
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
    const run = this.runs.get(this.rootSessionID(sessionID))
    const node = run?.nodes.get(nodeId)
    if (!run || !node || node.role !== "editor" || node.status !== "succeeded") {
      throw new Error("Only a completed editor node can have a validated commit.")
    }
    node.validatedCommit = commit
    run.evidenceRevision += 1
    run.touchedAt = Date.now()
    this.changed()
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
      `plan: version=${snapshot.planVersion}; changes=${snapshot.planChanges.length}`,
      `workers: active=${snapshot.activeWorkers}/${snapshot.limits.parallelWorkers}, queued=${snapshot.queuedWorkers}, started=${snapshot.totalStarted}/${snapshot.limits.maxWorkers}`,
      `delegation depth: ${snapshot.limits.maxDelegationDepth}`,
      `nodes: ${states}`,
      `completion: ${snapshot.completion.status}; verification=${snapshot.completion.gates.filter((gate) => gate.status === "passed").length}/${snapshot.completion.gates.length}`,
      `budget: ${snapshot.budget.status}; cost=$${snapshot.budget.actualCostUSD.toFixed(4)}${snapshot.budget.limits.maxCostUSD > 0 ? `/$${snapshot.budget.limits.maxCostUSD.toFixed(2)}` : ""}; tokens=${snapshot.budget.actualTokens}${snapshot.budget.limits.maxTokens > 0 ? `/${snapshot.budget.limits.maxTokens}` : ""}`,
    ].join("\n")
  }

  progressFingerprint(sessionID: string): string | undefined {
    const run = this.runs.get(this.rootSessionID(sessionID))
    if (!run) return undefined
    const succeeded = [...run.nodes.values()].filter((node) => node.status === "succeeded").length
    const commits = [...run.nodes.values()].filter((node) => node.validatedCommit).length
    const verifiedGates = run.completion.gates.filter((gate) => gate.status === "passed").length
    return `${run.planVersion}:${run.evidenceRevision}:${succeeded}:${commits}:${verifiedGates}`
  }

  adaptiveContext(sessionID: string): {
    rootSessionID: string
    planVersion: number
    nodeIds: string[]
    succeededNodeIds: string[]
    remainingSlots: number
    triggers: string[]
  } | undefined {
    const run = this.runs.get(this.rootSessionID(sessionID))
    if (!run) return undefined
    return {
      rootSessionID: run.rootSessionID,
      planVersion: run.planVersion,
      nodeIds: [...run.nodes.keys()],
      succeededNodeIds: [...run.nodes.values()].filter((node) => node.status === "succeeded").map((node) => node.id),
      remainingSlots: Math.max(0, this.limits.maxWorkers - run.totalStarted - [...run.nodes.values()].filter((node) => node.status === "pending").length),
      triggers: run.planChanges.flatMap((entry) => entry.trigger ? [entry.trigger] : []),
    }
  }

  configureBudget(sessionID: string, limits: TaskBudgetLimits, estimate?: { costUSD?: number; tokens?: number; unknownPriceCalls?: number }): TaskBudgetSnapshot {
    const run = this.runs.get(this.rootSessionID(sessionID))
    if (!run) throw new Error("Register an orchestration plan before configuring its task budget.")
    for (const [name, value] of Object.entries(limits)) {
      if (name !== "unknownPricing" && (!Number.isFinite(value) || Number(value) < 0)) throw new Error(`Invalid task budget ${name}.`)
    }
    run.budget = {
      limits: { ...limits },
      startedAt: Date.now(),
      ...(estimate?.costUSD !== undefined ? { estimatedCostUSD: Math.max(0, estimate.costUSD) } : {}),
      ...(estimate?.tokens !== undefined ? { estimatedTokens: Math.max(0, estimate.tokens) } : {}),
      actualCostUSD: 0,
      actualTokens: 0,
      unknownPriceCalls: Math.max(0, estimate?.unknownPriceCalls ?? 0),
      status: "active",
    }
    this.evaluateBudget(run, true)
    run.touchedAt = Date.now()
    this.changed()
    return cloneBudget(run.budget)
  }

  updateBudgetUsage(sessionID: string, usage: { costUSD: number; tokens: number; unknownPriceCalls: number }): TaskBudgetSnapshot | undefined {
    const run = this.runs.get(this.rootSessionID(sessionID))
    if (!run) return undefined
    run.budget.actualCostUSD = Math.max(0, usage.costUSD)
    run.budget.actualTokens = Math.max(0, Math.floor(usage.tokens))
    run.budget.unknownPriceCalls = Math.max(run.budget.unknownPriceCalls, Math.floor(usage.unknownPriceCalls))
    this.evaluateBudget(run)
    run.touchedAt = Date.now()
    this.changed()
    return cloneBudget(run.budget)
  }

  budget(sessionID: string): TaskBudgetSnapshot | undefined {
    const run = this.runs.get(this.rootSessionID(sessionID))
    if (!run) return undefined
    this.evaluateBudget(run)
    return cloneBudget(run.budget)
  }

  setVerificationGates(sessionID: string, gates: NewVerificationGate[]): CompletionSnapshot {
    const rootSessionID = this.rootSessionID(sessionID)
    const run = this.runs.get(rootSessionID) ?? this.createAdHocRun(rootSessionID)
    if (gates.length === 0) throw new Error("At least one verification gate is required.")
    const ids = new Set<string>()
    const normalized = gates.map((gate) => {
      const id = gate.id.trim()
      if (!id || ids.has(id)) throw new Error(`Verification gate id must be unique and nonempty: ${gate.id}`)
      ids.add(id)
      if (!gate.label.trim()) throw new Error(`Verification gate ${id} requires a label.`)
      if (gate.kind === "command" && !gate.command.trim()) throw new Error(`Verification gate ${id} requires a command.`)
      if (gate.kind === "artifact" && !gate.path.trim()) throw new Error(`Verification gate ${id} requires a path.`)
      return { ...gate, id, label: gate.label.trim(), status: "pending" as const } as VerificationGate
    })
    run.completion = { status: "working", gates: normalized }
    run.touchedAt = Date.now()
    this.changed()
    return this.completionForRun(run)
  }

  recordCommandVerification(sessionID: string, command: string, succeeded: boolean, evidence?: string): boolean {
    const run = this.runs.get(this.rootSessionID(sessionID))
    if (!run) return false
    const normalized = command.trim()
    const gate = run.completion.gates.find((candidate) => candidate.kind === "command" && candidate.command.trim() === normalized)
    if (!gate) return false
    gate.status = succeeded ? "passed" : "failed"
    gate.checkedAt = Date.now()
    gate.evidence = (evidence ?? (succeeded ? "Command completed successfully." : "Command failed.")).replace(/\s+/g, " ").trim().slice(0, 500)
    if (!succeeded) run.completion.status = "failed"
    else if (run.completion.status === "failed") run.completion.status = "working"
    run.evidenceRevision += 1
    run.touchedAt = Date.now()
    this.changed()
    return true
  }

  recordArtifactVerification(sessionID: string, gateID: string, succeeded: boolean, evidence: string): boolean {
    const run = this.runs.get(this.rootSessionID(sessionID))
    const gate = run?.completion.gates.find((candidate) => candidate.id === gateID && candidate.kind === "artifact")
    if (!run || !gate) return false
    gate.status = succeeded ? "passed" : "failed"
    gate.checkedAt = Date.now()
    gate.evidence = evidence.replace(/\s+/g, " ").trim().slice(0, 500)
    if (!succeeded) run.completion.status = "failed"
    else if (run.completion.status === "failed") run.completion.status = "working"
    run.evidenceRevision += 1
    run.touchedAt = Date.now()
    this.changed()
    return true
  }

  completion(sessionID: string): CompletionSnapshot | undefined {
    const run = this.runs.get(this.rootSessionID(sessionID))
    return run ? this.completionForRun(run) : undefined
  }

  claimCompletion(sessionID: string, summary: string, requireVerification = true): { ok: boolean; completion: CompletionSnapshot; error?: string } {
    const run = this.runs.get(this.rootSessionID(sessionID))
    if (!run) return { ok: false, completion: emptyCompletion(), error: "No Orchestra run exists in this session." }
    run.completion.summary = summary.trim().slice(0, 2_000)
    run.completion.claimedAt = Date.now()
    const unfinished = [...run.nodes.values()].filter((node) => node.status === "pending" || node.status === "queued" || node.status === "running")
    const unsuccessful = [...run.nodes.values()].filter((node) => node.status === "failed" || node.status === "blocked" || node.status === "cancelled")
    this.evaluateBudget(run)
    let error: string | undefined
    if (run.budget.status === "exceeded") error = run.budget.reason ?? "The task budget was exceeded."
    else if (unfinished.length) error = `${unfinished.length} orchestration node(s) are unfinished.`
    else if (unsuccessful.length) error = `${unsuccessful.length} orchestration node(s) did not succeed.`
    else if (requireVerification && run.completion.gates.length === 0) error = "No verification gates were registered."
    else {
      const failed = run.completion.gates.filter((gate) => gate.status === "failed")
      const pending = run.completion.gates.filter((gate) => gate.status === "pending")
      if (failed.length) error = `Verification failed: ${failed.map((gate) => gate.label).join(", ")}.`
      else if (pending.length) error = `Verification is pending: ${pending.map((gate) => gate.label).join(", ")}.`
    }
    if (error) {
      run.completion.status = unsuccessful.length > 0 || run.completion.gates.some((gate) => gate.status === "failed") ? "failed" : "claimed"
      run.touchedAt = Date.now()
      this.changed()
      return { ok: false, completion: this.completionForRun(run), error }
    }
    run.completion.status = "verified"
    run.completion.verifiedAt = Date.now()
    run.touchedAt = Date.now()
    this.changed()
    return { ok: true, completion: this.completionForRun(run) }
  }

  /** Return unfinished saved runs, newest first. */
  resumableRuns(): Array<{ rootSessionID: string; touchedAt: number; pending: number; completed: number; total: number }> {
    return [...this.runs.values()]
      .map((run) => {
        const nodes = [...run.nodes.values()]
        return {
          rootSessionID: run.rootSessionID,
          touchedAt: run.touchedAt,
          pending: nodes.filter((node) => node.status === "pending" || node.status === "queued" || node.status === "running").length,
          completed: nodes.filter((node) => node.status === "succeeded").length,
          total: nodes.length,
        }
      })
      .filter((run) => run.pending > 0)
      .sort((left, right) => right.touchedAt - left.touchedAt)
  }

  /** Bind a new OpenCode session to an interrupted root and expose its next work. */
  resume(sessionID: string, requestedRoot?: string): ResumeResult {
    const candidates = this.resumableRuns()
    const rootSessionID = requestedRoot?.trim() || candidates[0]?.rootSessionID
    if (!rootSessionID) throw new Error("No unfinished Orchestra run is available to resume.")
    const run = this.runs.get(rootSessionID)
    if (!run) throw new Error(`Saved Orchestra run ${rootSessionID} was not found.`)
    if (!candidates.some((candidate) => candidate.rootSessionID === rootSessionID)) {
      throw new Error(`Saved Orchestra run ${rootSessionID} has no unfinished nodes.`)
    }
    this.rootAliases.set(sessionID, rootSessionID)
    const pending = [...run.nodes.values()].filter((node) => node.status === "pending")
    const resumableNode = (node: MutableRunNode): ResumeNode => ({
      id: node.id,
      description: node.description,
      agent: node.agent,
      ...(node.role ? { role: node.role } : {}),
      dependsOn: [...node.dependsOn],
      contract: cloneContract(node.contract),
      dependencyResults: this.dependencyOutputs(rootSessionID, node.id),
    })
    const isReady = (node: MutableRunNode) => node.dependsOn.every((id) => run.nodes.get(id)?.status === "succeeded")
    return {
      rootSessionID,
      run: this.snapshotForRun(run),
      ready: pending.filter(isReady).map(resumableNode),
      waiting: pending.filter((node) => !isReady(node)).map(resumableNode),
    }
  }

  cancelBranch(rootSessionID: string, nodeId: string): RunActionResult {
    const run = this.runs.get(this.rootSessionID(rootSessionID))
    const target = run?.nodes.get(nodeId)
    if (!run || !target) throw new Error(`Orchestration node ${nodeId} was not found.`)
    const affected = this.dependantsOf(run, nodeId)
    const childSessionIDs: string[] = []
    for (const id of affected) {
      const node = run.nodes.get(id)!
      if (node.currentSessionID) childSessionIDs.push(node.currentSessionID)
      const queued = run.queue.findIndex((entry) => entry.node === node)
      if (queued >= 0) {
        const [pending] = run.queue.splice(queued, 1)
        pending?.abort?.()
        pending?.resolve(this.denied(run, "cancelled", `Branch ${nodeId} was cancelled from the dashboard.`))
      }
      if (node.active) {
        node.active = false
        run.activeWorkers = Math.max(0, run.activeWorkers - 1)
        for (const resource of node.contract.exclusiveResources.map(normalizeResource)) {
          if (run.resources.get(resource) === node.id) run.resources.delete(resource)
        }
      }
      if (node.status !== "succeeded") {
        node.status = "cancelled"
        node.error = `Branch ${nodeId} was cancelled from the dashboard.`
      }
    }
    run.completion.status = "working"
    delete run.completion.verifiedAt
    run.touchedAt = Date.now()
    this.drainQueue(run)
    this.changed()
    return { rootSessionID: run.rootSessionID, nodeId, affected, childSessionIDs, run: this.snapshotForRun(run) }
  }

  retryBranch(rootSessionID: string, nodeId: string): RunActionResult {
    const run = this.runs.get(this.rootSessionID(rootSessionID))
    const target = run?.nodes.get(nodeId)
    if (!run || !target) throw new Error(`Orchestration node ${nodeId} was not found.`)
    if (!(["failed", "blocked", "cancelled"] as RunNodeStatus[]).includes(target.status)) {
      throw new Error(`Node ${nodeId} is ${target.status}; only failed, blocked, or cancelled nodes can be retried.`)
    }
    const affected = this.dependantsOf(run, nodeId)
    if (affected.some((id) => {
      const status = run.nodes.get(id)?.status
      return status === "running" || status === "queued"
    })) throw new Error("Cannot retry while an affected node is active or queued.")
    for (const id of affected) {
      const node = run.nodes.get(id)!
      node.status = "pending"
      node.active = false
      delete node.error
      delete node.output
      delete node.validatedCommit
      delete node.currentSessionID
    }
    run.completion.status = "working"
    delete run.completion.summary
    delete run.completion.claimedAt
    delete run.completion.verifiedAt
    for (const gate of run.completion.gates) {
      gate.status = "pending"
      delete gate.evidence
      delete gate.checkedAt
    }
    run.touchedAt = Date.now()
    this.changed()
    return { rootSessionID: run.rootSessionID, nodeId, affected, childSessionIDs: [], run: this.snapshotForRun(run) }
  }

  exportState(): PersistedOrchestrationState {
    return {
      version: 1,
      updatedAt: Date.now(),
      runs: [...this.runs.values()].map((run) => ({
        rootSessionID: run.rootSessionID,
        planRegistered: run.planRegistered,
        totalStarted: run.totalStarted,
        touchedAt: run.touchedAt,
        completion: this.completionForRun(run),
        budget: cloneBudget(run.budget),
        planVersion: run.planVersion,
        planChanges: run.planChanges.map((entry) => ({ ...entry, addedNodeIds: [...entry.addedNodeIds] })),
        evidenceRevision: run.evidenceRevision,
        nodes: [...run.nodes.values()].map((node) => ({
          id: node.id,
          description: node.description,
          agent: node.agent,
          status: node.status,
          depth: node.depth,
          ...(node.parentNodeId ? { parentNodeId: node.parentNodeId } : {}),
          ...(node.role ? { role: node.role } : {}),
          dependsOn: [...node.dependsOn],
          contract: cloneContract(node.contract),
          ...(node.baseRevision ? { baseRevision: node.baseRevision } : {}),
          ...(node.validatedCommit ? { validatedCommit: node.validatedCommit } : {}),
          ...(node.currentSessionID ? { currentSessionID: node.currentSessionID } : {}),
          childrenStarted: node.childrenStarted,
          started: node.started,
          attempt: node.attempt,
          ...(node.error ? { error: node.error } : {}),
          ...(node.output ? { output: node.output } : {}),
        })),
      })),
    }
  }

  /** Restore checkpoints. In-flight work is retried as pending after restart. */
  restore(state: PersistedOrchestrationState | undefined): number {
    if (!state || state.version !== 1 || !Array.isArray(state.runs)) return 0
    let restored = 0
    for (const saved of state.runs) {
      if (!saved || typeof saved.rootSessionID !== "string" || !Array.isArray(saved.nodes)) continue
      const nodes = new Map<string, MutableRunNode>()
      for (const raw of saved.nodes) {
        if (!this.isPersistedNode(raw) || nodes.has(raw.id)) continue
        const interrupted = raw.status === "running" || raw.status === "queued"
        nodes.set(raw.id, {
          id: raw.id,
          description: raw.description,
          agent: raw.agent,
          status: interrupted ? "pending" : raw.status,
          depth: raw.depth,
          ...(raw.parentNodeId ? { parentNodeId: raw.parentNodeId } : {}),
          ...(raw.role ? { role: raw.role } : {}),
          dependsOn: [...raw.dependsOn],
          contract: cloneContract(raw.contract),
          ...(raw.baseRevision ? { baseRevision: raw.baseRevision } : {}),
          ...(raw.validatedCommit ? { validatedCommit: raw.validatedCommit } : {}),
          childrenStarted: raw.childrenStarted,
          started: raw.started,
          attempt: raw.attempt ?? 0,
          active: false,
          ...(raw.error && !interrupted ? { error: raw.error } : {}),
          ...(raw.output ? { output: raw.output } : {}),
        })
      }
      if (nodes.size === 0) continue
      const totalStarted = [...nodes.values()].filter((node) => node.started).length
      this.runs.set(saved.rootSessionID, {
        rootSessionID: saved.rootSessionID,
        planRegistered: Boolean(saved.planRegistered),
        nodes,
        activeWorkers: 0,
        totalStarted,
        resources: new Map(),
        queue: [],
        touchedAt: typeof saved.touchedAt === "number" ? saved.touchedAt : Date.now(),
        completion: this.restoreCompletion(saved.completion),
        budget: this.restoreBudget(saved.budget),
        planVersion: typeof saved.planVersion === "number" && saved.planVersion > 0 ? Math.floor(saved.planVersion) : 1,
        planChanges: this.restorePlanChanges(saved.planChanges, nodes),
        evidenceRevision: typeof saved.evidenceRevision === "number" && saved.evidenceRevision >= 0 ? Math.floor(saved.evidenceRevision) : 0,
      })
      restored += 1
    }
    this.pruneRuns()
    return restored
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
    this.rootAliases.clear()
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
      completion: emptyCompletion(),
      budget: emptyBudget(),
      planVersion: 0,
      planChanges: [],
      evidenceRevision: 0,
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
      description: request.task,
      agent: request.agent,
      status: "pending",
      depth,
      ...(parent ? { parentNodeId: parent.id } : {}),
      dependsOn: [],
      contract,
      childrenStarted: 0,
      started: false,
      attempt: 0,
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
    node.attempt += 1
    run.activeWorkers += 1
    for (const raw of node.contract.exclusiveResources) {
      const resource = normalizeResource(raw)
      if (resource) run.resources.set(resource, node.id)
    }
    run.touchedAt = Date.now()
    this.changed()
    return { ok: true, lease: { rootSessionID: run.rootSessionID, nodeId: node.id, depth: node.depth, contract: cloneContract(node.contract), attempt: node.attempt }, snapshot: this.snapshotForRun(run) }
  }

  private busyResourceOwner(run: RunState, node: MutableRunNode): { resource: string; owner: string } | undefined {
    for (const raw of node.contract.exclusiveResources) {
      const resource = normalizeResource(raw)
      const owner = run.resources.get(resource)
      if (resource && owner && owner !== node.id) return { resource, owner }
    }
    return undefined
  }

  private undoReservation(run: RunState, node: MutableRunNode, parent: MutableRunNode, firstStart: boolean): void {
    if (firstStart) {
      run.totalStarted = Math.max(0, run.totalStarted - 1)
      parent.childrenStarted = Math.max(0, parent.childrenStarted - 1)
      node.started = false
    }
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
      completion: this.completionForRun(run),
      budget: cloneBudget(run.budget),
      planVersion: run.planVersion,
      planChanges: run.planChanges.map((entry) => ({ ...entry, addedNodeIds: [...entry.addedNodeIds] })),
    }
  }

  private restorePlanChanges(value: PlanChange[] | undefined, nodes: Map<string, MutableRunNode>): PlanChange[] {
    if (!Array.isArray(value) || value.length === 0) {
      return [{ version: 1, at: Date.now(), reason: "Restored legacy plan.", addedNodeIds: [...nodes.keys()] }]
    }
    return value
      .filter((entry) => entry && typeof entry.version === "number" && typeof entry.at === "number" && typeof entry.reason === "string" && Array.isArray(entry.addedNodeIds))
      .map((entry) => ({
        version: Math.max(1, Math.floor(entry.version)),
        at: entry.at,
        reason: entry.reason,
        ...(typeof entry.trigger === "string" ? { trigger: entry.trigger } : {}),
        addedNodeIds: entry.addedNodeIds.filter((id) => typeof id === "string"),
      }))
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

  private dependantsOf(run: RunState, nodeId: string): string[] {
    const affected = new Set([nodeId])
    let changed = true
    while (changed) {
      changed = false
      for (const node of run.nodes.values()) {
        if (affected.has(node.id)) continue
        if ((node.parentNodeId && affected.has(node.parentNodeId)) || node.dependsOn.some((dependency) => affected.has(dependency))) {
          affected.add(node.id)
          changed = true
        }
      }
    }
    return [...affected]
  }

  private changed(): void {
    this.onChange?.(this.exportState())
  }

  private completionForRun(run: RunState): CompletionSnapshot {
    return {
      status: run.completion.status,
      ...(run.completion.summary ? { summary: run.completion.summary } : {}),
      ...(run.completion.claimedAt ? { claimedAt: run.completion.claimedAt } : {}),
      ...(run.completion.verifiedAt ? { verifiedAt: run.completion.verifiedAt } : {}),
      gates: run.completion.gates.map(cloneGate),
    }
  }

  private restoreCompletion(value: CompletionSnapshot | undefined): CompletionSnapshot {
    if (!value || !Array.isArray(value.gates)) return emptyCompletion()
    const statuses = new Set(["working", "claimed", "verified", "failed"])
    const gateStatuses = new Set(["pending", "passed", "failed"])
    const gates = value.gates
      .filter((gate) => gate && typeof gate.id === "string" && typeof gate.label === "string"
        && (gate.kind === "command" || gate.kind === "artifact") && gateStatuses.has(gate.status))
      .map(cloneGate)
    return {
      status: statuses.has(value.status) ? value.status : "working",
      ...(typeof value.summary === "string" ? { summary: value.summary } : {}),
      ...(typeof value.claimedAt === "number" ? { claimedAt: value.claimedAt } : {}),
      ...(typeof value.verifiedAt === "number" ? { verifiedAt: value.verifiedAt } : {}),
      gates,
    }
  }

  private restoreBudget(value: TaskBudgetSnapshot | undefined): TaskBudgetSnapshot {
    if (!value || !value.limits || typeof value.startedAt !== "number") return emptyBudget()
    const limits = value.limits
    if (![limits.maxCostUSD, limits.maxTokens, limits.maxMinutes].every((number) => typeof number === "number" && Number.isFinite(number) && number >= 0)) return emptyBudget()
    if (limits.unknownPricing !== "warn" && limits.unknownPricing !== "block") return emptyBudget()
    const restored: TaskBudgetSnapshot = {
      limits: { ...limits },
      startedAt: value.startedAt,
      ...(typeof value.estimatedCostUSD === "number" ? { estimatedCostUSD: value.estimatedCostUSD } : {}),
      ...(typeof value.estimatedTokens === "number" ? { estimatedTokens: value.estimatedTokens } : {}),
      actualCostUSD: Math.max(0, value.actualCostUSD ?? 0),
      actualTokens: Math.max(0, value.actualTokens ?? 0),
      unknownPriceCalls: Math.max(0, value.unknownPriceCalls ?? 0),
      status: "active",
    }
    const holder = { budget: restored } as RunState
    this.evaluateBudget(holder)
    return restored
  }

  private evaluateBudget(run: Pick<RunState, "budget">, includeEstimate = false): void {
    const budget = run.budget
    const elapsedMinutes = (Date.now() - budget.startedAt) / 60_000
    const reasons: string[] = []
    if (budget.limits.maxMinutes > 0 && elapsedMinutes >= budget.limits.maxMinutes) reasons.push(`Time budget of ${budget.limits.maxMinutes} minute(s) was exhausted.`)
    if (budget.limits.maxCostUSD > 0 && budget.actualCostUSD >= budget.limits.maxCostUSD) reasons.push(`Cost budget of $${budget.limits.maxCostUSD.toFixed(2)} was exhausted.`)
    if (budget.limits.maxTokens > 0 && budget.actualTokens >= budget.limits.maxTokens) reasons.push(`Token budget of ${budget.limits.maxTokens} was exhausted.`)
    if (budget.limits.unknownPricing === "block" && budget.unknownPriceCalls > 0) reasons.push(`${budget.unknownPriceCalls} call(s) have unknown pricing.`)
    if (includeEstimate && budget.limits.maxCostUSD > 0 && (budget.estimatedCostUSD ?? 0) > budget.limits.maxCostUSD) reasons.push(`Estimated cost $${budget.estimatedCostUSD!.toFixed(2)} exceeds the $${budget.limits.maxCostUSD.toFixed(2)} budget.`)
    if (includeEstimate && budget.limits.maxTokens > 0 && (budget.estimatedTokens ?? 0) > budget.limits.maxTokens) reasons.push(`Estimated tokens ${budget.estimatedTokens} exceed the ${budget.limits.maxTokens} token budget.`)
    if (reasons.length) {
      budget.status = "exceeded"
      budget.reason = reasons.join(" ")
      return
    }
    const ratios = [
      budget.limits.maxCostUSD > 0 ? budget.actualCostUSD / budget.limits.maxCostUSD : 0,
      budget.limits.maxTokens > 0 ? budget.actualTokens / budget.limits.maxTokens : 0,
      budget.limits.maxMinutes > 0 ? elapsedMinutes / budget.limits.maxMinutes : 0,
    ]
    const unknownWarning = budget.limits.unknownPricing === "warn" && budget.unknownPriceCalls > 0
    budget.status = Math.max(...ratios) >= 0.8 || unknownWarning ? "warning" : "active"
    if (unknownWarning) budget.reason = `${budget.unknownPriceCalls} call(s) have unknown pricing and are excluded from the USD total.`
    else delete budget.reason
  }

  private isPersistedNode(value: unknown): value is PersistedRunNode {
    if (!value || typeof value !== "object") return false
    const node = value as Partial<PersistedRunNode>
    const statuses: RunNodeStatus[] = ["pending", "queued", "running", "succeeded", "failed", "blocked", "cancelled"]
    return typeof node.id === "string"
      && typeof node.description === "string"
      && typeof node.agent === "string"
      && typeof node.status === "string"
      && statuses.includes(node.status as RunNodeStatus)
      && typeof node.depth === "number"
      && Array.isArray(node.dependsOn)
      && typeof node.contract === "object"
      && node.contract !== null
      && Array.isArray(node.contract.inputs)
      && Array.isArray(node.contract.acceptanceCriteria)
      && Array.isArray(node.contract.allowedPaths)
      && Array.isArray(node.contract.exclusiveResources)
      && typeof node.contract.objective === "string"
      && typeof node.contract.deliverable === "string"
      && typeof node.contract.delegation === "object"
      && node.contract.delegation !== null
      && typeof node.childrenStarted === "number"
      && typeof node.started === "boolean"
      && (node.attempt === undefined || typeof node.attempt === "number")
  }
}
