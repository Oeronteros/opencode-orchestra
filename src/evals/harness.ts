import { readFile, writeFile } from "node:fs/promises"
import type { ProfileName } from "../config/schema.js"
import { planTask } from "../routing/planner.js"

export type EvalMode = "solo" | "eco" | "balanced" | "quality" | "ebobo"

export interface EvalCase {
  id: string
  title: string
  profile: ProfileName
  prompt: string
  acceptanceCriteria: string[]
  requiredWorkers: string[]
}

export interface EvalObservation {
  caseId: string
  mode: EvalMode
  success: boolean
  durationMs: number
  costUSD: number
  tokens: number
  evidence?: string[]
}

export interface EvalMetricRow {
  mode: EvalMode
  runs: number
  successes: number
  successRate: number
  meanDurationMs: number
  meanCostUSD: number
  meanTokens: number
}

export interface StructuralEvalRow {
  caseId: string
  mode: EvalMode
  workerCoverage: number
  plannedNodes: number
  parallelSteps: number
  missingWorkers: string[]
}

export interface EvalReport {
  schemaVersion: 1
  suiteVersion: string
  createdAt: number
  cases: EvalCase[]
  structural: StructuralEvalRow[]
  observed: EvalMetricRow[]
  regressions: string[]
}

export interface EvalExecutor {
  execute(testCase: EvalCase, mode: EvalMode): Promise<Omit<EvalObservation, "caseId" | "mode">>
}

export const BUILTIN_EVAL_CASES: EvalCase[] = [
  {
    id: "debug-cache-invalidation",
    title: "Cross-layer cache invalidation regression",
    profile: "debug",
    prompt: "Find and fix a stale cache value that survives a successful write, then prove the regression is covered.",
    acceptanceCriteria: ["Reproduce the stale read.", "Identify the invalidation boundary.", "Add a regression check that fails before the fix and passes after it."],
    requiredWorkers: ["orch-repo", "orch-tests", "orch-critic"],
  },
  {
    id: "security-authorization-boundary",
    title: "Authorization boundary review",
    profile: "security",
    prompt: "Audit and repair an endpoint whose object lookup can cross tenant boundaries.",
    acceptanceCriteria: ["Show the unauthorized path.", "Enforce tenant ownership.", "Cover allowed and denied access."],
    requiredWorkers: ["orch-repo", "orch-security", "orch-tests"],
  },
  {
    id: "ui-visual-regression",
    title: "Responsive visual regression",
    profile: "ui",
    prompt: "Fix a settings panel that clips its primary action at narrow widths and verify the rendered states.",
    acceptanceCriteria: ["Preserve wide-layout behavior.", "Keep the action reachable at narrow widths.", "Provide rendered-state evidence."],
    requiredWorkers: ["orch-repo", "orch-visual-reference", "orch-visual-review"],
  },
  {
    id: "performance-query-regression",
    title: "Query performance regression",
    profile: "performance",
    prompt: "Explain and repair a query path whose latency increased after a filtering change.",
    acceptanceCriteria: ["Capture a repeatable baseline.", "Locate the new cost.", "Show an improved measurement without changing results."],
    requiredWorkers: ["orch-repo", "orch-tests", "orch-research"],
  },
  {
    id: "architecture-migration-contract",
    title: "Backward-compatible migration",
    profile: "migration",
    prompt: "Plan a storage schema migration while old and new application versions overlap.",
    acceptanceCriteria: ["Define the compatibility window.", "Provide rollout and rollback steps.", "Identify invariants and verification points."],
    requiredWorkers: ["orch-repo", "orch-docs", "orch-critic"],
  },
]

export const EVAL_MODES: EvalMode[] = ["solo", "eco", "balanced", "quality", "ebobo"]

const MODE_NODES: Record<Exclude<EvalMode, "solo">, number> = { eco: 3, balanced: 5, quality: 7, ebobo: 8 }

function structuralRows(cases: EvalCase[]): StructuralEvalRow[] {
  return cases.flatMap((testCase) => EVAL_MODES.map((mode): StructuralEvalRow => {
    if (mode === "solo") {
      return { caseId: testCase.id, mode, workerCoverage: 0, plannedNodes: 1, parallelSteps: 1, missingWorkers: [...testCase.requiredWorkers] }
    }
    const plan = planTask(testCase.profile, [], {
      maxNodes: MODE_NODES[mode], dependencyAware: true, includeMerger: true, includeJudge: mode === "ebobo",
    })
    const workers = new Set(plan.nodes.map((node) => node.worker))
    const missingWorkers = testCase.requiredWorkers.filter((worker) => !workers.has(worker))
    return {
      caseId: testCase.id,
      mode,
      workerCoverage: testCase.requiredWorkers.length === 0 ? 1 : (testCase.requiredWorkers.length - missingWorkers.length) / testCase.requiredWorkers.length,
      plannedNodes: plan.nodes.length,
      parallelSteps: plan.levels.length,
      missingWorkers,
    }
  }))
}

