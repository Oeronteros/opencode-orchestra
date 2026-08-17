import { randomBytes } from "node:crypto"
import { spawn } from "node:child_process"
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
import { readLedgerState, type MessageUsage, type TokenUsage } from "../telemetry/ledger.js"

const PATCH_SCHEMA = z.object({
  budget: z.enum(["eco", "balanced", "quality", "ebobo"]),
  models: z.object({
    strategy: z.enum(["auto", "manual"]),
    agents: z.record(z.string(), z.string()),
  }),
  telemetry: z.object({ enabled: z.boolean() }),
})

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
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false })
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
  for (const name of ["opencode.json", "opencode.jsonc"]) {
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
    supermemory: "supermemory" in mcp,
  }
}

async function snapshot(directory: string, configDirectory: string): Promise<Record<string, unknown>> {
  const configPath = path.join(configDirectory, "orchestra.jsonc")
  const configText = await readTextOr(configPath, "{}\n")
  const config = orchestraConfigSchema.parse(parseJsonc(configText))
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
  return {
    updatedAt: ledger.updatedAt,
    project: path.basename(directory),
    directory,
    configPath,
    config: {
      budget: config.budget,
      models: { strategy: config.models.strategy, agents: config.models.agents },
      telemetry: { enabled: config.telemetry.enabled },
    },
    summary: {
      sessions: Object.keys(ledger.sessions).length,
      calls: activity.length,
      cost: totalCost,
      tokens: totalTokens,
    },
    models: aggregate(activity, (row) => row.provider && row.model ? `${row.provider}/${row.model}` : "unknown"),
    agents: aggregate(activity, (row) => row.agent ?? "unknown"),
    activity: activity.slice(0, 5_000),
    daily: [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-30),
    mcp: await mcpStatus(configDirectory),
  }
}

async function updateConfig(configPath: string, input: unknown): Promise<void> {
  const patch = PATCH_SCHEMA.parse(input)
  const agents = Object.fromEntries(
    Object.entries(patch.models.agents)
      .map(([name, model]) => [name, model.trim()] as const)
      .filter(([, model]) => model.length > 0),
  )
  await mkdir(path.dirname(configPath), { recursive: true })
  const original = await readTextOr(configPath, "{}\n")
  const current = parseJsonc(original)
  const merged = {
    ...current,
    budget: patch.budget,
    models: {
      ...(typeof current.models === "object" && current.models !== null ? current.models : {}),
      strategy: patch.models.strategy,
      agents,
    },
    telemetry: {
      ...(typeof current.telemetry === "object" && current.telemetry !== null ? current.telemetry : {}),
      enabled: patch.telemetry.enabled,
    },
  }
  orchestraConfigSchema.parse(merged)
  let updated = original
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" }
  for (const [location, value] of [
    [["budget"], patch.budget],
    [["models", "strategy"], patch.models.strategy],
    [["models", "agents"], agents],
    [["telemetry", "enabled"], patch.telemetry.enabled],
  ] as const) {
    updated = applyEdits(updated, modify(updated, [...location], value, { formattingOptions }))
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
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`)
      if (url.pathname.startsWith("/api/")) {
        if (request.headers["x-orchestra-token"] !== token) {
          sendJson(response, 401, { error: "Invalid dashboard token" })
          return
        }
        if (request.method === "GET" && url.pathname === "/api/snapshot") {
          sendJson(response, 200, await snapshot(directory, configDirectory))
          return
        }
        if (request.method === "PUT" && url.pathname === "/api/config") {
          await updateConfig(path.join(configDirectory, "orchestra.jsonc"), await jsonBody(request))
          sendJson(response, 200, { ok: true })
          return
        }
        sendJson(response, 404, { error: "Not found" })
        return
      }
      await serveAsset(response, assetsDirectory, url.pathname)
    } catch (error) {
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
