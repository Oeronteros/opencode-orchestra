export type PermissionAction = "allow" | "ask" | "deny"

/** Engine-enforced shell policy shared by agents that run verification. */
export function safeBashPermissions(defaultAction: PermissionAction = "allow"): Record<string, PermissionAction> {
  return {
    "*": defaultAction,
    "rm -rf*": "deny",
    "git reset --hard*": "deny",
    "git clean -f*": "deny",
    "git clean -df*": "deny",
    "git push --force*": "deny",
    "git push -f*": "deny",
    "mkfs*": "deny",
    "dd *": "deny",
    "Remove-Item * -Recurse*": "deny",
    "Format-Volume*": "deny",
    "Clear-Disk*": "deny",
  }
}

const GIT_READ_TOOL_NAMES = [
  "git_status",
  "git_diff_unstaged",
  "git_diff_staged",
  "git_diff",
  "git_log",
  "git_show",
  "git_branch",
] as const

/** Read-only Git MCP policy for repository scouts. */
export function readOnlyGitPermissions(): Record<string, PermissionAction> {
  const permissions: Record<string, PermissionAction> = { "git_*": "deny" }
  for (const tool of GIT_READ_TOOL_NAMES) {
    permissions[tool] = "allow"
    permissions[`git_${tool}`] = "allow"
  }
  return permissions
}

/** Git MCP policy for the lead: reads are autonomous, mutations are gated. */
export function leadGitPermissions(): Record<string, PermissionAction> {
  return {
    ...readOnlyGitPermissions(),
    "git_git_add": "ask",
    "git_git_commit": "ask",
    "git_git_create_branch": "ask",
    "git_git_checkout": "ask",
    "git_git_reset": "deny",
    git_add: "ask",
    git_commit: "ask",
    git_create_branch: "ask",
    git_checkout: "ask",
    git_reset: "deny",
  }
}

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
