import { randomBytes } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { createReadStream } from "node:fs"
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { z } from "zod"
import { orchestraConfigSchema } from "../config/schema.js"
import { openCodeConfigDirectory } from "../config/paths.js"
import { loadConfigForDirectory } from "../config/load.js"
import { analyzeDaily, type DailyAnomaly, type MonthProjection } from "../telemetry/analytics.js"
import { readLedgerState, type MessageUsage, type TokenUsage } from "../telemetry/ledger.js"
import { parseLiveSnapshot, type LiveSnapshot } from "../telemetry/live.js"
import { projectId, readProjects, registerProject, type RegisteredProject } from "./registry.js"

/**
 * Any top-level config section may be edited from the dashboard, so the input
 * is validated against the full schema rather than a narrow hand-written
 * subset. Every field is optional: a PUT only touches the sections it carries,
 * and the server fills defaults by re-parsing the merged result.
 */
const CONFIG_INPUT_SCHEMA = orchestraConfigSchema.partial()

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
}

export interface DashboardOptions {
  directory?: string
  configDirectory?: string
  host?: string
  port?: number
  open?: boolean
  assetsDirectory?: string
}

interface AggregateRow {
  id: string
  calls: number
  cost: number
  tokens: TokenUsage
}

interface ActivityRow extends MessageUsage {
  id: string
  sessionID: string
}

function emptyTokens(): TokenUsage {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

function addTokens(target: TokenUsage, source: TokenUsage): void {
  target.input += source.input
  target.output += source.output
  target.reasoning += source.reasoning
  target.cache.read += source.cache.read
  target.cache.write += source.cache.write
}

function aggregate(rows: ActivityRow[], key: (row: ActivityRow) => string): AggregateRow[] {
  const result = new Map<string, AggregateRow>()
  for (const row of rows) {
    const id = key(row)
    const current = result.get(id) ?? { id, calls: 0, cost: 0, tokens: emptyTokens() }
    current.calls += 1
    current.cost += row.cost
    addTokens(current.tokens, row.tokens)
    result.set(id, current)
  }
  return [...result.values()].sort((a, b) => b.cost - a.cost || b.tokens.output - a.tokens.output)
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > 1_000_000) throw new Error("Request body is too large")
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  })
  response.end(body)
}

function parseJsonc(text: string): Record<string, unknown> {
  const errors: ParseError[] = []
  // OpenCode may save JSONC with a UTF-8 BOM. Strip it consistently with the
  // installer and doctor before handing the document to jsonc-parser.
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const value = parse(normalized, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0 || typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Configuration contains invalid JSONC")
  }
  return value as Record<string, unknown>
}

async function readTextOr(file: string, fallback: string): Promise<string> {
  try {
    return await readFile(file, "utf8")
  } catch {
    return fallback
  }
}

async function findMainConfig(configDirectory: string): Promise<string> {
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const candidate = path.join(configDirectory, name)
    try {
      await stat(candidate)
      return candidate
    } catch {
      // Try the next name.
    }
  }
  return path.join(configDirectory, "opencode.json")
}

async function mcpStatus(configDirectory: string): Promise<Record<string, boolean>> {
  const root = parseJsonc(await readTextOr(await findMainConfig(configDirectory), "{}"))
  const mcp = typeof root.mcp === "object" && root.mcp !== null && !Array.isArray(root.mcp)
    ? (root.mcp as Record<string, unknown>)
    : {}
  return {
    context7: "context7" in mcp,
    codebaseMemory: "codebase-memory" in mcp,
    memoryGraph: "memorygraph" in mcp,
    playwright: "playwright" in mcp,
  }
}

interface SnapshotData {
  projectId: string
  updatedAt: string
  project: string
  directory: string
  configPath: string
  config: {
    budget: string
    models: { strategy: "auto" | "manual"; agents: Record<string, string> }
    orchestration: { parallelWorkers: number; parallelEditors: number; maxWorkers: number; premiumEscalation: boolean; maxPremiumCallsPerTask: number; confidenceThreshold: number; exposeWorkers: boolean; profiles?: unknown; worktreeRoot?: string | undefined }
  permissions: { autoAcceptAll: boolean }
  superpowers: { compatibility: boolean; injectPrimaryHint: boolean }
  telemetry: { enabled: boolean; storeTexts: boolean; anomalySigma: number }
    pricing: { endpoint?: string | undefined; refreshIntervalHours: number; estimate: boolean; warnThresholdUSD: number; openrouter: { enabled: boolean; ttlHours: number }; aliases: Array<{ canonical: string; aliases: string[] }> }
    }
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
  daily: Array<{ date: string; cost: number; input: number; output: number; reasoning: number }>
  projection: MonthProjection
  anomalies: DailyAnomaly[]
  mcp: Record<string, boolean>
  availableModels: string[]
}

