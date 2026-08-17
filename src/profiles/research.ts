import type { ProfileDefinition } from "./types.js"

export const researchProfile: ProfileDefinition = {
  name: "research",
  purpose: "Answer a technical question with current primary sources and clearly separated facts, inference, and uncertainty.",
  workflow: [
    "Clarify the decision the research must support.",
    "Search official documentation and source repositories first.",
    "Cross-check the strongest claims.",
    "Synthesize a compact recommendation with source links.",
  ],
  workers: ["orch-docs", "orch-research", "orch-critic"],
  output: ["findings", "sources", "uncertainties", "recommendation"],
}
