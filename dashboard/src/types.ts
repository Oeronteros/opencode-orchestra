export type BudgetMode = "eco" | "balanced" | "quality" | "ebobo"

export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface AggregateRow {
  id: string
  calls: number
  cost: number
  tokens: TokenUsage
}

export interface ActivityRow {
  id: string
  sessionID: string
  cost: number
  agent?: string
  model?: string
  provider?: string
  createdAt?: number
  completedAt?: number
  finish?: string
  tokens: TokenUsage
}

export interface DashboardConfig {
  budget: BudgetMode
  models: {
    strategy: "auto" | "manual"
    agents: Record<string, string>
  }
  telemetry: { enabled: boolean }
}

export interface Snapshot {
  updatedAt: string
  project: string
  directory: string
  configPath: string
  config: DashboardConfig
  summary: {
    sessions: number
    calls: number
    cost: number
    tokens: TokenUsage
  }
  models: AggregateRow[]
  agents: AggregateRow[]
  activity: ActivityRow[]
  daily: Array<{ date: string; cost: number; input: number; output: number; reasoning: number }>
  mcp: Record<"context7" | "codebaseMemory" | "memoryGraph" | "supermemory", boolean>
}
