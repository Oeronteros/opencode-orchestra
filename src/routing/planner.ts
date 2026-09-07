import type { ProfileName } from "../config/schema.js"
import type { TaskContract } from "../orchestration/contracts.js"
import { validateOwnership } from "../orchestration/ownership.js"
import { PROFILE_CATALOG } from "../profiles/catalog.js"

/** A node in the dependency-aware specialist execution DAG. */
export interface PlanNode {
  id: string
  description: string
  worker: string
  dependsOn: string[]
  role: "specialist" | "reviewer" | "merger" | "editor" | "integrator"
  contract: TaskContract
  ownership?: string[]
  worktree?: { branch: string; path: string; baseRevision: string }
}

export interface TaskPlan {
  nodes: PlanNode[]
  /** Topologically ordered dispatch waves. Nodes in one level may run concurrently. */
  levels: string[][]
  maxParallel: number
  mergerNodeId?: string
  integratorNodeId?: string
}

export interface PlanOptions {
  secondaryWorkers?: string[]
  maxNodes?: number
  includeEvidence?: boolean
  dependencyAware?: boolean
  includeMerger?: boolean
  includeJudge?: boolean
  editorPartitions?: Array<{
    id?: string
    description: string
    ownership: string[]
    inputs?: string[]
    acceptanceCriteria?: string[]
    exclusiveResources?: string[]
    delegationMaxChildren?: number
  }>
  includeIntegrator?: boolean
}

const REVIEWERS = new Set(["orch-critic", "orch-security", "orch-visual-review"])

function evidenceContract(profile: ProfileName, worker: string, role: "specialist" | "reviewer", inputs: string[]): TaskContract {
  const objective = role === "specialist"
    ? "Investigate an independent " + profile + " branch using " + worker + "."
    : "Cross-check specialist evidence using " + worker + "."
  return {
    objective,
    inputs,
    deliverable: role === "specialist"
      ? "Evidence-backed findings for the assigned " + profile + " branch."
      : "An independent review that confirms, challenges, or qualifies the specialist findings.",
    acceptanceCriteria: role === "specialist"
      ? ["Support conclusions with concrete evidence.", "State material uncertainty and unresolved risks."]
      : ["Check every supplied specialist result.", "Report contradictions and missing evidence explicitly."],
    allowedPaths: [],
    exclusiveResources: [],
    delegation: { allowed: worker !== "orch-visual-generate", maxChildren: worker === "orch-visual-generate" ? 0 : 1 },
  }
}

function sameStrings(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const a = [...left].sort()
  const b = [...right].sort()
  return a.every((value, index) => value === b[index])
}

