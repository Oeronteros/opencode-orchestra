import assert from "node:assert/strict"
import test from "node:test"
import { BUILTIN_EVAL_CASES, createEvalReport, runEvalSuite, type EvalMode } from "../src/evals/harness.js"

test("built-in eval suite is reproducible and aggregates observed success, time, and cost", async () => {
  const modes: EvalMode[] = ["solo", "balanced"]
  const observations = await runEvalSuite({
    async execute(testCase, mode) {
      return {
        success: mode === "balanced",
        durationMs: mode === "solo" ? 100 : 60,
        costUSD: mode === "solo" ? 0.01 : 0.03,
        tokens: mode === "solo" ? 100 : 300,
        evidence: [testCase.acceptanceCriteria[0]!],
      }
    },
  }, modes, BUILTIN_EVAL_CASES.slice(0, 2))
  const report = createEvalReport(observations)
  assert.equal(report.cases.length, BUILTIN_EVAL_CASES.length)
  assert.equal(report.structural.length, BUILTIN_EVAL_CASES.length * 5)
  assert.equal(report.observed.find((row) => row.mode === "solo")?.successRate, 0)
  assert.equal(report.observed.find((row) => row.mode === "balanced")?.successRate, 1)
  assert.equal(report.observed.find((row) => row.mode === "balanced")?.meanCostUSD, 0.03)
})

test("eval baseline flags material quality, time, and cost regressions", () => {
  const baseline = createEvalReport([{ caseId: BUILTIN_EVAL_CASES[0]!.id, mode: "quality", success: true, durationMs: 100, costUSD: 1, tokens: 100 }])
  const current = createEvalReport([{ caseId: BUILTIN_EVAL_CASES[0]!.id, mode: "quality", success: false, durationMs: 130, costUSD: 1.3, tokens: 100 }], baseline)
  assert.equal(current.regressions.length, 3)
})
