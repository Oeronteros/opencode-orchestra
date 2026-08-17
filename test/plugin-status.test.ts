import assert from "node:assert/strict"
import test from "node:test"
import { formatPluginStatus, type PluginStatus } from "../src/plugin-status.js"
import { OrchestraPlugin } from "../src/index.js"

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
  assert.ok(report.includes("connected"))
})

test("plugin exposes the /plugin-status command and orchestra_plugin_status tool", async () => {
  const initialize = OrchestraPlugin as unknown as (
    input: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
  const hooks = await initialize(
    {
      directory: process.cwd(),
      client: { app: { log: async () => undefined } },
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
})
