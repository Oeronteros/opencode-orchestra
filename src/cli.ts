#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser"
import { formatPluginCacheReport, openCodePackagesRoot, refreshPluginCache, type PluginCacheReport } from "./cache-refresh.js"
import { openCodeConfigDirectory } from "./config/paths.js"
import { startDashboard, type DashboardOptions } from "./dashboard/server.js"
import { completionFor, SHELL_NAMES } from "./diagnostics/completion.js"
import { formatDoctorReport, runDoctor } from "./diagnostics/doctor.js"
import { checkForUpdates, formatUpdateResult } from "./diagnostics/update.js"
import { resolvePluginVersion } from "./plugin-status.js"

const PACKAGE_NAME = "@oeronteros-1/opencode-orchestra"
// Entry written to `opencode.json`. Keeping `@latest` lets OpenCode re-resolve
// the newest published version on subsequent runs instead of pinning the
// version it first cached under a bare package name.
const PACKAGE_ENTRY = `${PACKAGE_NAME}@latest`
// Official Superpowers entry (obra/superpowers). Superpowers is not published
// to npm; the documented install is a git-backed npm spec added to the
// `plugin` array (https://github.com/obra/superpowers/blob/main/.opencode/INSTALL.md).
const SUPER_POWERS_ENTRY = "superpowers@git+https://github.com/obra/superpowers.git"
const CONTEXT7_URL = "https://mcp.context7.com/mcp"
const PLAYWRIGHT_COMMAND = ["npx", "-y", "@playwright/mcp@latest"]
const CODEBASE_MEMORY_INSTALLER = "https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh"
const CODEBASE_MEMORY_WINDOWS_INSTALLER = "https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.ps1"
const UV_INSTALLER = "https://astral.sh/uv/install.sh"
const UV_WINDOWS_INSTALLER = "https://astral.sh/uv/install.ps1"

export interface InstallOptions {
  configDirectory?: string
  context7: boolean
  codebaseMemory: boolean
  memoryGraph: boolean
  /** Configure Playwright MCP by default; false explicitly disables it. */
  playwright?: boolean
  /** Add the Superpowers plugin (obra/superpowers) to the plugin array by default; false explicitly disables it. */
  superpowers?: boolean
  provisionDependencies: boolean
  force: boolean
  dryRun: boolean
  /**
   * Override for OpenCode's plugin package cache (`packages` directory).
   * Tests point this at a temporary directory so runs never touch the
   * real per-user cache.
   */
  pluginCacheDirectory?: string
}

type DependencyStatus = "installed" | "existing" | "skipped" | "failed"

export interface InstallResult {
  openCodeConfig: string
  orchestraConfig: string
  changed: string[]
  preserved: string[]
  backup?: string
  pluginCache: PluginCacheReport
  dependencies: {
    codebaseMemory: ProvisionedDependency
    memoryGraph: ProvisionedDependency
  }
}

interface ProvisionedDependency {
  command: string | string[]
  status: DependencyStatus
  reason?: string
}

const FORMATTING = { insertSpaces: true, tabSize: 2, eol: "\n" }

