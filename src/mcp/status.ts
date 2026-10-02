import { readFile, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { parse, type ParseError } from "jsonc-parser"
import { openCodeConfigDirectory } from "../config/paths.js"

import { MCP_LABELS } from "./catalog.js"
const aliases: Record<string, string> = {
  "codebase-memory": "codebaseMemory", "codebase-memory-mcp": "codebaseMemory",
  memorygraph: "memoryGraph", "ast-grep": "astGrep",
  "orchestra-browser-playwright": "playwright", "orchestra_browser_playwright": "playwright",
  "orchestra-browser-devtools": "devtools", "orchestra_browser_devtools": "devtools", "chrome-devtools": "devtools", "chrome_devtools": "devtools",
}
export const mcpKey = (name: string): string => aliases[name] ?? name
export type McpState = "connected" | "failed" | "disabled" | "missing" | "unverified" | "needs_auth" | "needs_client_registration"
export interface McpServerStatus { name: string; state: McpState }
export type McpStatuses = Record<string, McpServerStatus>

export function mcpEntries(root: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const outer = record(root.mcp)
  return Object.fromEntries(Object.entries(outer.servers !== undefined ? record(outer.servers) : outer)
    .map(([name, entry]) => [name, record(entry)]))
}

async function readConfig(directory: string): Promise<Record<string, unknown>> {
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    try {
      const text = await readFile(path.join(directory, name), "utf8")
      const errors: ParseError[] = []
      const root = parse(text.replace(/^\uFEFF/, ""), errors, { allowTrailingComma: true })
      if (errors.length || !root || typeof root !== "object" || Array.isArray(root)) throw new Error("Invalid OpenCode MCP configuration")
      return root
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return {}
}

export async function configuredMcpStatuses(configDirectory = openCodeConfigDirectory(), directory?: string): Promise<McpStatuses> {
  const entries = mcpEntries(await readConfig(configDirectory))
  if (directory) {
    Object.assign(entries, mcpEntries(await readConfig(directory)))
    Object.assign(entries, mcpEntries(await readConfig(path.join(directory, ".opencode"))))
  }
  return statusesFromEntries(entries)
}

export function statusesFromEntries(entries: Record<string, Record<string, unknown>>, runtime: Record<string, unknown> = {}): McpStatuses {
  const statuses: McpStatuses = Object.fromEntries(Object.keys(MCP_LABELS).map((key) => [key, { name: key, state: "missing" }]))
  for (const [name, entry] of Object.entries(entries)) {
    statuses[mcpKey(name)] = { name, state: entry.enabled === false || entry.disabled === true ? "disabled" : "unverified" }
  }
  for (const [name, value] of Object.entries(runtime)) {
    const state = typeof value === "object" && value !== null ? (value as { status?: unknown }).status : value
    if (["connected", "failed", "disabled", "needs_auth", "needs_client_registration"].includes(String(state))) {
      statuses[mcpKey(name)] = { name, state: state as McpState }
    }
  }
  return statuses
}

export function mcpPresence(statuses: McpStatuses): Record<string, boolean> {
  return Object.fromEntries(Object.entries(statuses).map(([key, value]) => [key, value.state !== "missing" && value.state !== "disabled"]))
}

// Only connection states are persisted; URLs, headers and credentials stay in OpenCode.
export async function persistMcpStatuses(file: string, statuses: McpStatuses): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ updatedAt: Date.now(), statuses }), "utf8")
}

export async function dashboardMcpStatuses(configDirectory: string, directory: string, file: string): Promise<McpStatuses> {
  const configured = await configuredMcpStatuses(configDirectory, directory)
  try {
    const snapshot = JSON.parse(await readFile(file, "utf8"))
    if (typeof snapshot.updatedAt !== "number" || Date.now() - snapshot.updatedAt > 30_000) return configured
    for (const [key, value] of Object.entries(snapshot.statuses ?? {})) {
      const status = value as McpServerStatus
      if (status && typeof status.name === "string" && ["connected", "failed", "disabled", "missing", "unverified", "needs_auth", "needs_client_registration"].includes(status.state)) configured[key] = status
    }
  } catch { /* No running plugin snapshot, or a write is in progress. */ }
  return configured
}
