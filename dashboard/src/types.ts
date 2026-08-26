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
  /** How pricing was classified: "unknown" means no rate could be found. */
  pricingStatus?: "paid" | "free" | "subscription" | "unknown"
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
  telemetry: { enabled: boolean; storeTexts: boolean; anomalySigma: number }
  orchestration: { parallelWorkers: number; parallelEditors: number; maxWorkers: number; premiumEscalation: boolean; maxPremiumCallsPerTask: number; confidenceThreshold: number; exposeWorkers: boolean; worktreeRoot?: string }
  superpowers: { compatibility: boolean; injectPrimaryHint: boolean }
  pricing: { endpoint?: string; refreshIntervalHours: number; estimate: boolean; warnThresholdUSD: number; openrouter: { enabled: boolean; ttlHours: number }; aliases: Array<{ canonical: string; aliases: string[] }> }
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

/** Event kinds emitted by the live orchestration stream. */
export type LiveEventKind = "start" | "delta" | "finish"

/** One live stream event (start / delta / finish). */
export interface LiveEvent {
  seq: number
  e: LiveEventKind
  ts: number
  k: string
  sessionID?: string
  agent?: string
  model?: string
  provider?: string
  /** Snippet of what the agent currently produces. */
  text?: string
  /** USD cost-so-far (delta carries a running estimate; finish the actual). */
  cost?: number
  tokens?: { input: number; output: number; reasoning: number }
  finish?: string
  confidence?: number
  flags?: string[]
}

/** An agent currently generating, shown in the live panel. */
export interface LiveActiveAgent {
  key: string
  sessionID?: string
  agent?: string
  model?: string
  provider?: string
  startedAt: number
  text: string
  cost: number
  tokens: { input: number; output: number; reasoning: number }
  confidence?: number
  flags?: string[]
}

/** Snapshot pushed by the /api/live SSE stream. */
export interface LiveSnapshot {
  version: 1
  updatedAt: number
  seq: number
  active: LiveActiveAgent[]
  recent: LiveEvent[]
}

export interface Snapshot {
  projectId: string
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
  activityTotal: number
  activityTruncated: boolean
  daily: Array<DailyPoint>
  projection: MonthProjection
  anomalies: DailyAnomaly[]
  mcp: Record<"context7" | "codebaseMemory" | "memoryGraph" | "playwright", boolean>
  availableModels: string[]
}

export interface ProjectInfo {
  id: string
  name: string
  directory: string
  lastSeenAt: string
  updatedAt: string
  summary: Snapshot["summary"]
}

export interface GlobalSnapshot {
  global: true
  updatedAt: string
  project: string
  directory: string
  summary: Snapshot["summary"] & { projects: number }
  models: AggregateRow[]
  agents: AggregateRow[]
  daily: DailyPoint[]
  projection: MonthProjection
  anomalies: DailyAnomaly[]
  projects: ProjectInfo[]
}