function parseObject(text: string, file: string): Record<string, unknown> {
  const errors: ParseError[] = []
  // Editors and generated OpenCode configs may include an UTF-8 BOM.
  // jsonc-parser treats it as an invalid symbol at offset 0.
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const value = parse(normalized, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0) {
    const details = errors.map((error) => `${printParseErrorCode(error.error)}@${error.offset}`).join(", ")
    throw new Error(`Cannot update invalid JSONC file ${file}: ${details}`)
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected a JSON object in ${file}`)
  }
  return value as Record<string, unknown>
}

function setJsonc(text: string, location: (string | number)[], value: unknown): string {
  return applyEdits(text, modify(text, location, value, { formattingOptions: FORMATTING }))
}

/** Normalized package name for an entry: string or `[name, options]`. */
function pluginName(entry: unknown): string | undefined {
  let raw: string | undefined
  if (typeof entry === "string") raw = entry
  else if (Array.isArray(entry) && typeof entry[0] === "string") raw = entry[0]
  else return undefined
  // Strip a version range/tag (@latest, @1.2.3) so that
  // "@oeronteros-1/opencode-orchestra@latest" compares equal to the bare name.
  // The tag separator is the "@" following the last "/" (after the scoped name).
  const slash = raw.lastIndexOf("/")
  const at = slash === -1 ? raw.indexOf("@") : raw.indexOf("@", slash)
  return at === -1 ? raw : raw.slice(0, at)
}

/**
 * Normalized Superpowers name: `pluginName` returns the git spec verbatim
 * (its "@" precedes the last "/"), so strip an optional `#fragment` pin and
 * match case-insensitively. The substring match also covers the documented
 * Windows fallback (`~/.config/opencode/node_modules/superpowers`) so we never
 * add a duplicate alongside a user's existing Superpowers entry.
 */
function superPowersName(entry: unknown): string | undefined {
  const name = pluginName(entry)
  if (name === undefined) return undefined
  const hash = name.indexOf("#")
  return (hash === -1 ? name : name.slice(0, hash)).toLowerCase()
}

function superPowersSkillsPath(): string {
  return path.join(openCodePackagesRoot(), SUPER_POWERS_ENTRY, "node_modules", "superpowers", "skills")
}

async function existingMainConfig(configDirectory: string): Promise<string> {
  // OpenCode loads JSONC after JSON when both files exist, so update the
  // later-loaded config to avoid its arrays overriding installer changes.
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const candidate = path.join(configDirectory, name)
    try {
      await readFile(candidate, "utf8")
      return candidate
    } catch {
      // Try the next supported filename.
    }
  }
  return path.join(configDirectory, "opencode.json")
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const temporary = `${file}.orchestra-tmp`
  await writeFile(temporary, content, "utf8")
  await rename(temporary, file)
}

function executable(candidates: string[]): string | undefined {
  return candidates.find((name) => spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0)
}

function powershell(): string | undefined {
  return ["pwsh", "powershell"].find(
    (name) => spawnSync(name, ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" }).status === 0,
  )
}

function executableName(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name
}

/** Resolve a bare command name against PATH, returning the first executable hit. */
function resolvePathExecutable(name: string): string | undefined {
  const env = process.env.PATH ?? ""
  for (const directory of env.split(path.delimiter)) {
    if (!directory) continue
    const candidate = path.join(directory, executableName(name))
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // Keep scanning PATH entries.
    }
  }
  return undefined
}

function localBin(name: string): string {
  return path.join(os.homedir(), ".local", "bin", executableName(name))
}

function codebaseMemoryCandidates(): string[] {
  const candidates = ["codebase-memory-mcp", localBin("codebase-memory-mcp")]
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "codebase-memory-mcp", "codebase-memory-mcp.exe"))
  }
  return candidates
}

