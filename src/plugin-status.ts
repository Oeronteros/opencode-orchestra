import { readFile } from "node:fs/promises"
import path from "node:path"
import { parse } from "jsonc-parser"
import { openCodeConfigDirectory } from "./config/paths.js"

export const PACKAGE_NAME = "@oeronteros-1/opencode-orchestra"

/**
 * Resolve the installed package version from `package.json`. The compiled
 * output lives in `dist/`, so the package root is one level up. Falls back to
 * "unknown" when the manifest cannot be read (e.g. running from an unpacked
 * source tree without a package.json next to the dist folder).
 */
export async function resolvePluginVersion(): Promise<string> {
  try {
    const here = new URL(".", import.meta.url)
    const inline = new URL("../package.json", here)
    const pkg = JSON.parse(await readFile(inline, "utf8")) as { version?: string }
    if (pkg.version) return pkg.version
  } catch {
    // Fall through to the unknown marker.
  }
  return "unknown"
}

/**
 * Snapshot of the plugin's own runtime state. Unlike `orchestra_status` (which
 * reports per-session usage/escalation telemetry), this reports the plugin
 * itself: what version is loaded, which budget/strategy are active, where the
 * config came from, how many models were discovered, and which companion MCPs
 * are present in the OpenCode configuration.
 */
export interface PluginStatus {
  name: string
  version: string
  budget: string
  modelStrategy: string
  configuredModels: number
  discoveredModels: number
  configSource: string
  mcp: Record<string, boolean>
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
      await readFile(candidate, "utf8")
      return candidate
    } catch {
      // Try the next name.
    }
  }
  return path.join(configDirectory, "opencode.json")
}

function parseJsonc(text: string): Record<string, unknown> {
  const value = parse(text, [], { allowTrailingComma: true, disallowComments: false })
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Detect which companion MCPs are configured in the OpenCode main config.
 * Mirrors the dashboard's `mcpStatus` helper without importing the HTTP server.
 */
export async function detectMcpPresence(configDirectory: string = openCodeConfigDirectory()): Promise<Record<string, boolean>> {
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

/**
 * Format the plugin status snapshot as a stable, human-readable report.
 */
export async function formatPluginStatus(status: PluginStatus): Promise<string> {
  const mcp = Object.entries({ ...status.mcp })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, present]) => `  ${name.padEnd(24)} ${present ? "connected" : "not configured"}`)
    .join("\n")
  return [
    "OpenCode Orchestra plugin status",
    "",
    `plugin: ${status.name}@${status.version}`,
    `budget: ${status.budget}`,
    `model strategy: ${status.modelStrategy}`,
    `configured models: ${status.configuredModels}`,
    `discovered models: ${status.discoveredModels}`,
    `config source: ${status.configSource}`,
    "",
    "MCP servers:",
    mcp || "  none detected",
  ].join("\n")
}
