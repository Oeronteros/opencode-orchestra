/** Explicit handoff contract attached to every orchestration plan node. */
export interface TaskContract {
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
