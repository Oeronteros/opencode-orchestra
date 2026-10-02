import { z } from "zod"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { Info, ToolContext, Result } from "@opencode/plugin/promise/tool"
import type { Registration } from "@opencode/plugin/promise/registration"
import { Mcp } from "@opencode/plugin"
import type { BrowserManager } from "./manager.js"
import { backendCommand, backendEntry } from "./packages.js"
import { browserTool, managedServer, type BrowserBackend } from "./policy.js"
import type { BrowserHost, BrowserRuntime } from "./runtime.js"

const hosts = new WeakMap<object, NativeBrowserHost>()
export function registerBrowserHost(client: object, ctx: Context): NativeBrowserHost {
  const host = new NativeBrowserHost(ctx)
  hosts.set(client, host)
  return host
}
export function browserHost(client: object): NativeBrowserHost | undefined { return hosts.get(client) }

const controlSchema = z.object({
  action: z.enum(["status", "prepare", "release", "restart"]),
  profile: z.string().optional(),
  task: z.enum(["ui", "visual", "console-network", "diagnostics", "performance", "documentation", "e2e"]).optional(),
  reason: z.string().optional(),
})

/** Native transport owns MCP lifecycle. This wrapper only adds scenario authorization. */
export class NativeBrowserHost implements BrowserHost {
  private runtime?: BrowserRuntime
  private configs = new Map<string, Mcp.ServerConfig>()
  private originals = new Map<string, Info>()
  private conflicts = new Set<BrowserBackend>()
  private browserServers = new Map<string, BrowserBackend>()
  private registrations: Registration[] = []
  constructor(private readonly ctx: Context) {}
  bind(runtime: BrowserRuntime): void { this.runtime = runtime }
  available(): Record<BrowserBackend, boolean> {
    return { playwright: Boolean(backendEntry("playwright")) && !this.conflicts.has("playwright"), devtools: Boolean(backendEntry("devtools")) && !this.conflicts.has("devtools") }
  }
  async connected(): Promise<Record<BrowserBackend, boolean>> {
    const result = await this.ctx.mcp.list()
    return { playwright: result.data.some((s) => s.name === managedServer("playwright") && s.status.status === "connected"), devtools: result.data.some((s) => s.name === managedServer("devtools") && s.status.status === "connected") }
  }
  async install(): Promise<void> {
    const runtime = this.runtime
    if (!runtime || runtime.config.mode === "off") return
    this.registrations.push(await this.ctx.mcp.transform((editor) => {
      this.conflicts.clear()
      this.browserServers.clear()
      for (const [name, config] of editor.list()) {
        for (const backend of ["playwright", "devtools"] as const) {
          if (name === managedServer(backend)) { this.conflicts.add(backend); this.browserServers.set(name, backend); continue }
          const command = config.type === "local" ? config.command.join(" ") : ""
          if (backend === "playwright" ? /@playwright\/mcp|playwright-mcp/.test(command) : /chrome-devtools-mcp/.test(command)) {
            this.conflicts.add(backend)
            this.browserServers.set(name, backend)
          }
        }
      }
      for (const [name, config] of this.configs) {
        if (editor.get(name)) continue // Never overwrite a user server, even at our reserved name.
        editor.set(name, config)
      }
    }))
    this.registrations.push(await this.ctx.tool.transform((editor) => {
      editor.add({
        name: "orchestra_browser", description: "Prepare a sealed browser scenario, switch backend with a reason, inspect safe status, release after verification, or restart after release. First login happens in the visible managed window. No credentials in chat.",
        input: controlSchema, options: { codemode: false },
        execute: async (input, context) => {
          const args = controlSchema.parse(input)
          if (args.action === "prepare") await runtime.prepare(context, args.profile, args.task, args.reason)
          else if (args.action === "release") await runtime.release(context)
          else if (args.action === "restart") await runtime.restart(context)
          return { content: JSON.stringify(await runtime.status()) }
        },
      })
      for (const info of editor.list()) {
        let identified = browserTool(info.id)
        if (!identified) for (const [server, backend] of this.browserServers) {
          const prefix = server.replace(/[^a-zA-Z0-9_-]/g, "_") + "_"
          if (info.id.startsWith(prefix)) identified = { backend, name: info.id.slice(prefix.length), managed: false }
        }
        if (!identified) continue
        const original = info.execute
        const tool = identified
        this.originals.set(info.id, info)
        editor.update(info.id, (draft) => {
          // Keep browser operations outside Code Mode until end-to-end permission attribution is verified.
          draft.options = { ...(draft.options?.namespace ? { namespace: draft.options.namespace } : {}), ...(draft.options?.permission ? { permission: draft.options.permission } : {}), codemode: false }
          draft.execute = async (input, context) => {
            if (!tool.managed) throw new Error("browser_user_server_not_managed")
            return runtime.execute(tool.backend, tool.name, input, context, (signal) => original(input, { ...context, signal }))
          }
        })
      }
    }))
  }
  async connect(backend: BrowserBackend, manager: BrowserManager, artifacts: string, signal?: AbortSignal): Promise<void> {
    if (!this.runtime || !manager.endpoint || this.conflicts.has(backend)) throw new Error("browser_user_mcp_conflict_or_endpoint_missing")
    await manager.verify()
    this.configs.set(managedServer(backend), new Mcp.LocalConfig({ type: "local", command: backendCommand(backend, manager.endpoint, this.runtime.config, artifacts), cwd: artifacts, codemode: false,
      environment: { CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1", CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1" }, timeout: new Mcp.TimeoutConfig({ startup: 20000, catalog: 20000, execution: this.runtime.config.operationTimeoutMs }),
    }))
    await this.ctx.mcp.reload()
    const until = Date.now() + this.runtime.config.startupTimeoutMs
    while (Date.now() < until) {
      signal?.throwIfAborted()
      const current = (await this.ctx.mcp.list()).data.find((s) => s.name === managedServer(backend))
      if (current?.status.status === "connected") { await this.ctx.tool.reload(); await this.ctx.tool.list(); return }
      if (current?.status.status === "failed") throw new Error("browser_mcp_connection_failed")
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error("browser_mcp_connection_timeout")
  }
  async call(backend: BrowserBackend, name: string, input: unknown, context: ToolContext): Promise<Result> {
    const id = `${managedServer(backend)}_${name}`
    const original = this.originals.get(id) ?? this.originals.get(id.replace("orchestra-browser-", "orchestra_browser_"))
    if (!original) throw new Error("browser_backend_tool_missing")
    // Used only for fixed prepare-time tab selection and snapshot, after the sealed caller check.
    return original.execute(input, context)
  }
  async disconnect(): Promise<void> {
    this.configs.clear()
    await this.ctx.mcp.reload()
    this.originals.clear()
  }
  async dispose(): Promise<void> {
    await this.runtime?.dispose()
    for (const registration of this.registrations.reverse()) await registration.dispose()
    this.registrations = []
  }
}
