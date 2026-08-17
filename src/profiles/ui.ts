import type { ProfileDefinition } from "./types.js"

export const uiProfile: ProfileDefinition = {
  name: "ui",
  purpose: "Define what users should see, understand, and do across interaction states and viewport sizes.",
  workflow: [
    "Inspect the current UI system and constraints.",
    "Collect relevant visual references and interaction patterns.",
    "Define hierarchy, layout, states, motion, and accessibility.",
    "Review the proposal against the actual product context.",
  ],
  workers: ["orch-repo", "orch-visual-reference", "orch-visual-generate", "orch-visual-review", "orch-critic"],
  output: ["visual direction", "interaction states", "responsive behavior", "component plan", "accessibility notes"],
}
