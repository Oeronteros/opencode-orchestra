import assert from "node:assert/strict"
import test from "node:test"
import pluginModule, { OrchestraPlugin, server } from "../src/index.js"

test("entrypoint exposes a stable id and server", () => {
  assert.equal(pluginModule.id, "opencode-orchestra")
  assert.equal(pluginModule.server, OrchestraPlugin)
  assert.equal(server, OrchestraPlugin)
})

test("plugin initializes and injects additive agents, tools, and commands", async () => {
  const initialize = OrchestraPlugin as unknown as (
    input: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
  const hooks = await initialize(
    {
      directory: process.cwd(),
      client: {
        app: {
          log: async () => undefined,
        },
      },
    },
    { telemetry: { enabled: false } },
  )

  const runtime: Record<string, unknown> = {}
  const configure = hooks.config as (input: Record<string, unknown>) => Promise<void>
  await configure(runtime)

  const agents = runtime.agent as Record<string, { mode: string }>
  const commands = runtime.command as Record<string, { template: string }>
  const tools = hooks.tool as Record<string, unknown>

  assert.equal(agents["orch-lead"]?.mode, "primary")
  assert.equal(agents["orch-repo"]?.mode, "subagent")
  assert.equal((commands.orchestra as { agent?: string })?.agent, "orch-lead")
  assert.ok(commands.orchestra?.template.includes("execute the returned plan yourself"))
  assert.ok(commands["orchestra-status"]?.template.includes("orchestra_status"))
  assert.ok(commands["plugin-status"]?.template.includes("orchestra_plugin_status"))
  assert.ok(tools.orchestra_route)
  assert.ok(tools.orchestra_status)
  assert.ok(tools.orchestra_plugin_status)
  assert.equal("experimental.chat.system.transform" in hooks, false)
})

test("ebobo routes the full worker roster with frontier arbitration", async () => {
  const initialize = OrchestraPlugin as unknown as (
    input: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
  const hooks = await initialize(
    {
      directory: process.cwd(),
      client: { app: { log: async () => undefined } },
    },
    { budget: "ebobo", telemetry: { enabled: false } },
  )
  const route = (hooks.tool as Record<string, unknown>).orchestra_route as {
    execute: (args: { task: string }, context: Record<string, unknown>) => Promise<string>
  }
  const result = JSON.parse(await route.execute({ task: "Design and verify a cross-platform auth system" }, {})) as {
    workers: string[]
    parallelWorkers: number
    escalation: { escalate: boolean }
  }

  assert.equal(result.workers.length, 9)
  assert.equal(result.parallelWorkers, 8)
  assert.equal(result.escalation.escalate, true)
})
