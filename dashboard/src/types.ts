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
  prompt?: string
  reply?: string
}

export interface DashboardConfig {
  budget: BudgetMode
  models: {
    strategy: "auto" | "manual"
    agents: Record<string, string>
  }
  telemetry: { enabled: boolean; storeTexts: boolean }
}

export interface DailyPoint {
  date: string
  cost: number
  input: number
  output: number
  reasoning: number
}

export interface DailyAnomaly {
  date: string
  cost: number
  baselineMean: number
  threshold: number
  z: number
}

export interface MonthProjection {
  projected: number
  monthToDate: number
  elapsedDays: number
  daysInMonth: number
  isAheadOfPace: boolean
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
  daily: Array<DailyPoint>
  projection: MonthProjection
  anomalies: DailyAnomaly[]
  mcp: Record<"context7" | "codebaseMemory" | "memoryGraph" | "playwright", boolean>
  availableModels: string[]
}
