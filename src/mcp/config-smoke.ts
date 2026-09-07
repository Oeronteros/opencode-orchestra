import { readFile } from "node:fs/promises"
import path from "node:path"
import { parse, type ParseError } from "jsonc-parser"
import { openCodeConfigDirectory } from "../config/paths.js"
import { smokeMcp, type McpSmokeCall } from "./smoke.js"

interface LocalMcpConfig {
  type?: unknown
  command?: unknown
  cwd?: unknown
  enabled?: unknown
}

export interface ConfiguredMcpSmokeResult {
  name: string
  status: "ok" | "failed" | "skipped"
  durationMs: number
  tools: string[]
  error?: string
}

export interface ConfiguredMcpSmokeReport {
  configFile: string
  projectDirectory: string
  ok: boolean
  results: ConfiguredMcpSmokeResult[]
}

export interface ConfiguredMcpSmokeOptions {
  configDirectory?: string
  projectDirectory?: string
  timeoutMs?: number
}

async function mainConfig(configDirectory: string): Promise<string> {
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const candidate = path.join(configDirectory, name)
    try {
      await readFile(candidate, "utf8")
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  throw new Error(`OpenCode config not found in ${configDirectory}`)
}

function parseConfig(text: string, file: string): Record<string, unknown> {
  const errors: ParseError[] = []
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const value = parse(normalized, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0 || typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Cannot read MCP configuration from ${file}`)
  }
  return value as Record<string, unknown>
}

function smokeCall(name: string, projectDirectory: string): McpSmokeCall | undefined {
  if (name === "git") return { tool: "git_status", arguments: { repo_path: projectDirectory } }
  if (name === "ast-grep") {
    return {
      tool: "dump_syntax_tree",
      arguments: { code: "const orchestraSmoke = true", language: "typescript", format: "pattern" },
    }
  }
  return undefined
}

/** Probe every enabled local MCP from the effective OpenCode config. */
export async function smokeConfiguredMcps(options: ConfiguredMcpSmokeOptions = {}): Promise<ConfiguredMcpSmokeReport> {
  const configDirectory = path.resolve(options.configDirectory ?? openCodeConfigDirectory())
  const projectDirectory = path.resolve(options.projectDirectory ?? process.cwd())
  const configFile = await mainConfig(configDirectory)
  const config = parseConfig(await readFile(configFile, "utf8"), configFile)
  const mcp = typeof config.mcp === "object" && config.mcp !== null && !Array.isArray(config.mcp)
    ? config.mcp as Record<string, LocalMcpConfig>
    : {}

  const results = await Promise.all(Object.entries(mcp).map(async ([name, entry]): Promise<ConfiguredMcpSmokeResult> => {
    if (entry.enabled === false) return { name, status: "skipped", durationMs: 0, tools: [], error: "disabled" }
    if (entry.type === "remote") return { name, status: "skipped", durationMs: 0, tools: [], error: "remote MCP" }
    if (!Array.isArray(entry.command) || !entry.command.every((part) => typeof part === "string") || entry.command.length === 0) {
      return { name, status: "failed", durationMs: 0, tools: [], error: "missing local command" }
    }
    const cwd = typeof entry.cwd === "string" ? path.resolve(projectDirectory, entry.cwd) : projectDirectory
    const call = smokeCall(name, projectDirectory)
    const result = await smokeMcp({
      command: entry.command,
      cwd,
      timeoutMs: options.timeoutMs ?? 60_000,
      ...(call ? { call } : {}),
    })
    return {
      name,
      status: result.ok ? "ok" : "failed",
      durationMs: result.durationMs,
      tools: result.tools,
      ...(result.error ? { error: result.error } : {}),
    }
  }))

  return {
    configFile,
    projectDirectory,
    ok: results.every((result) => result.status !== "failed"),
    results,
  }
}

export function formatConfiguredMcpSmokeReport(report: ConfiguredMcpSmokeReport): string {
  const lines = [
    `MCP live smoke: ${report.ok ? "OK" : "FAILED"}`,
    `Config: ${report.configFile}`,
    `Project: ${report.projectDirectory}`,
  ]
  if (report.results.length === 0) lines.push("- no MCP entries configured")
  for (const result of report.results) {
    const tools = result.tools.length > 0 ? `; ${result.tools.length} tools` : ""
    const error = result.error ? `; ${result.error}` : ""
    lines.push(`- ${result.name}: ${result.status} (${result.durationMs}ms${tools}${error})`)
  }
  return lines.join("\n")
}
