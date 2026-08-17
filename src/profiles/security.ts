import type { ProfileDefinition } from "./types.js"

export const securityProfile: ProfileDefinition = {
  name: "security",
  purpose: "Identify realistic attack paths and authorization, data-handling, and dependency risks without making unsupported claims.",
  workflow: [
    "Establish assets, trust boundaries, and attacker capabilities.",
    "Inspect the relevant code and configuration paths.",
    "Validate each issue with a concrete exploit scenario or evidence.",
    "Rank findings by impact and likelihood and suggest mitigations.",
  ],
  workers: ["orch-security", "orch-repo", "orch-docs", "orch-critic"],
  output: ["threat model", "validated findings", "severity", "mitigations", "verification"],
}
