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
  strategy?: ResearchSwarmStrategy
}

export interface ResearchSwarmStrategy {
  kind: "research-swarm"
  rounds: Array<{
    id: "hypotheses" | "cross-pollination" | "synthesis" | "arbitration"
    objective: string
    nodeIds: string[]
  }>
  sharedLedger: {
    requiredFields: string[]
    propagation: "dependency-results"
  }
  allocation: "second-round workers rank all first-round results and spend their effort on the most promising surviving directions"
}

export interface PlanOptions {
  secondaryWorkers?: string[]
  maxNodes?: number
  includeEvidence?: boolean
  dependencyAware?: boolean
  includeMerger?: boolean
  includeJudge?: boolean
  researchSwarm?: boolean
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

const SWARM_LEDGER_FIELDS = [
  "hypothesis",
  "approach",
  "evidence",
  "attempted verification",
  "counterexamples or failure modes",
  "reusable intermediate results",
  "confidence",
  "open questions",
]

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

function planResearchSwarm(
  profile: ProfileName,
  primary: string[],
  reviewers: string[],
  maxNodes: number,
  includeMerger: boolean,
  includeJudge: boolean,
): TaskPlan | undefined {
  const candidates = [...primary, ...reviewers]
  if (candidates.length === 0 || maxNodes < 4) return undefined

  const reservedForJudge = includeJudge ? 1 : 0
  const reservedForMerger = includeMerger ? 1 : 0
  const researchSlots = maxNodes - reservedForJudge - reservedForMerger
  if (researchSlots < 2) return undefined

  // Spend roughly two thirds of the research budget on independent search and
  // the rest on result-aware refinement. With the default eight-node cap this
  // produces 4 hypothesis nodes, 2 cross-pollination nodes, merge, and judge.
  const refinementCount = Math.max(1, Math.floor(researchSlots / 3))
  const hypothesisCount = researchSlots - refinementCount
  const orderedHypothesisWorkers = [...primary, ...reviewers]
  const hypothesisWorkers = Array.from(
    { length: hypothesisCount },
    (_, index) => orderedHypothesisWorkers[index % orderedHypothesisWorkers.length]!,
  )
  const unused = new Set(hypothesisWorkers)
  const orderedRefinementWorkers = [
    ...reviewers.filter((worker) => !unused.has(worker)),
    ...primary.filter((worker) => !unused.has(worker)),
    ...reviewers,
    ...primary,
  ]
  const refinementWorkers = Array.from(
    { length: refinementCount },
    (_, index) => orderedRefinementWorkers[index % orderedRefinementWorkers.length]!,
  )

  const nodes: PlanNode[] = []
  const hypothesisIds = hypothesisWorkers.map((worker, index) => {
    const id = `hypothesis-${index}`
    const objective = `Independently develop and test a distinct ${profile} hypothesis using ${worker}; do not converge on another branch's approach.`
    nodes.push({
      id,
      description: objective,
      worker,
      dependsOn: [],
      role: "specialist",
      contract: {
        objective,
        inputs: [],
        deliverable: `A structured hypothesis ledger entry containing: ${SWARM_LEDGER_FIELDS.join(", ")}.`,
        acceptanceCriteria: [
          "Pursue a concrete approach far enough to expose a proof path, computation, experiment, or decisive blocker.",
          "Actively try to falsify the hypothesis before reporting it as promising.",
          "Separate established facts, new deductions, assumptions, and speculation.",
          "Record failed attempts and reusable intermediate results so later rounds do not repeat them.",
        ],
        allowedPaths: [],
        exclusiveResources: [],
        delegation: { allowed: false, maxChildren: 0 },
      },
    })
    return id
  })

  const refinementIds = refinementWorkers.map((worker, index) => {
    const id = `refinement-${index}`
    const focus = index % 2 === 0
      ? "Rank every first-round direction, combine compatible insights, and deepen the strongest surviving approach."
      : "Adversarially test every first-round direction, eliminate unsound paths, then repair or branch from the strongest remaining approach."
    const objective = `${focus} Use ${worker} and spend effort according to evidence rather than equal treatment.`
    nodes.push({
      id,
      description: objective,
      worker,
      dependsOn: [...hypothesisIds],
      role: "reviewer",
      contract: {
        objective,
        inputs: [...hypothesisIds],
        deliverable: `An updated shared hypothesis ledger containing: ${SWARM_LEDGER_FIELDS.join(", ")}, plus an explicit ranking and resource-allocation decision.`,
        acceptanceCriteria: [
          "Account for every first-round result and cite its node ID.",
          "Rank directions using correctness, novelty, tractability, and independent verifiability.",
          "Concentrate the remaining analysis on the strongest direction while preserving useful results from rejected branches.",
          "Provide a concrete verification attempt and state what would still invalidate the conclusion.",
        ],
        allowedPaths: [],
        exclusiveResources: [],
        delegation: { allowed: false, maxChildren: 0 },
      },
    })
    return id
  })

  const levels = [hypothesisIds, refinementIds]
  const rounds: ResearchSwarmStrategy["rounds"] = [
    { id: "hypotheses", objective: "Explore diverse independent hypotheses and record both progress and dead ends.", nodeIds: hypothesisIds },
    { id: "cross-pollination", objective: "Share results, falsify weak directions, and reallocate effort to the strongest surviving approaches.", nodeIds: refinementIds },
  ]
  const allResearchIds = [...hypothesisIds, ...refinementIds]
  let mergerNodeId: string | undefined
  if (includeMerger) {
    mergerNodeId = "merge"
    const objective = "Consolidate the complete hypothesis ledger into one traceable candidate result without hiding failed approaches or unresolved gaps."
    nodes.push({
      id: mergerNodeId,
      description: objective,
      worker: "orch-merge",
      dependsOn: allResearchIds,
      role: "merger",
      contract: {
        objective,
        inputs: allResearchIds,
        deliverable: "One candidate result with full node provenance, the surviving argument or artifact, rejected directions, verification evidence, and unresolved obligations.",
        acceptanceCriteria: [
          "Represent every supplied ledger entry and preserve its node provenance.",
          "Distinguish verified conclusions from plausible hypotheses and unsupported speculation.",
          "Expose any missing proof step, failed check, counterexample, or reproducibility gap.",
        ],
        allowedPaths: [],
        exclusiveResources: [],
        delegation: { allowed: false, maxChildren: 0 },
      },
    })
    levels.push([mergerNodeId])
    rounds.push({ id: "synthesis", objective, nodeIds: [mergerNodeId] })
  }

  if (includeJudge) {
    const dependencies = mergerNodeId ? [mergerNodeId] : allResearchIds
    const objective = "Independently arbitrate the candidate result and reject completion unless its central claim survives the stated verification standard."
    nodes.push({
      id: "judge",
      description: objective,
      worker: "orch-judge",
      dependsOn: dependencies,
      role: "reviewer",
      contract: {
        objective,
        inputs: dependencies,
        deliverable: "A verdict of verified, provisionally supported, falsified, or unresolved, with precise reasons and remaining verification obligations.",
        acceptanceCriteria: [
          "Check the central claim independently instead of trusting the synthesis.",
          "Treat failed formal checks, computations, tests, or missing proof steps as unresolved rather than success.",
          "Explain the evidence behind the verdict and identify the weakest remaining link.",
        ],
        allowedPaths: [],
        exclusiveResources: [],
        delegation: { allowed: false, maxChildren: 0 },
      },
    })
    levels.push(["judge"])
    rounds.push({ id: "arbitration", objective, nodeIds: ["judge"] })
  }

  return {
    nodes,
    levels,
    maxParallel: levels.reduce((max, level) => Math.max(max, level.length), 0),
    ...(mergerNodeId ? { mergerNodeId } : {}),
    strategy: {
      kind: "research-swarm",
      rounds,
      sharedLedger: { requiredFields: [...SWARM_LEDGER_FIELDS], propagation: "dependency-results" },
      allocation: "second-round workers rank all first-round results and spend their effort on the most promising surviving directions",
    },
  }
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

  if (options.researchSwarm && includeEvidence && dependencyAware) {
    const swarm = planResearchSwarm(profile, primary, reviewers, maxNodes, includeMerger, options.includeJudge ?? false)
    if (swarm) return swarm
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
