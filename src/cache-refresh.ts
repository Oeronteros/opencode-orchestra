import { spawnSync } from "node:child_process"
import type { Dirent } from "node:fs"
import { readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { compareVersions } from "./diagnostics/update.js"

const PACKAGE_NAME = "@oeronteros-1/opencode-orchestra"

/**
 * OpenCode resolves each plugin spec into `<cache>/opencode/packages/<spec>/`
 * and only ever installs there once: an existing `package.json` short-circuits
 * re-resolution. A spec like `@latest` therefore keeps loading the version it
 * first resolved to (e.g. 1.0.8) even after newer versions are published.
 * Exact semver pins (`@1.0.15`) can never drift, so they are not refreshed.
 */

export interface PluginCacheReport {
  /** Mutable entries whose cached version already matches the target. */
  upToDate: string[]
  /** Mutable entries updated in place to the running plugin version. */
  reinstalled: string[]
  /** Mutable entries removed after a failed refresh; OpenCode reinstalls them on its next start. */
  invalidated: string[]
}

/**
 * Installs the rewritten pin inside a cache entry directory. Returns false
 * when no package manager succeeded so the caller can fall back to removal.
 */
export type RefreshInstaller = (directory: string) => Promise<boolean>

export interface RefreshPluginCacheOptions {
  /** The `packages` directory of OpenCode's cache (see openCodePackagesRoot). */
  packagesRoot: string
  /** Version the cache should resolve to; normally the running CLI version. */
  targetVersion: string
  /** Classify stale entries without writing or removing anything. */
  dryRun?: boolean
  /** Test seam replacing the bun/npm installation step. */
  runInstaller?: RefreshInstaller
}

/** Root where OpenCode caches installed plugin packages across platforms. */
export function openCodePackagesRoot(): string {
  const cacheRoot = process.env.XDG_CACHE_HOME
    ?? (process.platform === "win32" ? process.env.LOCALAPPDATA : undefined)
    ?? path.join(os.homedir(), ".cache")
  return path.join(cacheRoot, "opencode", "packages")
}

function isExactPin(spec: string): boolean {
  return /^v?\d+\.\d+\.\d+(?:[-+][\w.]+)*$/.test(spec)
}

async function readInstalledVersion(directory: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(
      await readFile(path.join(directory, "node_modules", ...PACKAGE_NAME.split("/"), "package.json"), "utf8"),
    ) as { version?: string }
    return typeof manifest.version === "string" ? manifest.version : undefined
  } catch {
    return undefined
  }
}

interface CacheEntry {
  label: string
  directory: string
  spec: string
}

async function discoverEntries(packagesRoot: string): Promise<CacheEntry[]> {
  const entries: CacheEntry[] = []
  // Scoped specs install under `packages/<@scope>/`, so an entry's full name
  // joins the optional scope with the directory name ("opencode-orchestra",
  // "opencode-orchestra@latest"). The remainder after the package name is
  // either empty (bare spec resolves like @latest) or "@spec".
  const consider = (scope: string | undefined, name: string, directory: string): void => {
    const fullName = scope ? `${scope}/${name}` : name
    if (!fullName.startsWith(PACKAGE_NAME)) return
    const rest = fullName.slice(PACKAGE_NAME.length)
    if (rest !== "" && !rest.startsWith("@")) return
    entries.push({ label: fullName, directory, spec: rest === "" ? "" : rest.slice(1) })
  }
  let scopes: Dirent[] = []
  try {
    scopes = await readdir(packagesRoot, { withFileTypes: true })
  } catch {
    return entries
  }
  for (const scope of scopes) {
    if (scope.name.startsWith("@") && scope.isDirectory()) {
      const scopeDirectory = path.join(packagesRoot, scope.name)
      for (const child of await readdir(scopeDirectory, { withFileTypes: true })) {
        if (child.isDirectory()) consider(scope.name, child.name, path.join(scopeDirectory, child.name))
      }
    } else if (scope.isDirectory()) {
      consider(undefined, scope.name, path.join(packagesRoot, scope.name))
    }
  }
  return entries.sort((a, b) => a.label.localeCompare(b.label))
}

async function reinstallInPlace(entry: CacheEntry, version: string, runInstaller?: RefreshInstaller): Promise<boolean> {
  await writeFile(
    path.join(entry.directory, "package.json"),
    `${JSON.stringify({ dependencies: { [PACKAGE_NAME]: version } }, null, 2)}\n`,
  )
  if (runInstaller) return runInstaller(entry.directory)
  // OpenCode itself installs plugins with bun; npm covers environments without it.
  const attempts: [command: string, args: string[]][] = [
    ["bun", ["install"]],
    ["npm", ["install", "--no-audit", "--no-fund"]],
  ]
  for (const [command, args] of attempts) {
    try {
      const result = spawnSync(command, args, { cwd: entry.directory, stdio: "ignore", shell: process.platform === "win32" })
      if (result.status === 0 && compareVersions((await readInstalledVersion(entry.directory)) ?? "", version) === 0) {
        return true
      }
    } catch {
      // Try the next package manager.
    }
  }
  return false
}

/**
 * Bring every mutable Orchestra entry in OpenCode's package cache up to
 * `targetVersion`. Entries that cannot be updated are removed so OpenCode
 * performs a clean install on its next start instead of loading a stale copy.
 */
export async function refreshPluginCache(options: RefreshPluginCacheOptions): Promise<PluginCacheReport> {
  const report: PluginCacheReport = { upToDate: [], reinstalled: [], invalidated: [] }
  // A source checkout without a resolvable version cannot state a target;
  // refreshing against "unknown" would churn healthy entries.
  if (!/^\d/.test(options.targetVersion)) return report
  const entries = await discoverEntries(options.packagesRoot)
  for (const entry of entries) {
    if (isExactPin(entry.spec)) continue
    const installed = await readInstalledVersion(entry.directory)
    if (installed !== undefined && compareVersions(installed, options.targetVersion) === 0) {
      report.upToDate.push(entry.label)
      continue
    }
    if (options.dryRun) {
      report.reinstalled.push(entry.label)
      continue
    }
    const updated = await reinstallInPlace(entry, options.targetVersion, options.runInstaller).catch(() => false)
    if (updated) report.reinstalled.push(entry.label)
    else {
      await rm(entry.directory, { recursive: true, force: true }).catch(() => undefined)
      report.invalidated.push(entry.label)
    }
  }
  return report
}

/** Format a cache report as a single human-readable line, or undefined when there is nothing to report. */
export function formatPluginCacheReport(report: PluginCacheReport, dryRun: boolean): string | undefined {
  const parts: string[] = []
  if (report.upToDate.length > 0) parts.push(`up-to-date: ${report.upToDate.join(", ")}`)
  if (report.reinstalled.length > 0) parts.push(`${dryRun ? "stale (would reinstall)" : "reinstalled"}: ${report.reinstalled.join(", ")}`)
  if (report.invalidated.length > 0) parts.push(`invalidated: ${report.invalidated.join(", ")}`)
  return parts.length > 0 ? parts.join("; ") : undefined
}

export { PACKAGE_NAME }
