import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser"
import { openCodeConfigDirectory } from "../config/paths.js"
import { resolvePluginVersion } from "../plugin-status.js"
import { homeDirectory, spawnWithCmdFallback } from "../spawn.js"

export const PACKAGE_NAME = "@oeronteros-1/opencode-orchestra"

/** Composable check statuses, ordered from worst to best for sorting reports. */
export type CheckStatus = "error" | "warning" | "ok" | "info"

export type Check = {
  id: string
  label: string
  status: CheckStatus
  detail: string
  hint?: string
}

const STATUS_ORDER: Record<CheckStatus, number> = { error: 0, warning: 1, ok: 2, info: 3 }

function statusIcon(status: CheckStatus): string {
  switch (status) {
    case "error": return "✗"
    case "warning": return "!"
    case "ok": return "✓"
    case "info": return "·"
  }
}

function formatVersion(value: string | undefined): string {
  return value && value.trim() ? value.trim() : "unknown"
}

/**
 * Probe a command's exit status. Native spawn first; Windows cannot spawn
 * `.cmd`/`.bat` shims or scripts directly, so those retry through cmd.exe
 * (skipped for inputs cmd.exe could reinterpret — see spawn.ts).
 */
function probeStatus(command: string, args: string[]): number | null {
  return spawnWithCmdFallback(command, args, { stdio: "ignore" }).status
}

function isExecutable(pathLike: string): boolean {
  return probeStatus(pathLike, ["--version"]) === 0
}

/** Resolve the first executable from a list of candidates. */
function executable(candidates: string[]): string | undefined {
  return candidates.find((name) => {
    try {
      return probeStatus(name, ["--version"]) === 0
    } catch {
      return false
    }
  })
}

function captureVersion(command: string, args: string[]): string | undefined {
  const result = spawnWithCmdFallback(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  return result.status === 0 ? String(result.stdout).trim().split(/\r?\n/)[0] : undefined
}

function pluginName(entry: unknown): string | undefined {
  let raw: string | undefined
  if (typeof entry === "string") raw = entry
  else if (Array.isArray(entry) && typeof entry[0] === "string") raw = entry[0]
  else return undefined
  const slash = raw.lastIndexOf("/")
  const at = slash === -1 ? raw.indexOf("@") : raw.indexOf("@", slash)
  return at === -1 ? raw : raw.slice(0, at)
}

export interface ReadConfigResult {
  path: string
  parsed: Record<string, unknown>
  errors: string[]
  exists: boolean
}

export async function readConfigFile(file: string): Promise<ReadConfigResult> {
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch {
    return { path: file, parsed: {}, errors: [], exists: false }
  }
  const errors: ParseError[] = []
  // OpenCode configs may be saved with a UTF-8 BOM; jsonc-parser otherwise
  // reports InvalidSymbol at offset 0 and hides the actual plugin state.
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const value = parseJsonc(normalized, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0) {
    return {
      path: file,
      parsed: {},
      errors: errors.map((e) => `${printParseErrorCode(e.error)} @ offset ${e.offset}`),
      exists: true,
    }
  }
  const parsed = typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
  return { path: file, parsed, errors: [], exists: true }
}

export async function findMainConfig(configDirectory: string): Promise<string> {
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const candidate = path.join(configDirectory, name)
    try {
      await readFile(candidate, "utf8")
      return candidate
    } catch {
      // Try the next filename.
    }
  }
  return path.join(configDirectory, "opencode.json")
}

export interface LocalMcp {
  name: string
  commands: string[]
  executable?: string
}

/** Extract MCP servers from the opencode main config, preserving order. */
export function extractMcp(parsed: Record<string, unknown>): { name: string; value: Record<string, unknown> }[] {
  const mcp = parsed.mcp
  if (typeof mcp !== "object" || mcp === null || Array.isArray(mcp)) return []
  return Object.entries(mcp).map(([name, value]) => ({
    name,
    value: typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {},
  }))
}