interface ProjectInfo {
  id: string
  name: string
  directory: string
  lastSeenAt: string
  updatedAt: string
  summary: SnapshotData["summary"]
}

interface GlobalSnapshot {
  global: true
  updatedAt: string
  project: string
  directory: string
  summary: SnapshotData["summary"] & { projects: number }
  models: AggregateRow[]
  agents: AggregateRow[]
  daily: SnapshotData["daily"]
  projection: MonthProjection
  anomalies: DailyAnomaly[]
  projects: ProjectInfo[]
}

/**
 * `opencode models` is a blocking spawnSync with a 10s timeout. The dashboard
 * polls every ~2.5s, so an uncached call would stall the whole event loop
 * (including live SSE ticks) on every refresh. Cache per project directory.
 */
const CONNECTED_MODELS_TTL = 60_000
const connectedModelsCache = new Map<string, { at: number; models: string[] }>()

function connectedModels(directory: string): string[] {
  const cached = connectedModelsCache.get(directory)
  if (cached && Date.now() - cached.at < CONNECTED_MODELS_TTL) return cached.models
  const executable = process.platform === "win32" ? "opencode.cmd" : "opencode"
  const result = spawnSync(executable, ["models"], { cwd: directory, encoding: "utf8", windowsHide: true, timeout: 10_000 })
  const models = result.status === 0 && result.stdout
    ? [...new Set(result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[^\s/]+\/[^\s]+$/.test(line)))].sort()
    : []
  connectedModelsCache.set(directory, { at: Date.now(), models })
  return models
}

async function snapshot(directory: string, configDirectory: string, includeModels = true, options: { activityLimit?: number; dailyLimit?: number } = {}): Promise<SnapshotData> {
  const config = (await loadConfigForDirectory(directory, configDirectory)).config
  const ledger = await readLedgerState(path.resolve(directory, config.telemetry.directory, "state.json"))
  const activity: ActivityRow[] = []
  for (const [sessionID, session] of Object.entries(ledger.sessions)) {
    for (const [id, message] of Object.entries(session.messages)) activity.push({ id, sessionID, ...message })
  }
  activity.sort((a, b) => (b.completedAt ?? b.createdAt ?? 0) - (a.completedAt ?? a.createdAt ?? 0))
  const totalTokens = emptyTokens()
  let totalCost = 0
  for (const row of activity) {
    totalCost += row.cost
    addTokens(totalTokens, row.tokens)
  }
  const dailyMap = new Map<string, { date: string; cost: number; input: number; output: number; reasoning: number }>()
  for (const row of activity) {
    const timestamp = row.completedAt ?? row.createdAt
    if (!timestamp) continue
    const date = new Date(timestamp).toISOString().slice(0, 10)
    const point = dailyMap.get(date) ?? { date, cost: 0, input: 0, output: 0, reasoning: 0 }
    point.cost += row.cost
    point.input += row.tokens.input
    point.output += row.tokens.output
    point.reasoning += row.tokens.reasoning
    dailyMap.set(date, point)
  }
  const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date))
  const analytics = analyzeDaily(daily, new Date(), config.telemetry.anomalySigma)
  const activityLimit = options.activityLimit ?? 5_000
  const dailyLimit = options.dailyLimit ?? 30
  return {
    projectId: projectId(directory),
    updatedAt: ledger.updatedAt,
    project: path.basename(directory),
    directory,
    // The settings form edits the project-level file next to the ledger, so
    // that path (not the global fallback) is what the dashboard displays.
    configPath: path.join(directory, ".opencode", "orchestra.jsonc"),
    config: {
      budget: config.budget,
       models: { strategy: config.models.strategy, agents: config.models.agents },
       orchestration: config.orchestration,
       permissions: config.permissions,
       superpowers: config.superpowers,
       telemetry: { enabled: config.telemetry.enabled, storeTexts: config.telemetry.storeTexts, anomalySigma: config.telemetry.anomalySigma },
       pricing: config.pricing,
    },
    summary: {
      sessions: Object.keys(ledger.sessions).length,
      calls: activity.length,
      cost: totalCost,
      tokens: totalTokens,
    },
    models: aggregate(activity, (row) => row.provider && row.model ? `${row.provider}/${row.model}` : "unknown"),
    agents: aggregate(activity, (row) => row.agent ?? "unknown"),
     activity: activityLimit === 0 ? activity : activity.slice(0, activityLimit),
     activityTotal: activity.length,
     activityTruncated: activityLimit > 0 && activity.length > activityLimit,
     daily: dailyLimit === 0 ? daily : daily.slice(-dailyLimit),
    projection: analytics.projection,
    anomalies: analytics.anomalies,
    mcp: await mcpStatus(configDirectory),
    availableModels: [...new Set([
      ...(includeModels ? connectedModels(directory) : []),
      ...Object.values(config.models.agents),
      ...config.models.lead, ...config.models.judge, ...Object.values(config.models.worker).flat(),
    ].map((model) => typeof model === "string" ? model : model.id))].sort(),
  }
}

