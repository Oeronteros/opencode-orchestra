import { architectureProfile } from "./architecture.js"
import { debugProfile } from "./debug.js"
import { performanceProfile } from "./performance.js"
import { researchProfile } from "./research.js"
import { securityProfile } from "./security.js"
import type { ProfileDefinition } from "./types.js"
import { uiProfile } from "./ui.js"

const reviewProfile: ProfileDefinition = {
  name: "review",
  purpose: "Review a proposed or completed change for correctness, regressions, maintainability, and missing validation.",
  workflow: ["Understand intent.", "Inspect the diff and surrounding code.", "Validate risks independently.", "Report only actionable findings."],
  workers: ["orch-repo", "orch-tests", "orch-critic", "orch-security"],
  output: ["actionable findings", "risk", "evidence", "suggested validation"],
}

const migrationProfile: ProfileDefinition = {
  name: "migration",
  purpose: "Plan a reversible transition between versions, platforms, schemas, or architectures.",
  workflow: ["Inventory dependencies.", "Identify compatibility gaps.", "Design staged rollout and rollback.", "Define verification gates."],
  workers: ["orch-repo", "orch-docs", "orch-tests", "orch-critic"],
  output: ["migration sequence", "compatibility risks", "rollback", "verification gates"],
}

const opsProfile: ProfileDefinition = {
  name: "ops",
  purpose: "Improve deployment, runtime reliability, observability, and operational recovery.",
  workflow: ["Map the runtime path.", "Inspect deployment and observability configuration.", "Identify failure modes.", "Recommend safe operational changes."],
  workers: ["orch-repo", "orch-docs", "orch-research", "orch-security", "orch-critic"],
  output: ["runtime map", "failure modes", "operational changes", "rollback and alerts"],
}

export const PROFILE_CATALOG: Record<ProfileDefinition["name"], ProfileDefinition> = {
  architecture: architectureProfile,
  debug: debugProfile,
  ui: uiProfile,
  research: researchProfile,
  review: reviewProfile,
  security: securityProfile,
  performance: performanceProfile,
  migration: migrationProfile,
  ops: opsProfile,
}