function commandArgv(mcp: Record<string, unknown>): string[] {
  const command = mcp.command
  if (typeof command === "string") return [command]
  if (Array.isArray(command)) return command.filter((item): item is string => typeof item === "string")
  return []
}

function mcpType(mcp: Record<string, unknown>): string {
  if (typeof mcp.type === "string") return mcp.type
  if (typeof mcp.url === "string") return "remote"
  return "local"
}

/**
 * Collect configured local MCP servers and their installed executables.
 * Non-local servers (remote/url/stdio without a command) are skipped.
 */
export function collectLocalMcps(parsed: Record<string, unknown>): {
  local: LocalMcp[]
  nonLocalCount: number
} {
  const local: LocalMcp[] = []
  let nonLocalCount = 0
  for (const { name, value } of extractMcp(parsed)) {
    const argv = commandArgv(value)
    const type = mcpType(value)
    const enabled = value.enabled !== false
    if (type === "remote" || (argv.length === 0 && type !== "local" && typeof value.url === "string")) {
      nonLocalCount += 1
      continue
    }
    if (argv.length === 0) {
      // A "local" entry without a command is unusable, but not remote.
      if (!enabled) continue
      nonLocalCount += 1
      continue
    }
    let resolved: string | undefined
    if (argv.length === 1) {
      resolved = executable(argv)
    } else {
      const first = argv[0]
      if (first && isExecutable(first) && probeStatus(first, [...argv.slice(1), "--version"]) === 0) {
        resolved = argv.join(" ")
      }
    }
    local.push({ name, commands: argv, ...(resolved ? { executable: resolved } : {}) })
  }
  return { local, nonLocalCount }
}

/** Resolve an executable from candidate paths, returning its version too. */
function resolveExecutable(candidates: string[], versionArgs: string[]): { executable: string | undefined; version: string | undefined } {
  // Dedupe: uv's tool dir and ~/.local/bin often point at the same folder,
  // and probing a slow tool twice would double the doctor's runtime.
  const found = [...new Set(candidates)].find((c) => isExecutable(c))
  if (!found) return { executable: undefined, version: undefined }
  return { executable: found, version: captureVersion(found, versionArgs) }
}

function localBinCandidates(name: string): string[] {
  const base = path.join(homeDirectory(), ".local", "bin")
  if (process.platform === "win32") {
    // Native installs are `.exe`; `.cmd` shims (uv launchers, npm-style
    // wrappers) are accepted too so discovery matches the CLI's behavior.
    return [path.join(base, `${name}.exe`), path.join(base, `${name}.cmd`)]
  }
  return [path.join(base, name)]
}

/** Candidate install locations for uv across platforms. */
function uvCandidates(): { label: string; paths: string[] }[] {
  const candidates: { label: string; paths: string[] }[] = []
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    candidates.push({
      label: "%LOCALAPPDATA%/Programs/uv",
      paths: [path.join(process.env.LOCALAPPDATA, "Programs", "uv", "uv.exe")],
    })
  }
  candidates.push({ label: "~/.local/bin", paths: localBinCandidates("uv") })
  candidates.push({ label: "~/.cargo/bin", paths: [path.join(homeDirectory(), ".cargo", "bin", executableName("uv"))] })
  return candidates
}

function executableName(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name
}

export interface EnvironmentInfo {
  platform: string
  home: string
  shell: string
  nodeVersion: string
  bunVersion: string
  pluginVersion: string
  openCodeVersion: string
}

export function inspectEnvironment(): EnvironmentInfo {
  const shell = process.env.SHELL ?? (process.platform === "win32" ? (process.env.COMSPEC ?? "unknown") : "unknown")
  return {
    platform: `${process.platform} (${process.arch})`,
    home: os.homedir(),
    shell,
    nodeVersion: formatVersion(process.version),
    bunVersion: captureVersion("bun", ["--version"]) ?? "not installed",
    pluginVersion: "resolving…",
    openCodeVersion: captureVersion("opencode", ["--version"]) ?? "not installed",
  }
}

