import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { MCPEditor } from "@opencode/plugin/promise/mcp"
import type { ToolEditor, Info, ToolContext } from "@opencode/plugin/promise/tool"
import type { DeepMutable } from "@opencode/plugin/promise/types"
import { Mcp } from "@opencode/plugin"
import { NativeBrowserHost } from "../src/browser/v2.js"
import { BrowserRuntime } from "../src/browser/runtime.js"
import { browserConfigSchema } from "../src/config/schema.js"
import { BrowserManager } from "../src/browser/manager.js"
import { OrchestrationRunState } from "../src/orchestration/run-state.js"
import { install } from "../src/cli.js"

function harness(userServers: Array<[string, Mcp.ServerConfig]> = []) {
  const mcpTransforms: Array<(editor: MCPEditor) => void> = []
  const toolTransforms: Array<(editor: ToolEditor) => void> = []
  let configs = new Map<string, DeepMutable<Mcp.ServerConfig>>()
  let tools = new Map<string, Info>()
  const replayMcp = () => {
    configs = new Map(userServers.map(([name, config]) => [name, structuredClone(config) as DeepMutable<Mcp.ServerConfig>]))
    const editor: MCPEditor = { list: () => [...configs.entries()], get: (name) => configs.get(name), set: (name, config) => { configs.set(name, structuredClone(config) as DeepMutable<Mcp.ServerConfig>) }, update: (name, edit) => { const value = configs.get(name); if (value) edit(value) }, remove: (name) => { configs.delete(name) } }
    for (const transform of mcpTransforms) transform(editor)
  }
  const replayTools = () => {
    tools = new Map()
    for (const [server] of configs) for (const name of ["browser_snapshot", "take_snapshot", "list_pages", "select_page", "browser_tabs"]) {
      const id = server.replaceAll("-", "_") + "_" + name
      tools.set(id, { name: id, description: "Fixture native MCP tool", input: { type: "object" }, execute: async () => ({ content: name === "list_pages" ? "0: about:blank [selected]" : "snapshot" }) })
    }
    const editor: ToolEditor = {
      list: () => [...tools.entries()].map(([id, info]) => ({ ...info, id })), get: (id) => { const info = tools.get(id); return info ? { ...info, id } : undefined },
      namespace: () => undefined, add: (info) => { tools.set(info.name, info) }, remove: (id) => { tools.delete(id) },
      update: (id, edit) => { const info = tools.get(id); if (!info) return; const mutable = { ...info }; edit(mutable); tools.set(id, mutable) },
    }
    for (const transform of toolTransforms) transform(editor)
  }
  const registration = { dispose: async () => undefined }
  const ctx = {
    mcp: { transform: async (transform: (editor: MCPEditor) => void) => { mcpTransforms.push(transform); replayMcp(); return registration }, reload: async () => { replayMcp(); replayTools() }, list: async () => ({ data: [...configs.keys()].map((name) => ({ name, status: { status: "connected" } })) }) },
    tool: { transform: async (transform: (editor: ToolEditor) => void) => { toolTransforms.push(transform); replayTools(); return registration }, reload: async () => replayTools(), list: async () => [...tools.entries()].map(([id, info]) => ({ ...info, id })) },
  } as unknown as Context
  return { ctx, configs: () => configs, tools: () => tools }
}
class EndpointManager extends BrowserManager {
  override get endpoint() { return "http://127.0.0.1:23456" }
  override async verify() {}
}
test("native transforms are lazy and wrap actual MCP executors; Code Mode is explicitly disabled", async () => {
  const fake = harness()
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-v2-browser-"))
  const config = browserConfigSchema.parse({ mode: "auto" })
  const host = new NativeBrowserHost(fake.ctx)
  const state = new OrchestrationRunState({ maxWorkers: 4, parallelWorkers: 2, maxDelegationDepth: 2 })
  new BrowserRuntime(config, directory, state, host, undefined, directory)
  await host.install()
  assert.equal(fake.configs().size, 0)
  assert.ok(fake.tools().has("orchestra_browser"))
  const manager = new EndpointManager(path.join(directory, "profile"), config)
  await host.connect("playwright", manager, directory)
  assert.equal(fake.configs().size, 1)
  const info = fake.tools().get("orchestra_browser_playwright_browser_snapshot")!
  assert.equal(info.options?.codemode, false)
  const ctx = { sessionID: "forged" as ToolContext["sessionID"], agent: "orch-repo" as ToolContext["agent"], messageID: "message" as ToolContext["messageID"], id: "call" as ToolContext["id"], signal: new AbortController().signal, progress: async () => undefined }
  await assert.rejects(info.execute({}, ctx), /browser_lease_required/)
  await host.connect("devtools", manager, directory)
  assert.equal(fake.configs().size, 2)
  await assert.rejects(fake.tools().get("orchestra_browser_devtools_take_snapshot")!.execute({}, ctx), /browser_lease_required/)
  await host.disconnect()
  assert.equal(fake.configs().size, 0)
})
test("native bridge detects user MCPs under arbitrary names and never rewires or duplicates them", async () => {
  const user = new Mcp.LocalConfig({ type: "local", command: ["node", "/custom/@playwright/mcp/cli.js", "--user-data-dir", "/custom/account"], disabled: true })
  const fake = harness([["custom-account", user]])
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-user-browser-"))
  const config = browserConfigSchema.parse({ mode: "auto" })
  const host = new NativeBrowserHost(fake.ctx)
  new BrowserRuntime(config, directory, new OrchestrationRunState({ maxWorkers: 4, parallelWorkers: 2, maxDelegationDepth: 2 }), host, undefined, directory)
  await host.install()
  assert.equal(host.available().playwright, false)
  const preserved = fake.configs().get("custom-account")
  assert.ok(preserved?.type === "local")
  assert.deepEqual(preserved.command, user.command)
  await assert.rejects(host.connect("playwright", new EndpointManager(directory, config), directory), /browser_user_mcp_conflict/)
  assert.equal(fake.configs().size, 1)
})
test("installer scaffolds auto only for new config, preserves user MCPs and config, and honors no-playwright", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-browser-install-"))
  const options = { configDirectory: directory, context7: false, github: false, codebaseMemory: false, memoryGraph: false, git: false, astGrep: false, superpowers: false, voice: false, provisionDependencies: false, force: false, dryRun: false, pluginCacheDirectory: path.join(directory, "packages") }
  const custom = { type: "local", command: ["custom", "--profile", "personal"], environment: { SECRET: "user-owned" } }
  await writeFile(path.join(directory, "opencode.json"), JSON.stringify({ mcp: { playwright: custom } }))
  await install(options)
  assert.equal(JSON.parse(await readFile(path.join(directory, "orchestra.jsonc"), "utf8")).browser.mode, "auto")
  const main = JSON.parse(await readFile(path.join(directory, "opencode.json"), "utf8"))
  assert.deepEqual(main.mcp.playwright, custom)
  assert.equal(Object.keys(main.mcp).length, 1)
  await writeFile(path.join(directory, "orchestra.jsonc"), "{\n // user config\n \"budget\": \"eco\"\n}\n")
  await install({ ...options, browserMode: "devtools", force: true })
  assert.equal(await readFile(path.join(directory, "orchestra.jsonc"), "utf8"), "{\n // user config\n \"budget\": \"eco\"\n}\n")
  const disabled = await mkdtemp(path.join(os.tmpdir(), "orchestra-no-playwright-"))
  await install({ ...options, configDirectory: disabled, playwright: false })
  assert.equal(JSON.parse(await readFile(path.join(disabled, "orchestra.jsonc"), "utf8")).browser.mode, "off")
})
