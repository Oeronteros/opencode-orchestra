/** Explicit handoff contract attached to every orchestration plan node. */
export interface TaskContract {
  browser?: import("../browser/policy.js").BrowserTask | undefined
  objective: string
  inputs: string[]
  deliverable: string
  acceptanceCriteria: string[]
  allowedPaths: string[]
  exclusiveResources: string[]
  delegation: {
    allowed: boolean
    maxChildren: number
  }
}
