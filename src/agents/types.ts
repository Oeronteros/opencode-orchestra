export type PermissionAction = "allow" | "ask" | "deny"

export interface RuntimeAgentConfig {
  description: string
  mode: "primary" | "subagent"
  prompt: string
  model?: string
  hidden?: boolean
  temperature?: number
  color?: string
  permission: Record<string, PermissionAction | Record<string, PermissionAction>>
}

export interface AgentSet {
  [name: string]: RuntimeAgentConfig
}
