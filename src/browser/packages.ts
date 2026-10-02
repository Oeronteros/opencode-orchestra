import { createRequire } from "node:module"
import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import path from "node:path"
import type { BrowserConfig } from "../config/schema.js"
import type { BrowserBackend } from "./policy.js"

export const BROWSER_PACKAGES = {
  playwright: { name: "@playwright/mcp", version: "0.0.83", entry: "cli.js" },
  devtools: { name: "chrome-devtools-mcp", version: "1.10.1", entry: "build/src/bin/chrome-devtools-mcp.js" },
} as const
const require = createRequire(import.meta.url)
export function backendEntry(backend: BrowserBackend): string | undefined {
  const pkg = BROWSER_PACKAGES[backend]
  try {
    const main = require.resolve(pkg.name)
    const directory = backend === "playwright" ? path.dirname(main) : path.resolve(path.dirname(main), "../..")
    const manifest: unknown = require(path.join(directory, "package.json"))
    if (!manifest || typeof manifest !== "object" || !("version" in manifest) || manifest.version !== pkg.version) return undefined
    const entry = path.join(directory, pkg.entry)
    return existsSync(entry) ? entry : undefined
  } catch { return undefined }
}

export function browserNode(config: BrowserConfig): string | undefined {
  // Bun hosts must run MCP under real Node; no cmd/bat shell shim is used.
  const candidates = config.nodeExecutable ? [config.nodeExecutable] : [process.execPath, "node"]
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["-p", "JSON.stringify({exec:process.execPath,node:process.versions.node,bun:process.versions.bun})"], { encoding: "utf8", windowsHide: true, timeout: 5000 })
    try {
      const value = JSON.parse(probe.stdout ?? "") as { exec: string; node: string; bun?: string }
      const [major, minor] = value.node.split(".").map(Number)
      if (probe.status === 0 && !value.bun && major !== undefined && (major > 22 || major === 22 && (minor ?? 0) >= 12)) return value.exec
    } catch { /* Try the next native executable. */ }
  }
  return undefined
}

export function backendCommand(backend: BrowserBackend, endpoint: string, config: BrowserConfig, artifactDirectory: string): string[] {
  const entry = backendEntry(backend)
  const node = browserNode(config)
  if (!entry || !node) throw new Error("browser_packages_or_node_unavailable")
  const url = new URL(endpoint)
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("browser_endpoint_not_local")
  return backend === "playwright"
    ? [node, entry, "--cdp-endpoint", endpoint, "--output-dir", artifactDirectory]
    : [node, entry, "--browser-url", endpoint, "--no-usage-statistics", "--no-performance-crux", "--redact-network-headers", "--no-page-id-routing", "--filesystem-root", artifactDirectory]
}