function mergeAggregateRows(snapshots: SnapshotData[], key: "models" | "agents"): AggregateRow[] {
  const merged = new Map<string, AggregateRow>()
  for (const data of snapshots) {
    for (const row of data[key]) {
      const current = merged.get(row.id) ?? { id: row.id, calls: 0, cost: 0, tokens: emptyTokens() }
      current.calls += row.calls
      current.cost += row.cost
      addTokens(current.tokens, row.tokens)
      merged.set(row.id, current)
    }
  }
  return [...merged.values()].sort((a, b) => b.cost - a.cost || b.tokens.output - a.tokens.output)
}

async function knownProjects(directory: string, configDirectory: string): Promise<RegisteredProject[]> {
  const current: RegisteredProject = { id: projectId(directory), name: path.basename(directory), directory, lastSeenAt: new Date().toISOString() }
  const unique = new Map((await readProjects(configDirectory)).map((project) => [path.resolve(project.directory), { ...project, directory: path.resolve(project.directory) }]))
  unique.set(directory, current)
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name))
}

async function projectSnapshots(directory: string, configDirectory: string, options: { dailyLimit?: number } = {}): Promise<SnapshotData[]> {
  const results = await Promise.all((await knownProjects(directory, configDirectory)).map(async (project) => {
    try { return await snapshot(project.directory, configDirectory, false, options) } catch { return undefined }
  }))
  return results.filter((item): item is SnapshotData => Boolean(item))
}

function projectInfo(data: SnapshotData): ProjectInfo {
  return { id: data.projectId, name: data.project, directory: data.directory, lastSeenAt: data.updatedAt, updatedAt: data.updatedAt, summary: data.summary }
}

async function globalSnapshot(directory: string, configDirectory: string, dailyLimit = 30): Promise<GlobalSnapshot> {
  const snapshots = await projectSnapshots(directory, configDirectory, { dailyLimit: 0 })
  const tokens = emptyTokens()
  let sessions = 0
  let calls = 0
  let cost = 0
  const dailyMap = new Map<string, SnapshotData["daily"][number]>()
  for (const data of snapshots) {
    sessions += data.summary.sessions
    calls += data.summary.calls
    cost += data.summary.cost
    addTokens(tokens, data.summary.tokens)
    for (const row of data.daily) {
      const point = dailyMap.get(row.date) ?? { date: row.date, cost: 0, input: 0, output: 0, reasoning: 0 }
      point.cost += row.cost
      point.input += row.input
      point.output += row.output
      point.reasoning += row.reasoning
      dailyMap.set(row.date, point)
    }
  }
  const completeDaily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date))
  const daily = dailyLimit === 0 ? completeDaily : completeDaily.slice(-dailyLimit)
  const analytics = analyzeDaily(completeDaily)
  return {
    global: true,
    updatedAt: snapshots.map((item) => item.updatedAt).sort().at(-1) ?? new Date(0).toISOString(),
    project: "Все проекты",
    directory: `${snapshots.length} registered projects`,
    summary: { projects: snapshots.length, sessions, calls, cost, tokens },
    models: mergeAggregateRows(snapshots, "models"),
    agents: mergeAggregateRows(snapshots, "agents"),
    daily,
    projection: analytics.projection,
    anomalies: analytics.anomalies,
    projects: snapshots.map(projectInfo),
  }
}

