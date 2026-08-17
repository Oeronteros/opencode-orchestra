import type { ProfileDefinition } from "./types.js"

export const architectureProfile: ProfileDefinition = {
  name: "architecture",
  purpose: "Design correct module boundaries, APIs, data flow, dependencies, and migration paths before implementation.",
  workflow: [
    "Map the current architecture and existing conventions.",
    "Collect relevant repository and upstream evidence.",
    "Develop two or three viable options with trade-offs.",
    "Recommend the smallest coherent design and identify risks.",
  ],
  workers: ["orch-repo", "orch-docs", "orch-research", "orch-critic"],
  output: ["recommended design", "alternatives", "trade-offs", "module boundaries", "implementation handoff"],
}
