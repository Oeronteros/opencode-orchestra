import { access, readFile } from "node:fs/promises"
import path from "node:path"
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser"
import type { OrchestraConfig, OrchestraPluginOptions } from "./schema.js"
import { orchestraConfigSchema } from "./schema.js"
import { globalOrchestraConfig } from "./paths.js"

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function mergeConfig(base: unknown, override: unknown): unknown {
  if (!isObject(base) || !isObject(override)) return override
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    result[key] = key in result ? mergeConfig(result[key], value) : value
  }
  return result
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

async function readJsonc(file: string): Promise<unknown> {
  const text = await readFile(file, "utf8")
  const errors: ParseError[] = []
  const value = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0) {
    const details = errors.map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`).join(", ")
    throw new Error(`Invalid Orchestra config ${file}: ${details}`)
  }
  return value
}

export interface LoadedConfig {
  config: OrchestraConfig
  source?: string
}

export async function loadConfig(
  directory: string,
  rawOptions: Record<string, unknown> = {},
): Promise<LoadedConfig> {
  const options = { ...rawOptions } as OrchestraPluginOptions
  const explicit = typeof options.configFile === "string" ? options.configFile : undefined
  delete options.configFile

  // Prefer JSONC when both project variants exist instead of silently merging
  // two sibling files. Global settings remain the lowest-precedence layer.
  const projectJsonc = path.join(directory, ".opencode", "orchestra.jsonc")
  const projectJson = path.join(directory, ".opencode", "orchestra.json")
  const project = (await exists(projectJsonc)) ? projectJsonc : projectJson
  const candidates = explicit
    ? [path.resolve(directory, explicit)]
    : [globalOrchestraConfig(), project]
  const sources = (
    await Promise.all(candidates.map(async (candidate) => ((await exists(candidate)) ? candidate : undefined)))
  ).filter((candidate): candidate is string => Boolean(candidate))
  let fromFile: unknown = {}
  for (const source of sources) fromFile = mergeConfig(fromFile, await readJsonc(source))
  const merged = mergeConfig(fromFile, options)

  return {
    config: orchestraConfigSchema.parse(merged),
    ...(sources.length > 0 ? { source: sources.join(" -> ") } : {}),
  }
}
