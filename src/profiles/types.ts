import type { ProfileName } from "../config/schema.js"

export type WorkerName =
  | "orch-repo"
  | "orch-docs"
  | "orch-tests"
  | "orch-research"
  | "orch-critic"
  | "orch-security"
  | "orch-visual-reference"
  | "orch-visual-generate"
  | "orch-visual-review"

export interface ProfileDefinition {
  name: ProfileName
  purpose: string
  workflow: string[]
  workers: WorkerName[]
  output: string[]
}