type ExportScope = "activity" | "models" | "agents" | "daily" | "summary"

const EXPORT_SCOPES: readonly ExportScope[] = ["activity", "models", "agents", "daily", "summary"]

function csvEscape(value: string | number | boolean | undefined): string {
  const text = value === undefined || value === null ? "" : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function isoOrEmpty(timestamp?: number): string {
  return timestamp ? new Date(timestamp).toISOString() : ""
}

function rowsForScope(data: SnapshotData, scope: ExportScope): { headers: string[]; rows: unknown[][] } {
  switch (scope) {
    case "activity":
      return {
        headers: ["id", "sessionID", "agent", "provider", "model", "createdAt", "completedAt", "finish", "cost", "tokensInput", "tokensOutput", "tokensReasoning", "cacheRead", "cacheWrite", "pricingStatus"],
        rows: data.activity.map((row) => [row.id, row.sessionID, row.agent ?? "", row.provider ?? "", row.model ?? "", isoOrEmpty(row.createdAt), isoOrEmpty(row.completedAt), row.finish ?? "", row.cost, row.tokens.input, row.tokens.output, row.tokens.reasoning, row.tokens.cache.read, row.tokens.cache.write, row.pricingStatus ?? ""]),
      }
    case "models":
    case "agents":
      return {
        headers: ["id", "calls", "cost", "tokensInput", "tokensOutput", "tokensReasoning", "cacheRead", "cacheWrite"],
        rows: data[scope].map((row) => [row.id, row.calls, row.cost, row.tokens.input, row.tokens.output, row.tokens.reasoning, row.tokens.cache.read, row.tokens.cache.write]),
      }
    case "daily":
      return {
        headers: ["date", "cost", "tokensInput", "tokensOutput", "tokensReasoning"],
        rows: data.daily.map((row) => [row.date, row.cost, row.input, row.output, row.reasoning]),
      }
    case "summary":
      return {
        headers: ["project", "directory", "sessions", "calls", "cost", "tokensInput", "tokensOutput", "tokensReasoning", "cacheRead", "cacheWrite", "updatedAt"],
        rows: [[data.project, data.directory, data.summary.sessions, data.summary.calls, data.summary.cost, data.summary.tokens.input, data.summary.tokens.output, data.summary.tokens.reasoning, data.summary.tokens.cache.read, data.summary.tokens.cache.write, data.updatedAt]],
      }
  }
}

function toCsv(headers: string[], rows: unknown[][]): string {
  return `${headers.map((header) => csvEscape(header)).join(",")}\n${rows.map((row) => row.map((cell) => csvEscape(cell as string | number | boolean | undefined)).join(",")).join("\n")}\n`
}

function toJson(scope: ExportScope, headers: string[], rows: unknown[][]): string {
  return `${JSON.stringify({ scope, generatedAt: new Date().toISOString(), rows: rows.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index]]))) }, null, 2)}\n`
}

function exportFilename(scope: ExportScope, format: "csv" | "json", directory: string): string {
  const project = path.basename(directory).replace(/[^\w.-]+/g, "-") || "orchestra"
  const date = new Date().toISOString().slice(0, 10)
  return `${project}-orchestra-${scope}-${date}.${format}`
}

function sendFile(response: ServerResponse, status: number, filename: string, mime: string, body: string): void {
  response.writeHead(status, {
    "Content-Type": mime,
    "Content-Length": Buffer.byteLength(body),
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
  })
  response.end(body)
}

async function exportReport(response: ServerResponse, directory: string, configDirectory: string, searchParams: URLSearchParams): Promise<void> {
  const scope = searchParams.get("scope") ?? "activity"
  if (!(EXPORT_SCOPES as readonly string[]).includes(scope)) {
    sendJson(response, 400, { error: `Unknown export scope: ${scope}` })
    return
  }
  const format = searchParams.get("format")
  if (format !== "csv" && format !== "json") {
    sendJson(response, 400, { error: "Missing or unsupported export format (expected csv or json)" })
    return
  }
  // Exports intentionally bypass dashboard snapshot caps. The ledger is read
  // completely, while the response advertises any caller-provided bound.
  const requestedLimit = Number(searchParams.get("limit") ?? "0")
  const activityLimit = requestedLimit > 0 ? requestedLimit : 0
  const data = await snapshot(directory, configDirectory, true, { activityLimit, dailyLimit: 0 })
  const { headers, rows } = rowsForScope(data, scope as ExportScope)
  const filename = exportFilename(scope as ExportScope, format, directory)
  const truncated = data.activityTruncated
  if (format === "csv") {
    if (truncated) response.setHeader("X-Orchestra-Truncated", "true")
    sendFile(response, 200, filename, "text/csv; charset=utf-8", toCsv(headers, rows))
  } else {
    sendFile(response, 200, filename, "application/json; charset=utf-8", `${JSON.stringify({ scope, generatedAt: new Date().toISOString(), truncated, totalRows: rows.length, rows: rows.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index]]))) }, null, 2)}\n`)
  }
}

interface ValidationIssue {
  path: string
  message: string
}

export interface ConfigValidationResult {
  valid: boolean
  issues: ValidationIssue[]
}

/** Convert a ZodError into flat, dashboard-friendly field issues. */
function validationIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join(".") || "(root)",
    message: issue.message,
  }))
}

