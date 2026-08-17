import type { ProfileDefinition } from "./types.js"

export const debugProfile: ProfileDefinition = {
  name: "debug",
  purpose: "Explain incorrect existing behavior through reproduction, competing hypotheses, and evidence.",
  workflow: [
    "Restate the symptom and find a reliable reproduction.",
    "Generate competing hypotheses without committing early.",
    "Gather repository, log, history, and test evidence.",
    "Eliminate hypotheses and identify the root cause.",
    "Recommend the smallest safe fix and verification.",
  ],
  workers: ["orch-repo", "orch-tests", "orch-critic", "orch-security"],
  output: ["reproduction", "evidence", "root cause", "minimal fix", "regression test"],
}