export function planTask(profile: ProfileName, secondaryProfiles: ProfileName[] = [], options: PlanOptions = {}): TaskPlan {
  const maxNodes = Math.max(1, options.maxNodes ?? 6)
  const includeEvidence = options.includeEvidence ?? true
  const dependencyAware = options.dependencyAware ?? true
  const includeMerger = options.includeMerger ?? (dependencyAware && includeEvidence)
  const workerLimit = Math.max(0, maxNodes - (includeMerger ? 1 : 0) - (options.includeJudge ? 1 : 0))
  const primary: string[] = []
  const reviewers: string[] = []
  const seen = new Set<string>()
  const add = (worker: string) => {
    if (seen.has(worker) || worker === "orch-merge") return
    seen.add(worker)
    ;(REVIEWERS.has(worker) ? reviewers : primary).push(worker)
  }
  if (includeEvidence) {
    for (const worker of PROFILE_CATALOG[profile].workers) add(worker)
    for (const secondary of secondaryProfiles) for (const worker of PROFILE_CATALOG[secondary].workers) add(worker)
    for (const worker of options.secondaryWorkers ?? []) add(worker)
  }

  const selectedPrimary = primary.slice(0, workerLimit)
  const selectedReviewers = reviewers.slice(0, Math.max(0, workerLimit - selectedPrimary.length))
  const nodes: PlanNode[] = []
  const levels: string[][] = []

  const first = selectedPrimary.map((worker, i) => {
    const contract = evidenceContract(profile, worker, "specialist", [])
    const node: PlanNode = { id: "n0-" + i, description: contract.objective, worker, dependsOn: [], role: "specialist", contract }
    nodes.push(node); return node.id
  })
  if (first.length) levels.push(first)

  let evidence = first
  if (selectedReviewers.length) {
    const review = selectedReviewers.map((worker, i) => {
      const deps = dependencyAware ? first : []
      const contract = evidenceContract(profile, worker, "reviewer", deps)
      const node: PlanNode = { id: "n1-" + i, description: contract.objective, worker, dependsOn: deps, role: "reviewer", contract }
      nodes.push(node); return node.id
    })
    if (dependencyAware) levels.push(review)
    else if (levels[0]) levels[0].push(...review)
    else levels.push(review)
    evidence = [...first, ...review]
  }

  let mergerNodeId: string | undefined
  if (includeMerger) {
    mergerNodeId = "merge"
    const description = "Merge all completed specialist outputs into one evidence-backed handoff, preserving conflicts and provenance."
    nodes.push({
      id: mergerNodeId,
      description,
      worker: "orch-merge",
      dependsOn: evidence,
      role: "merger",
      contract: {
        objective: description,
        inputs: evidence,
        deliverable: "One synthesized handoff with preserved evidence, provenance, conflicts, and uncertainty.",
        acceptanceCriteria: ["Represent every supplied result.", "Preserve unresolved conflicts and source provenance."],
        allowedPaths: [],
        exclusiveResources: [],
        delegation: { allowed: false, maxChildren: 0 },
      },
    })
    levels.push([mergerNodeId])
  }

  if (options.includeJudge) {
    const dependsOn = mergerNodeId ? [mergerNodeId] : evidence
    nodes.push({
      id: "judge", worker: "orch-judge", role: "reviewer", dependsOn,
      description: "Arbitrate remaining conflicts and critical conclusions.",
      contract: {
        objective: "Arbitrate remaining conflicts and critical conclusions.",
        inputs: dependsOn, deliverable: "Evidence-backed arbitration with unresolved risks.",
        acceptanceCriteria: ["Check critical conclusions and explain each arbitration decision."],
        allowedPaths: [], exclusiveResources: [], delegation: { allowed: false, maxChildren: 0 },
      },
    })
    levels.push(["judge"])
  }

  let integratorNodeId: string | undefined
  const partitions = options.editorPartitions ?? []
  if (partitions.length) {
    const editorDeps = mergerNodeId ? [mergerNodeId] : evidence
    const editorIds: string[] = []
    for (let i = 0; i < partitions.length; i++) {
      const partition = partitions[i]!
      const id = partition.id ?? "editor-" + i
      const delegationMaxChildren = partition.delegationMaxChildren ?? 0
      nodes.push({
        id,
        description: partition.description,
        worker: "orch-editor",
        dependsOn: editorDeps,
        role: "editor",
        ownership: partition.ownership,
        contract: {
          objective: partition.description,
          inputs: partition.inputs ?? editorDeps,
          deliverable: "A committed implementation limited to the assigned ownership partition, with scoped verification evidence.",
          acceptanceCriteria: partition.acceptanceCriteria ?? ["Modify only allowed paths.", "Run and report scoped verification."],
          allowedPaths: [...partition.ownership],
          exclusiveResources: partition.exclusiveResources ?? [],
          delegation: { allowed: delegationMaxChildren > 0, maxChildren: delegationMaxChildren },
        },
      })
      editorIds.push(id)
    }
    levels.push(editorIds)
    if (options.includeIntegrator ?? true) {
      integratorNodeId = "integrator"
      const description = "Integrate validated editor commits in deterministic order."
      nodes.push({
        id: integratorNodeId,
        description,
        worker: "orch-integrator",
        dependsOn: editorIds,
        role: "integrator",
        contract: {
          objective: description,
          inputs: editorIds,
          deliverable: "One deterministic integration of all validated editor commits.",
          acceptanceCriteria: ["Integrate only validated commits.", "Stop without partial integration on ownership or Git conflicts."],
          allowedPaths: [],
          exclusiveResources: [],
          delegation: { allowed: false, maxChildren: 0 },
        },
      })
      levels.push([integratorNodeId])
    }
  }
  return { nodes, levels, maxParallel: levels.reduce((max, level) => Math.max(max, level.length), 0), ...(mergerNodeId ? { mergerNodeId } : {}), ...(integratorNodeId ? { integratorNodeId } : {}) }
}