/** Validate a dashboard config patch without touching disk. */
export function validateConfigInput(input: unknown): ConfigValidationResult {
  const result = CONFIG_INPUT_SCHEMA.safeParse(normalizeConfigInput(input).value)
  if (result.success) return { valid: true, issues: [] }
  return { valid: false, issues: validationIssues(result.error) }
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Keys the dashboard may edit. Everything else inside the parsed config is
 * preserved verbatim, so unknown/commented JSONC survives an update.
 */
const EDITABLE_SECTIONS = ["budget", "models", "orchestration", "permissions", "superpowers", "telemetry", "pricing"] as const

interface NormalizedConfigInput {
  value: unknown
  /**
   * Optional free-text fields the user explicitly cleared in the settings
   * form. The form submits an empty string for them; zod's min(1) would
   * reject that, so the key is removed from the parsed value and recorded
   * here so `updateConfig` deletes it on disk instead of silently keeping
   * the old value forever.
   */
  removals: Array<{ section: "orchestration" | "pricing"; key: string }>
}

function normalizeConfigInput(input: unknown): NormalizedConfigInput {
  if (!isObjectLike(input)) return { value: input, removals: [] }
  const normalized: Record<string, unknown> = { ...input }
  const removals: NormalizedConfigInput["removals"] = []

  const models = normalized.models
  if (isObjectLike(models) && isObjectLike(models.agents)) {
    const agents = Object.fromEntries(
      Object.entries(models.agents)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([name, model]) => [name, model.trim()] as const)
        .filter(([, model]) => model.length > 0),
    )
    normalized.models = { ...models, agents }
  }

  const orchestration = normalized.orchestration
  if (isObjectLike(orchestration) && typeof orchestration.worktreeRoot === "string" && orchestration.worktreeRoot.trim() === "") {
    const { worktreeRoot: _dropped, ...rest } = orchestration
    normalized.orchestration = rest
    removals.push({ section: "orchestration", key: "worktreeRoot" })
  }

  const pricing = normalized.pricing
  if (isObjectLike(pricing) && typeof pricing.endpoint === "string" && pricing.endpoint.trim() === "") {
    const { endpoint: _dropped, ...rest } = pricing
    normalized.pricing = rest
    removals.push({ section: "pricing", key: "endpoint" })
  }

  return { value: normalized, removals }
}

async function updateConfig(configPath: string, input: unknown): Promise<ConfigValidationResult> {
  const normalizedInput = normalizeConfigInput(input)
  const parsed = CONFIG_INPUT_SCHEMA.parse(normalizedInput.value)
  await mkdir(path.dirname(configPath), { recursive: true })
  const original = await readTextOr(configPath, "{}\n")
  const current = parseJsonc(original)

  const merged = { ...current }
  for (const section of EDITABLE_SECTIONS) {
    if (!(section in parsed)) continue
    const incoming = (parsed as Record<string, unknown>)[section]
    const existing = merged[section]
    merged[section] = isObjectLike(incoming) && isObjectLike(existing) ? { ...existing, ...incoming } : incoming
  }
  // Apply explicit clears from the form: merged[...] is a fresh copy at this
  // point whenever its section was part of the request, so deleting is safe.
  for (const removal of normalizedInput.removals) {
    if (!(removal.section in parsed)) continue
    const target = merged[removal.section]
    if (isObjectLike(target)) delete target[removal.key]
  }
  // Re-parse through the full schema so defaults fill in and invalid values
  // are caught before anything is written to disk.
  orchestraConfigSchema.parse(merged)

  // Serialize only the editable sections back, preserving comments and any
  // unrelated keys in the original JSONC.
  let updated = original
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" }
  for (const section of EDITABLE_SECTIONS) {
    if (!(section in parsed)) continue
    updated = applyEdits(updated, modify(updated, [section], merged[section], { formattingOptions }))
  }

  try {
    await stat(configPath)
    const stamp = new Date().toISOString().replaceAll(":", "-")
    await copyFile(configPath, `${configPath}.bak-${stamp}`)
  } catch {
    // First save, no backup is needed.
  }
  const temporary = `${configPath}.orchestra-dashboard-tmp`
  await writeFile(temporary, updated.endsWith("\n") ? updated : `${updated}\n`, "utf8")
  await rename(temporary, configPath)
  return { valid: true, issues: [] }
}

