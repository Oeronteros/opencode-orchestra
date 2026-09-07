import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { quoteLineForCmd, safeForCmdRetry } from "../spawn.js"

export interface McpSmokeCall {
  tool: string
  arguments: Record<string, unknown>
}

export interface McpSmokeOptions {
  command: string[]
  cwd?: string
  timeoutMs?: number
  call?: McpSmokeCall
}

export interface McpSmokeResult {
  ok: boolean
  durationMs: number
  tools: string[]
  callOutput?: string
  error?: string
}

function bounded(value: unknown, limit = 400): string {
  return String(value ?? "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, limit)
}

function startProcess(command: string[], cwd?: string): ChildProcessWithoutNullStreams {
  const [executable, ...args] = command
  if (!executable) throw new Error("MCP command is empty")
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(executable)) {
    if (!safeForCmdRetry(command)) throw new Error("MCP command contains characters unsafe for cmd.exe")
    return spawn(process.env.COMSPEC ?? "cmd.exe", ["/d", "/s", "/c", quoteLineForCmd(command)], {
      ...(cwd ? { cwd } : {}),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
  }
  return spawn(executable, args, {
    ...(cwd ? { cwd } : {}),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  })
}

/**
 * Start a stdio MCP server, complete initialize + tools/list, and optionally
 * execute one harmless smoke call. This validates the real protocol surface,
 * not merely that the launcher prints --help.
 */
export async function smokeMcp(options: McpSmokeOptions): Promise<McpSmokeResult> {
  const startedAt = Date.now()
  const timeoutMs = options.timeoutMs ?? 45_000
  let child: ChildProcessWithoutNullStreams
  try {
    child = startProcess(options.command, options.cwd)
  } catch (error) {
    return { ok: false, durationMs: Date.now() - startedAt, tools: [], error: bounded(error) }
  }

  return await new Promise<McpSmokeResult>((resolve) => {
    let settled = false
    let resolved = false
    let stdout = ""
    let stderr = ""
    let tools: string[] = []
    let timer: NodeJS.Timeout

    const finish = (result: Omit<McpSmokeResult, "durationMs" | "tools"> & { tools?: string[] }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdin.end()
      const finalResult = { ...result, durationMs: Date.now() - startedAt, tools: result.tools ?? tools }
      const complete = () => {
        if (resolved) return
        resolved = true
        resolve(finalResult)
      }
      if (child.exitCode !== null) {
        complete()
        return
      }
      child.once("exit", complete)
      // Closing stdin normally stops stdio MCP servers. Escalate only if a
      // server ignores EOF, while still bounding how long callers wait.
      const terminate = setTimeout(() => child.kill(), 500)
      terminate.unref?.()
      const hardStop = setTimeout(complete, 5_000)
      hardStop.unref?.()
    }

    const send = (message: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    }

    const handleMessage = (message: { id?: number; result?: unknown; error?: unknown }) => {
      if (message.error !== undefined) {
        finish({ ok: false, error: bounded(JSON.stringify(message.error)) })
        return
      }
      if (message.id === 1) {
        send({ jsonrpc: "2.0", method: "notifications/initialized" })
        send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
        return
      }
      if (message.id === 2) {
        const result = message.result as { tools?: Array<{ name?: unknown }> } | undefined
        tools = (result?.tools ?? []).map((tool) => tool.name).filter((name): name is string => typeof name === "string")
        if (!options.call) {
          finish({ ok: true })
          return
        }
        if (!tools.includes(options.call.tool)) {
          finish({ ok: false, error: `tool not found: ${options.call.tool}` })
          return
        }
        send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: options.call.tool, arguments: options.call.arguments } })
        return
      }
      if (message.id === 3) {
        const result = message.result as { isError?: boolean; content?: Array<{ text?: unknown }> } | undefined
        const callOutput = (result?.content ?? []).map((item) => typeof item.text === "string" ? item.text : "").join("\n")
        if (result?.isError) finish({ ok: false, callOutput: bounded(callOutput), error: bounded(callOutput || "MCP tool returned an error") })
        else finish({ ok: true, callOutput: bounded(callOutput) })
      }
    }

    const consume = () => {
      while (true) {
        const newline = stdout.indexOf("\n")
        if (newline < 0) return
        const line = stdout.slice(0, newline).trim()
        stdout = stdout.slice(newline + 1)
        if (!line) continue
        try {
          handleMessage(JSON.parse(line) as { id?: number; result?: unknown; error?: unknown })
        } catch {
          // Ignore non-protocol stdout and continue until timeout or response.
        }
      }
    }

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => { stdout += chunk; consume() })
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-2_000) })
    child.on("error", (error) => finish({ ok: false, error: bounded(error) }))
    child.on("exit", (code) => {
      if (!settled) finish({ ok: false, error: bounded(stderr || `MCP server exited with ${code ?? "unknown"}`) })
    })
    timer = setTimeout(() => finish({ ok: false, error: bounded(stderr || `MCP smoke test timed out after ${timeoutMs}ms`) }), timeoutMs)
    timer.unref?.()

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "opencode-orchestra", version: "1" },
      },
    })
  })
}
