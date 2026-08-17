import type { ProfileDefinition } from "./types.js"

export const performanceProfile: ProfileDefinition = {
  name: "performance",
  purpose: "Find measured bottlenecks and recommend changes whose benefit can be verified.",
  workflow: [
    "Define the workload and target metric.",
    "Locate likely hot paths and existing instrumentation.",
    "Gather measurements before proposing optimization.",
    "Prioritize by expected impact, risk, and validation cost.",
  ],
  workers: ["orch-repo", "orch-tests", "orch-research", "orch-critic"],
  output: ["baseline", "bottleneck evidence", "ranked optimizations", "measurement plan"],
}
