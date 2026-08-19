import type { ProfileName } from "../config/schema.js"

/** A node in the dependency-aware specialist execution DAG. */
export interface PlanNode {
  id: string
  description: string
  worker: string
  dependsOn: string[]
  role: "specialist" | "reviewer" | "merger"
}

export interface TaskPlan {
  nodes: PlanNode[]
  /** Topologically ordered dispatch waves. Nodes in one level may run concurrently. */
  levels: string[][]
  maxParallel: number
  mergerNodeId?: string
}

const PROFILE_WORKERS: Partial<Record<ProfileName, string[]>> = {
  architecture: ["orch-repo", "orch-research", "orch-critic"],
  debug: ["orch-repo", "orch-tests", "orch-critic"],
  ui: ["orch-visual-reference", "orch-visual-review", "orch-repo"],
  research: ["orch-research", "orch-docs", "orch-critic"],
  review: ["orch-critic", "orch-repo", "orch-tests"],
  security: ["orch-security", "orch-repo", "orch-critic"],
  performance: ["orch-tests", "orch-repo", "orch-critic"],
  migration: ["orch-repo", "orch-tests", "orch-research"],
  ops: ["orch-repo", "orch-research", "orch-tests"],
}

export interface PlanOptions {
  secondaryWorkers?: string[]
  maxNodes?: number
  dependencyAware?: boolean
  includeMerger?: boolean
}

const REVIEWERS = new Set(["orch-critic", "orch-security", "orch-visual-review"])

export function planTask(profile: ProfileName, secondaryProfiles: ProfileName[] = [], options: PlanOptions = {}): TaskPlan {
  const maxNodes = Math.max(1, options.maxNodes ?? 6)
  const dependencyAware = options.dependencyAware ?? true
  const includeMerger = options.includeMerger ?? dependencyAware
  const workerLimit = Math.max(0, maxNodes - (includeMerger ? 1 : 0))
  const primary: string[] = []
  const reviewers: string[] = []
  const seen = new Set<string>()
  const add = (worker: string) => {
    if (seen.has(worker) || worker === "orch-merge") return
    seen.add(worker)
    ;(REVIEWERS.has(worker) ? reviewers : primary).push(worker)
  }
  for (const worker of PROFILE_WORKERS[profile] ?? []) add(worker)
  for (const secondary of secondaryProfiles) for (const worker of PROFILE_WORKERS[secondary] ?? []) add(worker)
  for (const worker of options.secondaryWorkers ?? []) add(worker)

  const selectedPrimary = primary.slice(0, workerLimit)
  const selectedReviewers = reviewers.slice(0, Math.max(0, workerLimit - selectedPrimary.length))
  const nodes: PlanNode[] = []
  const levels: string[][] = []

  const first = selectedPrimary.map((worker, i) => {
    const node: PlanNode = { id: "n0-" + i, description: "Investigate an independent " + profile + " branch using " + worker + ".", worker, dependsOn: [], role: "specialist" }
    nodes.push(node); return node.id
  })
  if (first.length) levels.push(first)

  let evidence = first
  if (selectedReviewers.length) {
    const review = selectedReviewers.map((worker, i) => {
      const deps = dependencyAware ? first : []
      const node: PlanNode = { id: "n1-" + i, description: "Cross-check specialist evidence using " + worker + ".", worker, dependsOn: deps, role: "reviewer" }
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
    nodes.push({ id: mergerNodeId, description: "Merge all completed specialist outputs into one evidence-backed handoff, preserving conflicts and provenance.", worker: "orch-merge", dependsOn: evidence, role: "merger" })
    levels.push([mergerNodeId])
  }

  return { nodes, levels, maxParallel: levels.reduce((max, level) => Math.max(max, level.length), 0), ...(mergerNodeId ? { mergerNodeId } : {}) }
}

export function validatePlan(plan: TaskPlan): string[] {
  const byId = new Map<string, PlanNode>()
  const problems: string[] = []
  for (const node of plan.nodes) {
    if (byId.has(node.id)) problems.push("duplicate node " + node.id)
    byId.set(node.id, node)
  }
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
  return [...new Set(problems)]
}