export interface DoctorOptions {
  configDirectory?: string
}

export interface DoctorReport {
  environment: EnvironmentInfo
  configDirectory: string
  mainConfig: ReadConfigResult
  orchestraConfig: ReadConfigResult
  checks: Check[]
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const configDirectory = path.resolve(options.configDirectory ?? openCodeConfigDirectory())
  const mainConfigPath = await findMainConfig(configDirectory)
  const orchestraConfigPath = path.join(configDirectory, "orchestra.jsonc")
  const [mainConfig, orchestraConfig] = await Promise.all([
    readConfigFile(mainConfigPath),
    readConfigFile(orchestraConfigPath),
  ])

  const checks: Check[] = []
  const push = (check: Check) => checks.push(check)

  // --- Config presence & validity ---
  push({
    id: "main-config",
    label: "OpenCode config",
    status: mainConfig.exists ? "ok" : "info",
    detail: mainConfig.exists ? mainConfig.path : "not found (will use OpenCode defaults)",
    ...(mainConfig.exists ? {} : { hint: "Run `opencode-orchestra install` to scaffold it." }),
  })
  if (mainConfig.errors.length > 0) {
    push({
      id: "main-config-valid",
      label: "OpenCode config validity",
      status: "error",
      detail: mainConfig.errors.join("; "),
      hint: "Fix the JSONC syntax; the installer and OpenCode cannot read it.",
    })
  }

  push({
    id: "orchestra-config",
    label: "Orchestra config",
    status: orchestraConfig.exists ? "ok" : "info",
    detail: orchestraConfig.exists ? orchestraConfig.path : "not found (defaults apply)",
    ...(orchestraConfig.exists ? {} : { hint: "Run `opencode-orchestra install` to scaffold it." }),
  })
  if (orchestraConfig.errors.length > 0) {
    push({
      id: "orchestra-config-valid",
      label: "Orchestra config validity",
      status: "error",
      detail: orchestraConfig.errors.join("; "),
      hint: "Fix the JSONC syntax so the plugin can load your overrides.",
    })
  }

  // --- Plugin entry ---
  const plugin = Array.isArray(mainConfig.parsed.plugin) ? mainConfig.parsed.plugin : []
  const pluginEntry = plugin.map(pluginName).find((name) => name === PACKAGE_NAME)
  push({
    id: "plugin-entry",
    label: "Orchestra plugin entry",
    status: pluginEntry ? "ok" : "warning",
    detail: pluginEntry ? "registered in plugin list" : "not registered",
    ...(pluginEntry ? {} : { hint: "Run `opencode-orchestra install` to register the plugin." }),
  })

  // --- MCP server availability ---
  const { local, nonLocalCount } = collectLocalMcps(mainConfig.parsed)
  const known = new Set(["context7", "codebase-memory", "memorygraph"])
  for (const mcp of local) {
    const isKnown = known.has(mcp.name)
    if (mcp.executable) {
      push({
        id: `mcp-${mcp.name}`,
        label: `MCP ${mcp.name}`,
        status: "ok",
        detail: mcp.executable,
      })
    } else {
      push({
        id: `mcp-${mcp.name}`,
        label: `MCP ${mcp.name}`,
        status: "warning",
        detail: `command not found: ${mcp.commands.join(", ")}`,
        ...(isKnown ? { hint: "Run the installer with dependency provisioning, or install it manually." } : {}),
      })
    }
  }
  if (nonLocalCount > 0) {
    push({
      id: "mcp-remote",
      label: "Remote MCP servers",
      status: "info",
      detail: `${nonLocalCount} remote/url server(s) configured (skipped local check)`,
    })
  }