function defaultAssetsDirectory(): string {
  const besidePackage = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dashboard-dist")
  return besidePackage
}

async function serveAsset(response: ServerResponse, assetsDirectory: string, pathname: string): Promise<void> {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "")
  let file = path.resolve(assetsDirectory, relative)
  const root = path.resolve(assetsDirectory)
  if (!file.startsWith(`${root}${path.sep}`) && file !== root) {
    response.writeHead(403).end()
    return
  }
  try {
    if (!(await stat(file)).isFile()) throw new Error("not a file")
  } catch {
    file = path.join(root, "index.html")
  }
  const info = await stat(file)
  response.writeHead(200, {
    "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
    "Content-Length": info.size,
    "Cache-Control": file.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'",
  })
  createReadStream(file).pipe(response)
}

function openBrowser(url: string): void {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open"
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url]
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true })
  child.unref()
}

const LIVE_TELEMETRY_DIRECTORIES = [".orchestra", "orchestra"]

/**
 * Resolve the live stream file written by the plugin. The telemetry directory
 * comes from the config (defaults to ".orchestra"), with a couple of common
 * historical names as a fallback so the dashboard keeps working if the user
 * moved the directory.
 */
async function readLiveSnapshot(directory: string, configDirectory: string): Promise<LiveSnapshot> {
  let telemetryDirectory = ".orchestra"
  try {
    const config = (await loadConfigForDirectory(directory, configDirectory)).config
    telemetryDirectory = config.telemetry.directory
  } catch {
    // Fall through to the default; a missing file yields the empty snapshot.
  }
  const candidates = [path.resolve(directory, telemetryDirectory, "live.ndjson"), ...LIVE_TELEMETRY_DIRECTORIES.map((name) => path.resolve(directory, name, "live.ndjson"))]
  for (const candidate of candidates) {
    const text = await readTextOr(candidate, "")
    if (text) {
      const snapshot = parseLiveSnapshot(text)
      // If the plugin process died without finalizing its agents, do not keep
      // displaying those rows forever. Healthy streams rewrite this snapshot
      // on deltas, so a 15-minute-old active set is considered abandoned.
      if (snapshot.active.length > 0 && Date.now() - snapshot.updatedAt > 15 * 60_000) {
        return { ...snapshot, active: [], recent: [] }
      }
      return snapshot
    }
  }
  return { version: 1, updatedAt: 0, seq: 0, active: [], recent: [] }
}

function sseSend(response: ServerResponse, event: string, data: unknown): void {
  response.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n")
}

function handleLiveStream(request: IncomingMessage, response: ServerResponse, directory: string, configDirectory: string): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  })
  response.write("retry: 2000\n\n")

  let closed = false
  let timer: ReturnType<typeof setInterval> | undefined
  const close = () => {
    if (closed) return
    closed = true
    if (timer) clearInterval(timer)
    response.end()
  }
  request.on("close", close)
  response.on("close", close)

  let lastSeq = -1
  let lastUpdatedAt = -1
  let lastActiveCount = -1

  const tick = async () => {
    if (closed) return
    const snapshot = await readLiveSnapshot(directory, configDirectory)
    if (closed) return
    if (snapshot.seq !== lastSeq || snapshot.updatedAt !== lastUpdatedAt || snapshot.active.length !== lastActiveCount) {
      lastSeq = snapshot.seq
      lastUpdatedAt = snapshot.updatedAt
      lastActiveCount = snapshot.active.length
      sseSend(response, "snapshot", snapshot)
    } else {
      response.write(": ping\n\n") // keep the connection alive
    }
  }

  // Send the current state immediately, then poll the plugin's live file.
  void tick().catch(() => undefined)
  timer = setInterval(() => void tick().catch(() => undefined), 700)
  timer.unref?.()
}