function capture(command: string, args: string[]): string | undefined {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  return result.status === 0 ? result.stdout.trim() : undefined
}

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, { stdio: "inherit", ...(env ? { env } : {}) })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Command failed (${result.status ?? "unknown"}): ${command} ${args.join(" ")}`)
}

// Exported for unit tests: installer output must stay single-line and bounded.
export function failureReason(error: unknown): string | undefined {
  const raw = error instanceof Error ? error.message : String(error)
  const reason = raw.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)
  return reason || undefined
}

async function downloadScript(url: string, filename: string): Promise<{ directory: string; file: string }> {
  // Bounded fetch: a hung registry mirror must not stall the whole install.
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`Failed to download ${url}: HTTP ${response.status}`)
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-orchestra-"))
  const file = path.join(directory, filename)
  await writeFile(file, await response.text(), "utf8")
  return { directory, file }
}

async function provisionCodebaseMemory(enabled: boolean): Promise<ProvisionedDependency> {
  if (!enabled) return { command: "codebase-memory-mcp", status: "skipped" }
  const current = executable(codebaseMemoryCandidates())
  if (current) {
    run(current, ["config", "set", "auto_index", "true"])
    return { command: current, status: "existing" }
  }
  const windows = process.platform === "win32"
  const script = await downloadScript(
    windows ? CODEBASE_MEMORY_WINDOWS_INSTALLER : CODEBASE_MEMORY_INSTALLER,
    windows ? "codebase-memory-install.ps1" : "codebase-memory-install.sh",
  )
  try {
    if (windows) {
      const shell = powershell()
      if (!shell) throw new Error("PowerShell is required to install Codebase Memory on Windows.")
      run(shell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script.file, "--skip-config"])
    } else {
      run("bash", [script.file, "--skip-config"])
    }
  } finally {
    await rm(script.directory, { recursive: true, force: true })
  }
  const installed = executable(codebaseMemoryCandidates())
  if (!installed) throw new Error("Codebase Memory installer completed, but its executable was not found.")
  run(installed, ["config", "set", "auto_index", "true"])
  return { command: installed, status: "installed" }
}

async function ensureUv(): Promise<ProvisionedDependency & { command: string }> {
  const current = executable(["uv", localBin("uv")])
  if (current) return { command: current, status: "existing" }
  const windows = process.platform === "win32"
  const script = await downloadScript(
    windows ? UV_WINDOWS_INSTALLER : UV_INSTALLER,
    windows ? "uv-install.ps1" : "uv-install.sh",
  )
  try {
    if (windows) {
      const shell = powershell()
      if (!shell) throw new Error("PowerShell is required to install uv on Windows.")
      run(shell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script.file], {
        ...process.env,
        UV_NO_MODIFY_PATH: "1",
      })
    } else {
      run("sh", [script.file], { ...process.env, UV_NO_MODIFY_PATH: "1" })
    }
  } finally {
    await rm(script.directory, { recursive: true, force: true })
  }
  const installed = executable([localBin("uv"), "uv"])
  if (!installed) throw new Error("uv installer completed, but its executable was not found.")
  return { command: installed, status: "installed" }
}

async function provisionMemoryGraph(enabled: boolean): Promise<ProvisionedDependency> {
  if (!enabled) return { command: "memorygraph", status: "skipped" }
  const current = executable(["memorygraph", localBin("memorygraph")])
  if (current) {
    return {
      command: current === "memorygraph" ? (resolvePathExecutable("memorygraph") ?? current) : current,
      status: "existing",
    }
  }
  // uv provisioning failures abort before the try so they surface verbatim.
  const uv = await ensureUv()
  try {
    run(uv.command, ["tool", "install", "memorygraphMCP>=0.12"])
    const toolBin = capture(uv.command, ["tool", "dir", "--bin"])
    const installed = executable([
      ...(toolBin ? [path.join(toolBin, executableName("memorygraph"))] : []),
      localBin("memorygraph"),
      "memorygraph",
    ])
    if (!installed) throw new Error("memorygraphMCP installed, but its executable was not found.")
    return { command: installed, status: "installed" }
  } catch (error) {
    // PyPI ships a `memorygraph` launcher; fall back to an ephemeral uvx run.
    const uvx = executable([path.join(path.dirname(uv.command), executableName("uvx")), localBin("uvx"), "uvx"])
    if (!uvx) throw error
    return { command: [uvx, "memorygraph"], status: "installed", reason: `uv tool install failed (${failureReason(error)}); using ephemeral uvx` }
  }
}

export async function install(options: InstallOptions): Promise<InstallResult> {
  const shouldProvision = options.provisionDependencies && !options.dryRun
  // Companion MCPs are optional: failed provisioning must not prevent plugin setup.
  const codebase = options.codebaseMemory
    ? await provisionCodebaseMemory(shouldProvision).catch((error: unknown) => {
        const reason = failureReason(error)
        return { command: "codebase-memory-mcp", status: "failed" as const, ...(reason ? { reason } : {}) }
      })
    : { command: "codebase-memory-mcp", status: "skipped" as const }
  const memoryGraph = options.memoryGraph
    ? await provisionMemoryGraph(shouldProvision).catch((error: unknown) => {
        const reason = failureReason(error)
        return { command: "memorygraph", status: "failed" as const, ...(reason ? { reason } : {}) }
      })
    : { command: "memorygraph", status: "skipped" as const }

  const configDirectory = path.resolve(options.configDirectory ?? openCodeConfigDirectory())
  const openCodeConfig = await existingMainConfig(configDirectory)
  const orchestraConfig = path.join(configDirectory, "orchestra.jsonc")
  if (!options.dryRun) await mkdir(configDirectory, { recursive: true })

  let original = "{}\n"
  let existed = false
  try {
    original = await readFile(openCodeConfig, "utf8")
    existed = true
  } catch {
    // A new config is created below.
  }
  const root = parseObject(original, openCodeConfig)
  let updated = original
  const changed: string[] = []
  const preserved: string[] = []

  if (!("$schema" in root)) updated = setJsonc(updated, ["$schema"], "https://opencode.ai/config.json")

  const plugins = Array.isArray(root.plugin) ? [...root.plugin] : []
  if (root.plugin !== undefined && !Array.isArray(root.plugin)) {
    throw new Error(`Expected \"plugin\" to be an array in ${openCodeConfig}`)
  }
  let pluginsChanged = false
  const existing = plugins.findIndex((entry) => pluginName(entry) === PACKAGE_NAME)
  if (existing === -1) {
    // Not present at all: add the @latest entry so future runs re-resolve.
    plugins.push(PACKAGE_ENTRY)
    changed.push("plugin")
    pluginsChanged = true
  } else {
    const current = plugins[existing]
    const currentSpec = typeof current === "string"
      ? current
      : Array.isArray(current) && typeof current[0] === "string"
        ? current[0]
        : undefined
    // Add a resolvable tag to a bare package name, but preserve explicit
    // versions/tags so installing companions cannot change a working plugin.
    if (currentSpec === PACKAGE_NAME) {
      const wasOptions = Array.isArray(plugins[existing])
      const options = wasOptions ? plugins[existing][1] : undefined
      plugins[existing] = options !== undefined ? [PACKAGE_ENTRY, options] : PACKAGE_ENTRY
      changed.push("plugin")
      pluginsChanged = true
    }
  }
  if (options.superpowers !== false) {
    const superPowersIndex = plugins.findIndex((entry) => superPowersName(entry)?.includes("superpowers"))
    if (superPowersIndex === -1) {
      plugins.push(SUPER_POWERS_ENTRY)
      if (!changed.includes("plugin")) changed.push("plugin")
      pluginsChanged = true
    }
    // Present in any form (pinned, local path): preserve it. The installer
    // contract preserves user plugins rather than upgrading foreign ones.
  }
  if (pluginsChanged) updated = setJsonc(updated, ["plugin"], plugins)

  const agent = typeof root.agent === "object" && root.agent !== null && !Array.isArray(root.agent)
    ? (root.agent as Record<string, unknown>)
    : {}
  if (root.agent !== undefined && (typeof root.agent !== "object" || root.agent === null || Array.isArray(root.agent))) {
    throw new Error(`Expected \"agent\" to be an object in ${openCodeConfig}`)
  }
  const lead = typeof agent["orch-lead"] === "object" && agent["orch-lead"] !== null && !Array.isArray(agent["orch-lead"])
    ? (agent["orch-lead"] as Record<string, unknown>)
    : {}
  if (agent["orch-lead"] !== undefined && (typeof agent["orch-lead"] !== "object" || agent["orch-lead"] === null || Array.isArray(agent["orch-lead"]))) {
    throw new Error(`Expected \"agent.orch-lead\" to be an object in ${openCodeConfig}`)
  }
  if (lead.mode !== "primary") {
    updated = setJsonc(updated, ["agent", "orch-lead", "mode"], "primary")
    changed.push("agent.orch-lead.mode")
  }
  if (lead.hidden !== false) {
    updated = setJsonc(updated, ["agent", "orch-lead", "hidden"], false)
    changed.push("agent.orch-lead.hidden")
  }

  if (options.superpowers !== false) {
    const skills = typeof root.skills === "object" && root.skills !== null && !Array.isArray(root.skills)
      ? (root.skills as Record<string, unknown>)
      : {}
    if (root.skills !== undefined && (typeof root.skills !== "object" || root.skills === null || Array.isArray(root.skills))) {
      throw new Error(`Expected \"skills\" to be an object in ${openCodeConfig}`)
    }
    const skillPaths = Array.isArray(skills.paths) ? [...skills.paths] : []
    if (skills.paths !== undefined && !Array.isArray(skills.paths)) {
      throw new Error(`Expected \"skills.paths\" to be an array in ${openCodeConfig}`)
    }
    const superpowersPath = superPowersSkillsPath()
    if (!skillPaths.includes(superpowersPath)) {
      skillPaths.push(superpowersPath)
      updated = setJsonc(updated, ["skills", "paths"], skillPaths)
      changed.push("skills.paths")
    }
  }

  const mcp = typeof root.mcp === "object" && root.mcp !== null && !Array.isArray(root.mcp)
    ? (root.mcp as Record<string, unknown>)
    : {}
  if (root.mcp !== undefined && (typeof root.mcp !== "object" || root.mcp === null || Array.isArray(root.mcp))) {
    throw new Error(`Expected \"mcp\" to be an object in ${openCodeConfig}`)
  }

  const addMcp = (name: string, value: Record<string, unknown>) => {
    if (mcp[name] !== undefined && !options.force) {
      preserved.push(`mcp.${name}`)
      return
    }
    updated = setJsonc(updated, ["mcp", name], value)
    changed.push(`mcp.${name}`)
  }
  if (options.context7) {
    addMcp("context7", { type: "remote", url: CONTEXT7_URL, enabled: true, oauth: false })
  }
  if (options.playwright !== false) {
    addMcp("playwright", { type: "local", command: PLAYWRIGHT_COMMAND, enabled: true, timeout: 30_000 })
  }
  // A failed provisioning never persists an MCP entry pointing at a dead command.
  if (options.codebaseMemory && codebase.status !== "failed") {
    addMcp("codebase-memory", {
      type: "local",
      command: Array.isArray(codebase.command) ? codebase.command : [codebase.command],
      enabled: true,
      timeout: 30_000,
    })
  }
  if (options.memoryGraph && memoryGraph.status !== "failed") {
    addMcp("memorygraph", {
      type: "local",
      command: Array.isArray(memoryGraph.command) ? memoryGraph.command : [memoryGraph.command],
      enabled: true,
      timeout: 30_000,
    })
  }

  let backup: string | undefined
  if (updated !== original && !options.dryRun) {
    if (existed) {
      const stamp = new Date().toISOString().replaceAll(":", "-")
      backup = `${openCodeConfig}.bak-${stamp}`
      await copyFile(openCodeConfig, backup)
    }
    await atomicWrite(openCodeConfig, updated.endsWith("\n") ? updated : `${updated}\n`)
  }

  // Reinstalling the plugin must also refresh OpenCode's package cache:
  // an entry like `@latest` keeps its first-resolved version until removed.
  const pluginCache = await refreshPluginCache({
    packagesRoot: path.resolve(options.pluginCacheDirectory ?? openCodePackagesRoot()),
    targetVersion: await resolvePluginVersion(),
    ...(options.dryRun ? { dryRun: true } : {}),
  })

  try {
    const orchestraOriginal = await readFile(orchestraConfig, "utf8")
    parseObject(orchestraOriginal, orchestraConfig)
    preserved.push("orchestra.jsonc")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    changed.push("orchestra.jsonc")
    if (!options.dryRun) {
      const content = `${JSON.stringify(
        {
          $schema: "https://unpkg.com/@oeronteros-1/opencode-orchestra@latest/schema/opencode-orchestra.schema.json",
          budget: "balanced",
          models: { strategy: "auto", agents: {} },
        },
        null,
        2,
      )}\n`
      await atomicWrite(orchestraConfig, content)
    }
  }

  return {
    openCodeConfig,
    orchestraConfig,
    changed,
    preserved,
    ...(backup ? { backup } : {}),
    pluginCache,
    dependencies: {
      codebaseMemory: codebase,
      memoryGraph: memoryGraph,
    },
  }
}

