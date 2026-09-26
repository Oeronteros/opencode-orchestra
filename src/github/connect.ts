import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser"
import { openCodeConfigDirectory } from "../config/paths.js"
import { spawnWithCmdFallback } from "../spawn.js"

export const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/"
const TOKEN_REFERENCE = "{file:~/.config/opencode-orchestra/github-token}"
const FORMATTING = { insertSpaces: true, tabSize: 2, eol: "\n" }

export interface GithubConnectResult {
  openCodeConfig: string
  tokenFile: string
  backup?: string
}

function environmentToken(): string | undefined {
  return (process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN)?.trim()
}

function capture(command: string, args: string[]): string | undefined {
  const result = spawnWithCmdFallback(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  return result.status === 0 ? String(result.stdout).trim() : undefined
}

function hasGithubCli(): boolean {
  return spawnWithCmdFallback("gh", ["--version"], { stdio: "ignore" }).status === 0
}

/** Start browser sign-in without blocking OpenCode's event loop. */
export async function githubTokenInOpenCode(): Promise<string> {
  const fromEnvironment = environmentToken()
  if (fromEnvironment) return fromEnvironment
  if (!hasGithubCli()) throw new Error("GitHub CLI is required for /github-connect: https://cli.github.com/")
  const existing = capture("gh", ["auth", "token", "--hostname", "github.com"])
  if (existing) return existing
  await new Promise<void>((resolve, reject) => {
    const child = spawn("gh", ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--clipboard"], {
      stdio: "ignore",
      windowsHide: true,
    })
    child.once("error", reject)
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("GitHub browser sign-in did not complete")))
  })
  const token = capture("gh", ["auth", "token", "--hostname", "github.com"])
  if (!token) throw new Error("GitHub CLI did not return a token after sign-in")
  return token
}

function parseObject(text: string, file: string): Record<string, unknown> {
  const errors: ParseError[] = []
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const value = parse(normalized, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length) throw new Error(`Cannot update invalid JSONC file ${file}: ${errors.map((error) => `${printParseErrorCode(error.error)}@${error.offset}`).join(", ")}`)
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Expected a JSON object in ${file}`)
  return value as Record<string, unknown>
}

async function mainConfigFile(directory: string): Promise<string> {
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const file = path.join(directory, name)
    try {
      await readFile(file, "utf8")
      return file
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return path.join(directory, "opencode.json")
}

/** Keep the credential out of OpenCode's JSONC configuration. */
export async function connectGithub(token: string, options: { configDirectory?: string; homeDirectory?: string } = {}): Promise<GithubConnectResult> {
  if (!token || /\s/.test(token)) throw new Error("GitHub token must be a non-empty single line")
  const configDirectory = path.resolve(options.configDirectory ?? openCodeConfigDirectory())
  const openCodeConfig = await mainConfigFile(configDirectory)
  let original = "{}\n"
  let existed = false
  try {
    original = await readFile(openCodeConfig, "utf8")
    existed = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const root = parseObject(original, openCodeConfig)
  const mcp = root.mcp === undefined ? {} : parseObject(JSON.stringify(root.mcp), openCodeConfig)
  const nativeMcp = root.plugins !== undefined || root.agents !== undefined || mcp.servers !== undefined
  const servers = nativeMcp && mcp.servers !== undefined ? parseObject(JSON.stringify(mcp.servers), openCodeConfig) : mcp
  const existing = servers.github
  if (existing !== undefined && (typeof existing !== "object" || existing === null || Array.isArray(existing))) {
    throw new Error("Existing GitHub MCP entry is not an object")
  }
  const github = (existing ?? {}) as Record<string, unknown>
  if (existing !== undefined && (github.type !== "remote" || github.url !== GITHUB_MCP_URL)) {
    throw new Error("Existing GitHub MCP entry uses a different server; update it manually")
  }
  const headers = github.headers && typeof github.headers === "object" && !Array.isArray(github.headers)
    ? github.headers as Record<string, unknown>
    : {}
  const entry: Record<string, unknown> = {
    ...github,
    type: "remote",
    url: GITHUB_MCP_URL,
    headers: { ...headers, Authorization: `Bearer ${TOKEN_REFERENCE}` },
    oauth: false,
  }
  if (nativeMcp) {
    delete entry.enabled
    entry.disabled = false
  } else {
    delete entry.disabled
    entry.enabled = true
  }
  const updated = applyEdits(original, modify(original, nativeMcp ? ["mcp", "servers", "github"] : ["mcp", "github"], entry, { formattingOptions: FORMATTING }))

  const secretDirectory = path.join(path.resolve(options.homeDirectory ?? os.homedir()), ".config", "opencode-orchestra")
  const tokenFile = path.join(secretDirectory, "github-token")
  await mkdir(secretDirectory, { recursive: true, mode: 0o700 })
  const temporary = path.join(secretDirectory, `github-token.${process.pid}.${randomBytes(6).toString("hex")}.tmp`)
  try {
    await writeFile(temporary, token, { mode: 0o600, flag: "wx" })
    await rename(temporary, tokenFile)
    if (process.platform !== "win32") await chmod(tokenFile, 0o600)
  } finally {
    await rm(temporary, { force: true })
  }

  let backup: string | undefined
  if (updated !== original) {
    await mkdir(configDirectory, { recursive: true })
    if (existed) {
      backup = `${openCodeConfig}.bak-${new Date().toISOString().replaceAll(":", "-")}`
      await copyFile(openCodeConfig, backup)
    }
    const configTemporary = `${openCodeConfig}.orchestra-tmp`
    await writeFile(configTemporary, updated.endsWith("\n") ? updated : `${updated}\n`, "utf8")
    await rename(configTemporary, openCodeConfig)
  }
  return { openCodeConfig, tokenFile, ...(backup ? { backup } : {}) }
}