export function aggregateObservations(observations: EvalObservation[]): EvalMetricRow[] {
  return EVAL_MODES.flatMap((mode) => {
    const rows = observations.filter((observation) => observation.mode === mode)
    if (rows.length === 0) return []
    const mean = (select: (row: EvalObservation) => number) => rows.reduce((sum, row) => sum + select(row), 0) / rows.length
    const successes = rows.filter((row) => row.success).length
    return [{
      mode,
      runs: rows.length,
      successes,
      successRate: successes / rows.length,
      meanDurationMs: mean((row) => row.durationMs),
      meanCostUSD: mean((row) => row.costUSD),
      meanTokens: mean((row) => row.tokens),
    }]
  })
}

function compareBaseline(current: EvalMetricRow[], baseline: EvalMetricRow[]): string[] {
  const previous = new Map(baseline.map((row) => [row.mode, row]))
  return current.flatMap((row) => {
    const base = previous.get(row.mode)
    if (!base) return []
    const regressions: string[] = []
    if (row.successRate < base.successRate - 0.05) regressions.push(`${row.mode}: success rate fell from ${(base.successRate * 100).toFixed(1)}% to ${(row.successRate * 100).toFixed(1)}%.`)
    if (base.meanDurationMs > 0 && row.meanDurationMs > base.meanDurationMs * 1.2) regressions.push(`${row.mode}: mean duration increased by more than 20%.`)
    if (base.meanCostUSD > 0 && row.meanCostUSD > base.meanCostUSD * 1.2) regressions.push(`${row.mode}: mean cost increased by more than 20%.`)
    return regressions
  })
}

export async function runEvalSuite(executor: EvalExecutor, modes: EvalMode[] = EVAL_MODES, cases = BUILTIN_EVAL_CASES): Promise<EvalObservation[]> {
  const observations: EvalObservation[] = []
  for (const testCase of cases) {
    for (const mode of modes) observations.push({ caseId: testCase.id, mode, ...await executor.execute(testCase, mode) })
  }
  return observations
}

export function createEvalReport(observations: EvalObservation[] = [], baseline?: EvalReport): EvalReport {
  const observed = aggregateObservations(observations)
  return {
    schemaVersion: 1,
    suiteVersion: "orchestra-core-v1",
    createdAt: Date.now(),
    cases: BUILTIN_EVAL_CASES.map((entry) => ({ ...entry, acceptanceCriteria: [...entry.acceptanceCriteria], requiredWorkers: [...entry.requiredWorkers] })),
    structural: structuralRows(BUILTIN_EVAL_CASES),
    observed,
    regressions: baseline ? compareBaseline(observed, baseline.observed) : [],
  }
}

export async function readEvalObservations(file: string): Promise<EvalObservation[]> {
  const value = JSON.parse(await readFile(file, "utf8")) as unknown
  if (!Array.isArray(value)) throw new Error("Eval results must be a JSON array.")
  const caseIds = new Set(BUILTIN_EVAL_CASES.map((entry) => entry.id))
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`Eval result ${index} is not an object.`)
    const row = raw as Partial<EvalObservation>
    if (!caseIds.has(row.caseId ?? "")) throw new Error(`Eval result ${index} has an unknown caseId.`)
    if (!EVAL_MODES.includes(row.mode as EvalMode)) throw new Error(`Eval result ${index} has an unknown mode.`)
    if (typeof row.success !== "boolean" || ![row.durationMs, row.costUSD, row.tokens].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) {
      throw new Error(`Eval result ${index} has invalid metrics.`)
    }
    return row as EvalObservation
  })
}

export async function readEvalReport(file: string): Promise<EvalReport> {
  const value = JSON.parse(await readFile(file, "utf8")) as EvalReport
  if (value?.schemaVersion !== 1 || !Array.isArray(value.observed)) throw new Error("Baseline is not an Orchestra eval report.")
  return value
}

export async function writeEvalReport(file: string, report: EvalReport): Promise<void> {
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, "utf8")
}

export function formatEvalReport(report: EvalReport): string {
  const lines = [
    `OpenCode Orchestra eval suite ${report.suiteVersion}`,
    `Cases: ${report.cases.length}; structural rows: ${report.structural.length}`,
  ]
  if (report.observed.length === 0) {
    lines.push("Observed metrics: none. Supply --results FILE with caseId, mode, success, durationMs, costUSD, and tokens.")
  } else {
    lines.push("", "Observed mode comparison:")
    for (const row of report.observed) {
      lines.push(`  ${row.mode.padEnd(8)} success=${(row.successRate * 100).toFixed(1)}% time=${Math.round(row.meanDurationMs)}ms cost=$${row.meanCostUSD.toFixed(4)} tokens=${Math.round(row.meanTokens)} runs=${row.runs}`)
    }
  }
  if (report.regressions.length) lines.push("", "Regressions:", ...report.regressions.map((item) => `  - ${item}`))
  return lines.join("\n")
}