function usage(): string {
  return [
    "OpenCode Orchestra",
    "",
    "Usage:",
    "  bunx @oeronteros-1/opencode-orchestra@latest <command> [options]",
    "",
    "Commands:",
    "  install     Configure OpenCode and provision companion MCPs",
    "  dashboard   Start the local telemetry dashboard",
    "  doctor      Diagnose config, MCPs, and toolchain paths",
    "  update      Check for a newer published version",
    "  completion  Print shell completion (zsh | bash | pwsh)",
    "",
    "Install options:",
    "  --no-context7        Do not configure Context7 MCP",
    "  --no-codebase-memory Do not install or configure Codebase Memory MCP",
    "  --no-memorygraph     Do not install or configure MemoryGraph MCP",
    "  --no-playwright      Do not configure Playwright MCP",
    "  --no-superpowers     Do not add the Superpowers plugin",
    "  --no-deps            Only write config; do not install local MCP executables",
    "  --force              Replace existing MCP entries with Orchestra defaults",
    "  --dry-run            Show intended changes without writing files or downloading",
    "  --config-dir DIR     Override the OpenCode config directory",
    "",
    "Dashboard options:",
    "  --directory DIR      Project whose local telemetry should be displayed",
    "  --config-dir DIR     Override the OpenCode config directory",
    "  --host HOST          Bind address (default: 127.0.0.1)",
    "  --port PORT          Bind port (default: automatic)",
    "  --no-open            Do not open the browser automatically",
  ].join("\n")
}