  // --- Toolchain: uv, memorygraph, codebase-memory ---
  const uv = resolveExecutable(uvCandidates().flatMap((c) => c.paths).concat("uv"), ["--version"])
  push({
    id: "uv",
    label: "uv",
    status: uv.executable ? "ok" : "warning",
    detail: uv.executable ? `${uv.executable} — ${uv.version ?? "unknown"}` : "not found",
    ...(uv.executable
      ? {}
      : { hint: "MemoryGraph installs through uv. Install it from https://docs.astral.sh/uv/." }),
  })

  const memorygraphBin = (() => {
    if (!uv.executable) return undefined
    try {
      const dir = spawnWithCmdFallback(uv.executable, ["tool", "dir", "--bin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      return dir.status === 0 ? String(dir.stdout).trim() : undefined
    } catch {
      return undefined
    }
  })()
  const memorygraph = resolveExecutable(
    [
      ...(memorygraphBin ? [path.join(memorygraphBin, executableName("memorygraph"))] : []),
      ...localBinCandidates("memorygraph"),
      "memorygraph",
    ],
    ["--version"],
  )
  push({
    id: "memorygraph",
    label: "MemoryGraph",
    status: memorygraph.executable ? "ok" : "warning",
    detail: memorygraph.executable ? `${memorygraph.executable} — ${memorygraph.version ?? "unknown"}` : "not installed",
    ...(memorygraph.executable ? {} : { hint: "Run `uv tool install memorygraphMCP`, or `opencode-orchestra install`." }),
  })

  const codebaseMemoryCandidates = [
    "codebase-memory-mcp",
    ...localBinCandidates("codebase-memory-mcp"),
    ...(process.platform === "win32" && process.env.LOCALAPPDATA
      ? [path.join(process.env.LOCALAPPDATA, "Programs", "codebase-memory-mcp", "codebase-memory-mcp.exe")]
      : []),
  ]
  const codebaseMemory = resolveExecutable(codebaseMemoryCandidates, ["--version"])
  push({
    id: "codebase-memory",
    label: "Codebase Memory",
    status: codebaseMemory.executable ? "ok" : "info",
    detail: codebaseMemory.executable ? `${codebaseMemory.executable} — ${codebaseMemory.version ?? "unknown"}` : "not installed",
    ...(codebaseMemory.executable ? {} : { hint: "Run `opencode-orchestra install` to provision it." }),
  })

  return {
    environment: {
      ...inspectEnvironment(),
      pluginVersion: await resolvePluginVersion(),
    },
    configDirectory,
    mainConfig,
    orchestraConfig,
    checks: checks.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]),
  }
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = []
  lines.push("OpenCode Orchestra doctor")
  lines.push("")
  lines.push(`  platform      ${report.environment.platform}`)
  lines.push(`  home          ${report.environment.home}`)
  lines.push(`  shell         ${report.environment.shell}`)
  lines.push(`  node          ${report.environment.nodeVersion}`)
  lines.push(`  bun           ${report.environment.bunVersion}`)
  lines.push(`  opencode      ${report.environment.openCodeVersion}`)
  lines.push(`  orchestra     ${report.environment.pluginVersion}`)
  lines.push(`  config dir    ${report.configDirectory}`)
  lines.push("")

  const errors = report.checks.filter((c) => c.status === "error")
  const warnings = report.checks.filter((c) => c.status === "warning")
  lines.push(`Checks (${report.checks.length}): ${errors.length} error(s), ${warnings.length} warning(s)`)
  lines.push("")
  for (const check of report.checks) {
    const icon = statusIcon(check.status)
    lines.push(`  ${icon} ${check.label}`)
    lines.push(`      ${check.detail}`)
    if (check.hint) lines.push(`      → ${check.hint}`)
  }

  if (errors.length === 0) {
    lines.push("")
    lines.push("  All critical checks passed.")
  }
  return lines.join("\n")
}
