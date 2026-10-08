import { configuredMcpStatuses, mcpPresence, type McpStatuses } from "./mcp/status.js"
import { readFile } from "node:fs/promises"
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
  mcpStatuses?: McpStatuses
  refreshMcp?: () => Promise<void>
  browserStatus?: () => Promise<import("./browser/runtime.js").BrowserStatus>
  persistenceStatus?: () => import("./orchestration/state-store.js").PersistenceStatus
}

export async function detectMcpPresence(configDirectory: string = openCodeConfigDirectory()): Promise<Record<string, boolean>> {
  return mcpPresence(await configuredMcpStatuses(configDirectory))
}

/**
 * Format the plugin status snapshot as a stable, human-readable report.
 */
export async function formatPluginStatus(status: PluginStatus): Promise<string> {
  await status.refreshMcp?.()
  const browser = await status.browserStatus?.()
  const mcp = Object.entries({ ...status.mcp })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, present]) => `  ${name.padEnd(24)} ${status.mcpStatuses?.[name]?.state ?? (present ? "configured; connection unverified" : "disabled or not configured")}`)
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
    ...(status.persistenceStatus ? [`persistence: ${JSON.stringify(status.persistenceStatus())}`] : []),
    ...(browser ? [`browser: ${JSON.stringify(browser)}`] : []),
    "",
    "MCP servers:",
    mcp || "  none detected",
  ].join("\n")
}