type ParsedCommand =
  | { command: "install"; options: InstallOptions }
  | { command: "dashboard"; options: DashboardOptions }
  | { command: "doctor"; options: { configDirectory?: string; json?: boolean } }
  | { command: "update" }
  | { command: "completion"; options: { shell: string; program: string } }

function parseArguments(argv: string[]): ParsedCommand | "help" {
  if (argv[0] === "--help" || argv[0] === "-h") return "help"
  if (argv[0] === "dashboard") {
    const options: DashboardOptions = {}
    for (let index = 1; index < argv.length; index += 1) {
      const argument = argv[index]
      if (argument === "--no-open") options.open = false
      else if (argument === "--directory") {
        const directory = argv[++index]
        if (!directory) throw new Error("--directory requires a path")
        options.directory = directory
      } else if (argument === "--config-dir") {
        const directory = argv[++index]
        if (!directory) throw new Error("--config-dir requires a directory")
        options.configDirectory = directory
      } else if (argument === "--host") {
        const host = argv[++index]
        if (!host) throw new Error("--host requires an address")
        options.host = host
      } else if (argument === "--port") {
        const port = Number(argv[++index])
        if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("--port requires a number from 0 to 65535")
        options.port = port
      } else throw new Error(`Unknown dashboard option: ${argument}`)
    }
    return { command: "dashboard", options }
  }
  if (argv[0] === "doctor") {
    const options: { configDirectory?: string; json?: boolean } = {}
    for (let index = 1; index < argv.length; index += 1) {
      const argument = argv[index]
      if (argument === "--config-dir") {
        const directory = argv[++index]
        if (!directory) throw new Error("--config-dir requires a directory")
        options.configDirectory = directory
      } else if (argument === "--json") {
        options.json = true
      } else throw new Error(`Unknown doctor option: ${argument}`)
    }
    return { command: "doctor", options }
  }
  if (argv[0] === "update") {
    for (let index = 1; index < argv.length; index += 1) throw new Error(`Unknown update option: ${argv[index]}`)
    return { command: "update" }
  }
  if (argv[0] === "completion") {
    const shell = argv[1]
    if (!shell || (SHELL_NAMES as readonly string[]).includes(shell) === false) {
      throw new Error(`completion requires one of: ${SHELL_NAMES.join(", ")}`)
    }
    for (let index = 2; index < argv.length; index += 1) throw new Error(`Unknown completion option: ${argv[index]}`)
    return { command: "completion", options: { shell, program: "opencode-orchestra" } }
  }
  if (argv[0] !== "install") throw new Error(`Unknown command: ${argv[0] ?? "(missing)"}`)
  const options: InstallOptions = {
    context7: true,
    codebaseMemory: true,
    memoryGraph: true,
    playwright: true,
    superpowers: true,
    provisionDependencies: true,
    force: false,
    dryRun: false,
  }
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--no-context7") options.context7 = false
    else if (argument === "--no-codebase-memory") options.codebaseMemory = false
    else if (argument === "--no-memorygraph") options.memoryGraph = false
    else if (argument === "--no-playwright") options.playwright = false
    else if (argument === "--no-superpowers") options.superpowers = false
    else if (argument === "--no-deps") options.provisionDependencies = false
    else if (argument === "--force") options.force = true
    else if (argument === "--dry-run") options.dryRun = true
    else if (argument === "--config-dir") {
      const directory = argv[++index]
      if (!directory) throw new Error("--config-dir requires a directory")
      options.configDirectory = directory
    } else throw new Error(`Unknown option: ${argument}`)
  }
  return { command: "install", options }
}