export function validatePlan(plan: TaskPlan): string[] {
  const byId = new Map<string, PlanNode>()
  const problems: string[] = []
  for (const node of plan.nodes) {
    if (byId.has(node.id)) problems.push("duplicate node " + node.id)
    if (!node.contract || !node.contract.objective.trim()) problems.push("node " + node.id + " has an empty contract objective")
    if (!node.contract || !node.contract.deliverable.trim()) problems.push("node " + node.id + " has an empty contract deliverable")
    if (!node.contract || node.contract.acceptanceCriteria.length === 0 || node.contract.acceptanceCriteria.some((criterion) => !criterion.trim())) problems.push("node " + node.id + " has empty contract acceptance criteria")
    if (node.contract && node.contract.delegation.maxChildren < 0) problems.push("node " + node.id + " has negative delegation maxChildren")
    if (node.contract && (node.role === "merger" || node.role === "integrator") && (node.contract.delegation.allowed || node.contract.delegation.maxChildren !== 0)) problems.push(node.role + " node " + node.id + " must not delegate")
    if (node.contract && (node.role === "specialist" || node.role === "reviewer") && node.contract.delegation.maxChildren > 1) problems.push(node.role + " node " + node.id + " exceeds delegation maxChildren 1")
    if (node.role === "editor" && (!node.ownership || node.ownership.length === 0)) problems.push("editor node " + node.id + " has no ownership")
    if (node.role === "editor" && node.contract && !sameStrings(node.ownership ?? [], node.contract.allowedPaths)) problems.push("editor node " + node.id + " ownership does not match contract allowedPaths")
    byId.set(node.id, node)
  }
  problems.push(...validateOwnership(plan.nodes.filter((node) => node.role === "editor").map((node) => ({ id: node.id, paths: node.ownership ?? [] }))))
  const visiting = new Set<string>(), visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) { problems.push("cycle includes " + id); return }
    if (visited.has(id)) return
    const node = byId.get(id); if (!node) return
    visiting.add(id)
    for (const dep of node.dependsOn) {
      if (!byId.has(dep)) problems.push("node " + id + " references unknown dependency " + dep)
      else if (dep === id) problems.push("node " + id + " depends on itself")
      else visit(dep)
    }
    visiting.delete(id); visited.add(id)
  }
  for (const node of plan.nodes) visit(node.id)

  const dependsTransitivelyOn = (from: PlanNode, targetId: string): boolean => {
    const pending = [...from.dependsOn]
    const checked = new Set<string>()
    while (pending.length) {
      const id = pending.pop()!
      if (id === targetId) return true
      if (checked.has(id)) continue
      checked.add(id)
      const dependency = byId.get(id)
      if (dependency) pending.push(...dependency.dependsOn)
    }
    return false
  }
  for (let i = 0; i < plan.nodes.length; i++) {
    const left = plan.nodes[i]!
    for (let j = i + 1; j < plan.nodes.length; j++) {
      const right = plan.nodes[j]!
      if (dependsTransitivelyOn(left, right.id) || dependsTransitivelyOn(right, left.id)) continue
      const rightResources = new Set(right.contract?.exclusiveResources ?? [])
      for (const resource of new Set(left.contract?.exclusiveResources ?? [])) {
        if (rightResources.has(resource)) problems.push("independent nodes " + left.id + " and " + right.id + " share exclusive resource " + resource)
      }
    }
  }
  return [...new Set(problems)]
}
