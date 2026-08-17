#!/usr/bin/env bun

import { spawnSync } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser"
import { openCodeConfigDirectory } from "./config/paths.js"
import { startDashboard, type DashboardOptions } from "./dashboard/server.js"

const PACKAGE_NAME = "@oeronteros-1/opencode-orchestra"
// Entry written to `opencode.json`. Keeping `@latest` lets OpenCode re-resolve
// the newest published version on subsequent runs instead of pinning the
// version it first cached under a bare package name.
const PACKAGE_ENTRY = `${PACKAGE_NAME}@latest`
const CONTEXT7_URL = "https://mcp.context7.com/mcp"
const CODEBASE_MEMORY_INSTALLER = "https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh"
const CODEBASE_MEMORY_WINDOWS_INSTALLER = "https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.ps1"
const UV_INSTALLER = "https://astral.sh/uv/install.sh"
const UV_WINDOWS_INSTALLER = "https://astral.sh/uv/install.ps1"

export interface InstallOptions {
  configDirectory?: string
  context7: boolean
  codebaseMemory: boolean
  memoryGraph: boolean
  provisionDependencies: boolean
  force: boolean
  dryRun: boolean
}

type DependencyStatus = "installed" | "existing" | "skipped"

export interface InstallResult {
  openCodeConfig: string
  orchestraConfig: string
  changed: string[]
  preserved: string[]
  backup?: string
  dependencies: {
    codebaseMemory: DependencyStatus
    memoryGraph: DependencyStatus
  }
}

interface ProvisionedDependency {
  command: string
  status: DependencyStatus
}

const FORMATTING = { insertSpaces: true, tabSize: 2, eol: "\n" }

function parseObject(text: string, file: string): Record<string, unknown> {
  const errors: ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false })
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

async function existingMainConfig(configDirectory: string): Promise<string> {
  for (const name of ["opencode.json", "opencode.jsonc"]) {
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

async function downloadScript(url: string, filename: string): Promise<{ directory: string; file: string }> {
  const response = await fetch(url, { redirect: "follow" })
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

async function ensureUv(): Promise<ProvisionedDependency> {
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
  if (current) return { command: current, status: "existing" }
  const uv = await ensureUv()
  run(uv.command, ["tool", "install", "memorygraphMCP"])
  const toolBin = capture(uv.command, ["tool", "dir", "--bin"])
  const installed = executable([
    ...(toolBin ? [path.join(toolBin, executableName("memorygraph"))] : []),
    localBin("memorygraph"),
    "memorygraph",
  ])
  if (!installed) throw new Error("memorygraphMCP installed, but its executable was not found.")
  return { command: installed, status: "installed" }
}

export async function install(options: InstallOptions): Promise<InstallResult> {
  const shouldProvision = options.provisionDependencies && !options.dryRun
  const codebase = options.codebaseMemory
    ? await provisionCodebaseMemory(shouldProvision)
    : { command: "codebase-memory-mcp", status: "skipped" as const }
  const memoryGraph = options.memoryGraph
    ? await provisionMemoryGraph(shouldProvision)
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
  } else if (plugins[existing] !== PACKAGE_ENTRY) {
    // Present but pinned to a bare name or a specific version: upgrade to
    // @latest so the plugin actually tracks new releases.
    const wasOptions = Array.isArray(plugins[existing])
    const options = wasOptions ? plugins[existing][1] : undefined
    plugins[existing] = options !== undefined ? [PACKAGE_ENTRY, options] : PACKAGE_ENTRY
    changed.push("plugin")
    pluginsChanged = true
  }
  if (pluginsChanged) updated = setJsonc(updated, ["plugin"], plugins)

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
  if (options.codebaseMemory) {
    addMcp("codebase-memory", {
      type: "local",
      command: [codebase.command],
      enabled: true,
      timeout: 30_000,
    })
  }
  if (options.memoryGraph) {
    addMcp("memorygraph", {
      type: "local",
      command: [memoryGraph.command],
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
    dependencies: {
      codebaseMemory: codebase.status,
      memoryGraph: memoryGraph.status,
    },
  }
}

function usage(): string {
  return [
    "OpenCode Orchestra",
    "",
    "Usage:",
    "  bunx @oeronteros-1/opencode-orchestra@latest install [options]",
    "  bunx @oeronteros-1/opencode-orchestra@latest dashboard [options]",
    "",
    "Options:",
    "  --no-context7        Do not configure Context7 MCP",
    "  --no-codebase-memory Do not install or configure Codebase Memory MCP",
    "  --no-memorygraph     Do not install or configure MemoryGraph MCP",
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

type ParsedCommand = { command: "install"; options: InstallOptions } | { command: "dashboard"; options: DashboardOptions }

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
  if (argv[0] !== "install") throw new Error(`Unknown command: ${argv[0] ?? "(missing)"}`)
  const options: InstallOptions = {
    context7: true,
    codebaseMemory: true,
    memoryGraph: true,
    provisionDependencies: true,
    force: false,
    dryRun: false,
  }
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--no-context7") options.context7 = false
    else if (argument === "--no-codebase-memory") options.codebaseMemory = false
    else if (argument === "--no-memorygraph") options.memoryGraph = false
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
    const result = await install(parsed.options)
    console.log(`OpenCode Orchestra configured: ${result.openCodeConfig}`)
    console.log(`Agent settings: ${result.orchestraConfig}`)
    console.log(`Codebase Memory: ${result.dependencies.codebaseMemory}`)
    console.log(`MemoryGraph: ${result.dependencies.memoryGraph}`)
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