async function main(): Promise<void> {
  try {
    const parsed = parseArguments(process.argv.slice(2))
    if (parsed === "help") {
      console.log(usage())
      return
    }
    if (parsed.command === "dashboard") {
      const dashboard = await startDashboard(parsed.options)
      console.log(`Orchestra dashboard: ${dashboard.url}`)
      console.log("Press Ctrl+C to stop.")
      return
    }
    if (parsed.command === "doctor") {
      const report = await runDoctor({ ...(parsed.options.configDirectory ? { configDirectory: parsed.options.configDirectory } : {}) })
      if (parsed.options.json) {
        console.log(JSON.stringify(report, null, 2))
      } else {
        console.log(formatDoctorReport(report))
      }
      return
    }
    if (parsed.command === "update") {
      console.log(formatUpdateResult(await checkForUpdates(await resolvePluginVersion())))
      return
    }
    if (parsed.command === "completion") {
      console.log(completionFor(parsed.options.shell, parsed.options.program))
      return
    }
    const result = await install(parsed.options)
    console.log(`OpenCode Orchestra configured: ${result.openCodeConfig}`)
    console.log(`Agent settings: ${result.orchestraConfig}`)
    const cacheSummary = formatPluginCacheReport(result.pluginCache, parsed.options.dryRun)
    console.log(`OpenCode plugin cache: ${cacheSummary ?? "no cached Orchestra entries"}`)
    const dependencyLine = ({ status, reason }: ProvisionedDependency): string => `${status}${reason ? ` (${reason})` : ""}`
    console.log(`Codebase Memory: ${dependencyLine(result.dependencies.codebaseMemory)}`)
    console.log(`MemoryGraph: ${dependencyLine(result.dependencies.memoryGraph)}`)
    if (result.changed.length > 0) console.log(`Changed: ${result.changed.join(", ")}`)
    if (result.preserved.length > 0) console.log(`Preserved: ${result.preserved.join(", ")}`)
    if (result.backup) console.log(`Backup: ${result.backup}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error(usage())
    process.exitCode = 1
  }
}

const invoked = process.argv[1]
  ? pathToFileURL(await realpath(path.resolve(process.argv[1])).catch(() => path.resolve(process.argv[1] as string))).href
  : ""
if (invoked === import.meta.url) await main()
