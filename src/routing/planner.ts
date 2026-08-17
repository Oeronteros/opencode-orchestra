import type { ProfileName } from "../config/schema.js"

/**
 * A single node in a task's execution DAG. Each node is a self-contained
 * subtask that maps onto one specialist worker. Dependencies are expressed as
 * ids of the nodes that must complete (or at least be dispatched) first.
 */
export interface PlanNode {
  id: string
  description: string
  worker: string
  dependsOn: string[]
}

export interface TaskPlan {
  nodes: PlanNode[]
  levels: string[][]
  maxParallel: number
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
}

const ANALYSTS = new Set(["orch-critic", "orch-security", "orch-visual-review"])

export function planTask(
  profile: ProfileName,
  secondaryProfiles: ProfileName[] = [],
  options: PlanOptions = {},
): TaskPlan {
  const maxNodes = options.maxNodes ?? 6
  const dependencyAware = options.dependencyAware ?? true

  const own = PROFILE_WORKERS[profile] ?? []
  const level0: string[] = []
  const level1: string[] = []
  const seen = new Set<string>()
  for (const worker of own) {
    seen.add(worker)
    ;(ANALYSTS.has(worker) ? level1 : level0).push(worker)
  }
  for (const secondary of secondaryProfiles) {
    for (const worker of PROFILE_WORKERS[secondary] ?? []) {
      if (seen.has(worker)) continue
      seen.add(worker)
      ;(ANALYSTS.has(worker) ? level1 : level0).push(worker)
    }
  }
  for (const worker of options.secondaryWorkers ?? []) {
    if (seen.has(worker)) continue
    seen.add(worker)
    ;(ANALYSTS.has(worker) ? level1 : level0).push(worker)
  }

  const trimmedLevel0 = level0.slice(0, Math.max(1, maxNodes))
  const remaining = maxNodes - trimmedLevel0.length
  const trimmedLevel1 = level1.slice(0, Math.max(0, remaining))

  const nodes: PlanNode[] = []
  const levels: string[][] = []

  if (dependencyAware && trimmedLevel1.length > 0) {
    const l0 = trimmedLevel0.map((worker, i) => {
      const node: PlanNode = {
        id: "n0-" + i,
        description: "Gather primary evidence for the " + profile + " task using " + worker + ".",
        worker,
        dependsOn: [],
      }
      nodes.push(node)
      return node.id
    })
    levels.push(l0)

    const l1 = trimmedLevel1.map((worker, i) => {
      const node: PlanNode = {
        id: "n1-" + i,
        description: "Cross-check the gathered evidence using " + worker + ".",
        worker,
        dependsOn: l0,
      }
      nodes.push(node)
      return node.id
    })
    levels.push(l1)
  } else {
    const flat = [...trimmedLevel0, ...trimmedLevel1].slice(0, maxNodes)
    const l0 = flat.map((worker, i) => {
      const node: PlanNode = {
        id: "n0-" + i,
        description: "Contribute an independent branch for the " + profile + " task using " + worker + ".",
        worker,
        dependsOn: [],
      }
      nodes.push(node)
      return node.id
    })
    levels.push(l0)
  }

  return {
    nodes,
    levels,
    maxParallel: levels.reduce((max, level) => Math.max(max, level.length), 0),
  }
}

export function validatePlan(plan: TaskPlan): string[] {
  const byId = new Map(plan.nodes.map((n) => [n.id, n]))
  const position = new Map(plan.nodes.map((n, i) => [n.id, i]))
  const problems: string[] = []
  for (const node of plan.nodes) {
    if (!byId.has(node.id)) problems.push("missing node " + node.id)
    for (const dep of node.dependsOn) {
      if (!byId.has(dep)) problems.push("node " + node.id + " references unknown dependency " + dep)
      else if (dep === node.id) problems.push("node " + node.id + " depends on itself")
      else if ((position.get(dep) ?? -1) >= (position.get(node.id) ?? 0)) {
        problems.push("node " + node.id + " has a forward/cyclic dependency on " + dep)
      }
    }
  }
  return problems
}
