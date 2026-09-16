import type { PlanNode, TaskPlan } from "../routing/planner.js"

export const ADAPTIVE_TRIGGERS = [
  "reproduction_failed",
  "contradictory_evidence",
  "authorization_boundary",
  "missing_documentation",
  "performance_regression",
  "visual_regression",
  "low_confidence",
  "no_progress",
] as const

export type AdaptiveTrigger = (typeof ADAPTIVE_TRIGGERS)[number]

export interface AdaptiveObservation {
  trigger: AdaptiveTrigger
  detail: string
  evidence?: string[] | undefined
}

export interface AdaptivePlanContext {
  planVersion: number
  nodeIds: string[]
  succeededNodeIds: string[]
  remainingSlots: number
  usedTriggers: string[]
}

const WORKER_FOR_TRIGGER: Record<AdaptiveTrigger, string> = {
  reproduction_failed: "orch-tests",
  contradictory_evidence: "orch-critic",
  authorization_boundary: "orch-security",
  missing_documentation: "orch-docs",
  performance_regression: "orch-tests",
  visual_regression: "orch-visual-review",
  low_confidence: "orch-critic",
  no_progress: "orch-repo",
}

function specialistNode(
  version: number,
  index: number,
  observation: AdaptiveObservation,
  dependsOn: string[],
): PlanNode {
  const evidence = (observation.evidence ?? []).map((item) => item.trim()).filter(Boolean)
  const detail = observation.detail.replace(/\s+/g, " ").trim().slice(0, 800)
  const id = `adapt-v${version}-${index}-${observation.trigger}`
  const worker = WORKER_FOR_TRIGGER[observation.trigger]
  const objective = `Resolve adaptive trigger ${observation.trigger}: ${detail}`
  return {
    id,
    description: objective,
    worker,
    dependsOn,
    role: worker === "orch-critic" || worker === "orch-security" || worker === "orch-visual-review" ? "reviewer" : "specialist",
    contract: {
      objective,
      inputs: [...dependsOn, ...evidence.map((item) => `evidence: ${item}`)],
      deliverable: "A bounded finding that resolves, confirms, or narrows the observed trigger with reproducible evidence.",
      acceptanceCriteria: [
        "Address only the observed trigger and cite the evidence that caused this plan change.",
        "Run or describe a concrete falsification check.",
        "State whether the original plan can continue and identify any remaining blocker.",
      ],
      allowedPaths: [],
      exclusiveResources: [],
      delegation: { allowed: false, maxChildren: 0 },
    },
  }
}

/** Build a small, auditable extension from runtime evidence instead of replanning the whole run. */
export function planAdaptiveExtension(context: AdaptivePlanContext, observations: AdaptiveObservation[]): TaskPlan | undefined {
  if (context.remainingSlots <= 0) return undefined
  const used = new Set(context.usedTriggers.flatMap((trigger) => trigger.split(",")).map((trigger) => trigger.trim()))
  const unique = new Map<AdaptiveTrigger, AdaptiveObservation>()
  for (const observation of observations) {
    if (used.has(observation.trigger) || unique.has(observation.trigger) || !observation.detail.trim()) continue
    unique.set(observation.trigger, observation)
  }
  const candidates = [...unique.values()]
  if (candidates.length === 0) return undefined

  const addMerge = context.remainingSlots >= 2
  const specialistLimit = addMerge ? context.remainingSlots - 1 : 1
  const version = context.planVersion + 1
  const dependencies = [...context.succeededNodeIds]
  const specialists = candidates.slice(0, specialistLimit).map((observation, index) => specialistNode(version, index, observation, dependencies))
  const nodes: PlanNode[] = [...specialists]
  const levels = [specialists.map((node) => node.id)]
  let mergerNodeId: string | undefined
  if (addMerge && specialists.length > 0) {
    mergerNodeId = `adapt-v${version}-merge`
    const specialistIds = specialists.map((node) => node.id)
    nodes.push({
      id: mergerNodeId,
      description: "Integrate the new adaptive evidence with the previously completed plan evidence.",
      worker: "orch-merge",
      dependsOn: specialistIds,
      role: "merger",
      contract: {
        objective: "Integrate the new adaptive evidence with the previously completed plan evidence.",
        inputs: specialistIds,
        deliverable: "A revised evidence-backed handoff that states what changed from the previous plan version.",
        acceptanceCriteria: ["Represent every adaptive finding.", "State which earlier conclusions remain valid, changed, or were invalidated."],
        allowedPaths: [],
        exclusiveResources: [],
        delegation: { allowed: false, maxChildren: 0 },
      },
    })
    levels.push([mergerNodeId])
  }
  return {
    nodes,
    levels,
    maxParallel: Math.max(1, specialists.length),
    ...(mergerNodeId ? { mergerNodeId } : {}),
  }
}
