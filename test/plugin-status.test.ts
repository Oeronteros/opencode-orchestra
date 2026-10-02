import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { formatPluginStatus, type PluginStatus } from "../src/plugin-status.js"
import { OrchestraPlugin } from "../src/index.js"
import { configuredMcpStatuses, dashboardMcpStatuses, mcpEntries, persistMcpStatuses, statusesFromEntries } from "../src/mcp/status.js"
import { writeFile } from "node:fs/promises"

test("MCP status includes GitHub, custom servers, BOM and project overrides", async () => {
  assert.deepEqual(Object.keys(mcpEntries({ mcp: { timeout: 5_000, servers: { github: {} } } })), ["github"])
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-mcp-status-"))
  const project = await mkdtemp(path.join(os.tmpdir(), "orchestra-mcp-project-"))
  try {
    await writeFile(path.join(directory, "opencode.json"), '\ufeff' + JSON.stringify({ mcp: { github: { type: "remote" }, custom: { type: "local" }, git: { enabled: true } } }))
    await writeFile(path.join(project, "opencode.jsonc"), JSON.stringify({ mcp: { servers: { git: { disabled: true } } } }))
    const statuses = await configuredMcpStatuses(directory, project)
    assert.equal(statuses.github?.state, "unverified")
    assert.equal(statuses.custom?.state, "unverified")
    assert.equal(statuses.git?.state, "disabled")
    assert.equal(statuses.context7?.state, "missing")
    const file = path.join(project, "mcp-status.json")
    const runtime = statusesFromEntries(mcpEntries({ mcp: { github: {} } }), { github: { status: "needs_auth", error: "secret" }, custom: { status: "failed" } })
    await persistMcpStatuses(file, runtime)
    assert.equal((await dashboardMcpStatuses(directory, project, file)).github?.state, "needs_auth")
    assert.equal((await dashboardMcpStatuses(directory, project, file)).custom?.state, "failed")
    await writeFile(file, JSON.stringify({ updatedAt: Date.now() - 60_000, statuses: runtime }))
    assert.equal((await dashboardMcpStatuses(directory, project, file)).github?.state, "unverified")
  } finally {
    await rm(directory, { recursive: true, force: true })
    await rm(project, { recursive: true, force: true })
  }
})

const testConfigDirectory = await mkdtemp(path.join(os.tmpdir(), "orchestra-test-config-"))
process.env.OPENCODE_CONFIG_DIR = testConfigDirectory
test.after(async () => { await rm(testConfigDirectory, { recursive: true, force: true }) })

test("formatPluginStatus renders the plugin identity and runtime fields", async () => {
  const report = await formatPluginStatus({
    name: "@oeronteros-1/opencode-orchestra",
    version: "0.5.3",
    budget: "balanced",
    modelStrategy: "auto",
    configuredModels: 12,
    discoveredModels: 9,
    configSource: "/tmp/orchestra.jsonc",
    mcp: { context7: true, codebaseMemory: false, memoryGraph: true, supermemory: false },
  })

  assert.ok(report.includes("OpenCode Orchestra plugin status"))
  assert.ok(report.includes("plugin: @oeronteros-1/opencode-orchestra@0.5.3"))
  assert.ok(report.includes("budget: balanced"))
  assert.ok(report.includes("model strategy: auto"))
  assert.ok(report.includes("configured models: 12"))
  assert.ok(report.includes("discovered models: 9"))
  assert.ok(report.includes("config source: /tmp/orchestra.jsonc"))
  assert.ok(report.includes("context7"))
  assert.ok(report.includes("configured"))
})

test("detectMcpPresence maps git and ast-grep keys", async () => {
  const { detectMcpPresence } = await import("../src/plugin-status.js")
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-mcp-presence-"))
  const { writeFile } = await import("node:fs/promises")
  await writeFile(
    path.join(directory, "opencode.json"),
    JSON.stringify({ mcp: { git: { type: "local", command: ["uvx", "mcp-server-git"] }, "ast-grep": { type: "local", command: ["uvx"], enabled: false } } }),
    "utf8",
  )
  const presence = await detectMcpPresence(directory)
  assert.equal(presence.git, true)
  assert.equal(presence.astGrep, false)
  assert.equal(presence.context7, false)
})

test("detectMcpPresence reads native V2 MCP servers and disabled flags", async () => {
  const { detectMcpPresence } = await import("../src/plugin-status.js")
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-v2-mcp-presence-"))
  const { writeFile } = await import("node:fs/promises")
  await writeFile(path.join(directory, "opencode.json"), JSON.stringify({
    mcp: { servers: { git: { type: "local", command: ["uvx", "mcp-server-git"] }, "ast-grep": { type: "local", command: ["uvx"], disabled: true } } },
  }))
  const presence = await detectMcpPresence(directory)
  assert.equal(presence.git, true)
  assert.equal(presence.astGrep, false)
})

test("plugin exposes the /plugin-status command and orchestra_plugin_status tool", async () => {
  const initialize = OrchestraPlugin as unknown as (
    input: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
  // Isolate from any local .opencode/orchestra.jsonc so ambient config
  // (e.g. budget/model strategy) cannot change the reported status.
  const project = await mkdtemp(path.join(os.tmpdir(), "orchestra-plugin-status-"))
  let githubState = "needs_auth"
  const hooks = await initialize(
    {
      directory: project,
      client: {
        app: { log: async () => undefined },
        config: { get: async () => ({ data: { mcp: { github: { type: "remote" } } } }) },
        mcp: { status: async () => ({ data: { github: { status: githubState } } }) },
      },
    },
    { telemetry: { enabled: false } },
  )

  const runtime: Record<string, unknown> = {}
  const configure = hooks.config as (input: Record<string, unknown>) => Promise<void>
  await configure(runtime)

  const command = (runtime.command as Record<string, { template: string }>)["plugin-status"]
  const tool = (hooks.tool as Record<string, unknown>).orchestra_plugin_status

  assert.ok(command, "plugin-status command should be registered")
  assert.ok(command.template.includes("orchestra_plugin_status"))
  assert.ok(tool, "orchestra_plugin_status tool should be registered")

  const execute = (tool as { execute: () => Promise<string> }).execute
  const report = await execute()
  assert.ok(report.includes("OpenCode Orchestra plugin status"))
  assert.ok(report.includes("plugin: @oeronteros-1/opencode-orchestra@"))
  assert.ok(report.includes("budget:"))
  assert.match(report, /github\s+needs_auth/)
  githubState = "connected"
  assert.match(await execute(), /github\s+connected/)
  assert.equal((await dashboardMcpStatuses(testConfigDirectory, project, path.join(project, ".orchestra", "mcp-status.json"))).github?.state, "connected")
  await (hooks.dispose as () => Promise<void>)()
})