export async function startDashboard(options: DashboardOptions = {}): Promise<{
  url: string
  close: () => Promise<void>
}> {
  const directory = path.resolve(options.directory ?? process.cwd())
  const configDirectory = path.resolve(options.configDirectory ?? openCodeConfigDirectory())
  const host = options.host ?? "127.0.0.1"
  const port = options.port ?? 0
  const assetsDirectory = path.resolve(options.assetsDirectory ?? defaultAssetsDirectory())
  const token = randomBytes(24).toString("base64url")
  await registerProject(directory, configDirectory).catch(() => undefined)
  const resolveProject = async (id: string | null): Promise<string | undefined> => {
    if (!id) return directory
    return (await knownProjects(directory, configDirectory)).find((project) => project.id === id)?.directory
  }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`)
      if (url.pathname.startsWith("/api/")) {
        // EventSource cannot set custom headers, so the SSE /api/live route
        // authenticates via a ?token= query param (the same token that is
        // already present in the page URL). Other /api calls may use header or query.
        const givenToken = request.headers["x-orchestra-token"] ?? url.searchParams.get("token")
        if (givenToken !== token) {
          sendJson(response, 401, { error: "Invalid dashboard token" })
          return
        }
        if (request.method === "GET" && url.pathname === "/api/live") {
          const target = await resolveProject(url.searchParams.get("project"))
          if (!target) { sendJson(response, 404, { error: "Unknown project" }); return }
          handleLiveStream(request, response, target, configDirectory)
          return
        }
        if (request.method === "GET" && url.pathname === "/api/snapshot") {
          const target = await resolveProject(url.searchParams.get("project"))
          if (!target) { sendJson(response, 404, { error: "Unknown project" }); return }
           const range = url.searchParams.get("range")
           const dailyLimit = range === "all" ? 0 : Math.max(1, Math.min(90, Number(range) || 30))
           sendJson(response, 200, await snapshot(target, configDirectory, true, { dailyLimit }))
          return
        }
        if (request.method === "GET" && url.pathname === "/api/projects") {
          const projects = await projectSnapshots(directory, configDirectory)
          sendJson(response, 200, projects.map((item) => projectInfo(item)))
          return
        }
        if (request.method === "GET" && url.pathname === "/api/global") {
           const range = url.searchParams.get("range")
           const dailyLimit = range === "all" ? 0 : Math.max(1, Math.min(90, Number(range) || 30))
           sendJson(response, 200, await globalSnapshot(directory, configDirectory, dailyLimit))
          return
        }
        if (request.method === "GET" && url.pathname === "/api/export") {
          const target = await resolveProject(url.searchParams.get("project"))
          if (!target) { sendJson(response, 404, { error: "Unknown project" }); return }
          await exportReport(response, target, configDirectory, url.searchParams)
          return
        }
        if (request.method === "PUT" && url.pathname === "/api/config") {
          const requestedProject = url.searchParams.get("project")
          const target = requestedProject ? await resolveProject(requestedProject) : undefined
          if (requestedProject && !target) { sendJson(response, 404, { error: "Unknown project" }); return }
          const configPath = target
            ? path.join(target, ".opencode", "orchestra.jsonc")
            : path.join(configDirectory, "orchestra.jsonc")
          await updateConfig(configPath, await jsonBody(request))
          sendJson(response, 200, { ok: true })
          return
        }
        if (request.method === "POST" && url.pathname === "/api/config/validate") {
          sendJson(response, 200, validateConfigInput(await jsonBody(request)))
          return
        }
        if (request.method === "PUT" && url.pathname === "/api/config/validate") {
          sendJson(response, 200, await updateConfig(path.join(configDirectory, "orchestra.jsonc"), await jsonBody(request)))
          return
        }
        sendJson(response, 404, { error: "Not found" })
        return
      }
      await serveAsset(response, assetsDirectory, url.pathname)
    } catch (error) {
      if (error instanceof z.ZodError) {
        sendJson(response, 422, { error: "Invalid configuration", issues: validationIssues(error) })
        return
      }
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Dashboard server did not expose a TCP address")
  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host
  const url = `http://${displayHost}:${address.port}/?token=${token}`
  if (options.open !== false) openBrowser(url)
  return {
    url,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}
