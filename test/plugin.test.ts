import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import pluginModule, { OrchestraPlugin, server } from "../src/index.js"
import { DEFAULT_CONFIG, withDefaults } from "../src/config/defaults.js"
import { parseLiveSnapshot, type LiveSnapshot } from "../src/telemetry/live.js"
import type { Ledger } from "../src/telemetry/ledger.js"
import { createOrchestraTools } from "../src/tools.js"

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
  assert.ok(tools.orchestration_report)
  assert.equal("experimental.chat.system.transform" in hooks, false)
})

test("plugin falls back to defaults for invalid config JSONC", async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), "orchestra-invalid-config-"))
  const configDirectory = path.join(project, ".opencode")
  const configPath = path.join(configDirectory, "orchestra.jsonc")
  await mkdir(configDirectory)
  await writeFile(configPath, '{ "budget": "free"', "utf8")
  const logs: Array<{ body?: { level?: string; message?: string; extra?: unknown } }> = []
  const initialize = OrchestraPlugin as unknown as (
    input: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>

  const hooks = await initialize(
    {
      directory: project,
      client: { app: { log: async (entry: { body?: { level?: string; message?: string; extra?: unknown } }) => { logs.push(entry) } } },
    },
    { telemetry: { enabled: false } },
  )
  const runtime: Record<string, unknown> = {}
  await (hooks.config as (input: Record<string, unknown>) => Promise<void>)(runtime)

  assert.ok((hooks.tool as Record<string, unknown>).orchestra_route)
  assert.ok((runtime.agent as Record<string, unknown>)["orch-lead"])
  const warnings = logs.filter((entry) => entry.body?.level === "warn" && entry.body.message?.includes("invalid config"))
  assert.equal(warnings.length, 1)
  const warning = warnings[0]
  assert.match(JSON.stringify(warning), new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.equal(await readFile(configPath, "utf8"), '{ "budget": "free"')
  await (hooks.dispose as () => Promise<void>)()
})

test("plugin falls back to defaults for a schema-invalid config", async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), "orchestra-schema-invalid-"))
  const configDirectory = path.join(project, ".opencode")
  const configPath = path.join(configDirectory, "orchestra.jsonc")
  await mkdir(configDirectory)
  await writeFile(configPath, '{ "budget": "not-a-budget" }', "utf8")
  const logs: Array<{ body?: { level?: string; message?: string; extra?: unknown } }> = []
  const initialize = OrchestraPlugin as unknown as (
    input: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>

  const hooks = await initialize(
    {
      directory: project,
      client: { app: { log: async (entry: { body?: { level?: string; message?: string; extra?: unknown } }) => { logs.push(entry) } } },
    },
    { telemetry: { enabled: false } },
  )

  assert.ok((hooks.tool as Record<string, unknown>).orchestra_route)
  const warnings = logs.filter((entry) => entry.body?.level === "warn" && entry.body.message?.includes("invalid config"))
  assert.equal(warnings.length, 1)
  const warning = warnings[0]
  assert.match(JSON.stringify(warning), new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.doesNotMatch(JSON.stringify(warning), /not-a-budget/)
  assert.equal(await readFile(configPath, "utf8"), '{ "budget": "not-a-budget" }')
  await (hooks.dispose as () => Promise<void>)()
})

test("consensus report requires and updates the current session", async () => {
  const initialize = OrchestraPlugin as unknown as (input: Record<string, unknown>, options: Record<string, unknown>) => Promise<Record<string, unknown>>
  const hooks = await initialize({ directory: process.cwd(), client: { app: { log: async () => undefined } } }, { telemetry: { enabled: true, directory: ".orchestra-test-report" } })
  const report = (hooks.tool as Record<string, { execute: (args: Record<string, unknown>, context: Record<string, unknown>) => Promise<string> }>).orchestration_report!
  assert.equal(JSON.parse(await report.execute({ consensus: 0.2 }, {})).ok, false)
  assert.equal(JSON.parse(await report.execute({ consensus: 0.2, uncertainty: 0.4 }, { sessionID: "report-session" })).ok, true)
  const route = (hooks.tool as Record<string, { execute: (args: { task: string }, context: Record<string, unknown>) => Promise<string> }>).orchestra_route!
  const result = JSON.parse(await route.execute({ task: "implement a module" }, { sessionID: "report-session" })) as { escalation: { reason: string } }
  assert.equal(result.escalation.reason, "worker disagreement")
  await (hooks.dispose as () => Promise<void>)()
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

test("orchestra route works without a session or ledger access", async () => {
  const ledger = new Proxy({}, {
    get(_target, property) {
      throw new Error(`unexpected ledger access: ${String(property)}`)
    },
  }) as Ledger
  const route = createOrchestraTools(DEFAULT_CONFIG, ledger).orchestra_route as unknown as {
    execute: (args: { task: string }, context: Record<string, unknown>) => Promise<string>
  }

  const result = JSON.parse(await route.execute({ task: "implement a module" }, {})) as {
    plan?: { nodes?: unknown[] }
    paidBudget?: { paidCallsUsed?: number; sessionAccountingAvailable?: boolean }
  }

  assert.ok(result.plan?.nodes?.length)
  assert.equal(result.paidBudget?.paidCallsUsed, 0)
  assert.equal(result.paidBudget?.sessionAccountingAvailable, false)
})

test("orchestra route surfaces the lead routing reason and preserves existing fields", async () => {
  const config = withDefaults({
    budget: "balanced",
    models: {
      strategy: "auto",
      lead: [
        { id: "vendor/free-lead", cost: "free", tier: "lead", priority: 70, capabilities: ["reasoning"], scores: { reasoning: 8 } },
      ],
    },
  })
  const ledger = {
    getSession: async () => undefined,
    setProfile: async () => undefined,
  } as unknown as Ledger
  const route = createOrchestraTools(config, ledger).orchestra_route as unknown as {
    execute: (args: { task: string }, context: Record<string, unknown>) => Promise<string>
  }

  const result = JSON.parse(await route.execute({ task: "design a module" }, {})) as {
    routing: { lead: { model: string; reason: { code: string; text: string; matchedCapabilities: string[]; score: number; budget: string } }; source: string }
    workers: string[]
    fallback: { enabled: boolean; maxRetries: number; chains: Record<string, string[]> }
    escalation: { reason: string }
    paidBudget: Record<string, unknown>
    plan: { nodes: unknown[] }
    next: string
  }

  assert.equal(result.routing.lead.model, "vendor/free-lead")
  assert.equal(result.routing.lead.reason.code, "preferred_tier")
  assert.deepEqual(result.routing.lead.reason.matchedCapabilities, ["reasoning"])
  assert.equal(result.routing.lead.reason.budget, "balanced")
  assert.equal(result.routing.source, "auto_discovered")
  assert.ok(result.workers.length)
  assert.ok(result.plan.nodes.length)
  assert.ok(result.fallback.enabled)
  assert.ok(result.escalation.reason)
  assert.ok(result.next.length)
})

test("orchestra route returns a readable error when session ledger lookup fails", async () => {
  const ledger = {
    getSession: async () => { throw new Error("database credentials leaked") },
  } as unknown as Ledger
  const route = createOrchestraTools(DEFAULT_CONFIG, ledger).orchestra_route as unknown as {
    execute: (args: { task: string }, context: Record<string, unknown>) => Promise<string>
  }

  const result = JSON.parse(await route.execute(
    { task: "implement a module" },
    { sessionID: "broken-session" },
  )) as { ok?: boolean; error?: string }

  assert.deepEqual(result, {
    ok: false,
    error: "Unable to route task because session ledger access failed.",
  })
  assert.doesNotMatch(result.error ?? "", /credentials|database/i)
})

test("orchestra route returns the stable error when session profile update fails", async () => {
  const ledger = {
    getSession: async () => undefined,
    setProfile: async () => { throw new Error("profile storage credentials leaked") },
  } as unknown as Ledger
  const route = createOrchestraTools(DEFAULT_CONFIG, ledger).orchestra_route as unknown as {
    execute: (args: { task: string }, context: Record<string, unknown>) => Promise<string>
  }

  const result = JSON.parse(await route.execute(
    { task: "implement a module" },
    { sessionID: "write-failure-session" },
  )) as { ok?: boolean; error?: string }

  assert.deepEqual(result, {
    ok: false,
    error: "Unable to route task because session ledger access failed.",
  })
  assert.doesNotMatch(result.error ?? "", /credentials|storage|profile/i)
})

test("event hook feeds the live stream from message.part.delta without double counting", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-live-hook-"))
  const project = path.join(root, "project")
  const initialize = OrchestraPlugin as unknown as (
    input: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
  const hooks = await initialize(
    {
      directory: project,
      client: { app: { log: async () => undefined } },
    },
    { telemetry: { enabled: true, storeTexts: true } },
  )
  const emit = hooks.event as (input: { event: unknown }) => Promise<void>
  const file = path.join(project, ".orchestra", "live.ndjson")
  const readSnapshot = async (): Promise<LiveSnapshot> => parseLiveSnapshot(await readFile(file, "utf8"))
  const waitFor = async (predicate: (snapshot: LiveSnapshot) => boolean): Promise<LiveSnapshot> => {
    for (let i = 0; i < 120; i++) {
      try {
        const snapshot = await readSnapshot()
        if (predicate(snapshot)) return snapshot
      } catch {
        // Snapshot not flushed yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return readSnapshot()
  }

  // Attribute agent/model like chat.params would for a real stream.
  const chatParams = hooks["chat.params"] as (input: {
    sessionID: string
    agent?: string
    model?: { providerID: string; modelID?: string }
  }) => Promise<void>
  await chatParams({ sessionID: "s1", agent: "orch-repo", model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" } })
  // A text part announces itself (empty text at start), then chunks stream in.
  await emit({
    event: {
      type: "message.part.updated",
      properties: { sessionID: "s1", part: { id: "p1", sessionID: "s1", messageID: "msg-1", type: "text", text: "" } },
    },
  })
  await emit({
    event: {
      type: "message.part.delta",
      properties: { sessionID: "s1", messageID: "msg-1", partID: "p1", field: "text", delta: "Hello world, a live answer while it streams." },
    },
  })
  const live = await waitFor((snapshot) => snapshot.active.length === 1 && snapshot.active[0]!.tokens.output > 0)
  assert.equal(live.active[0]?.agent, "orch-repo")
  assert.equal(live.active[0]?.model, "deepseek-v4-flash-free")
  assert.equal(live.active[0]?.tokens.output, 11)
  assert.ok(live.recent.some((event) => event.e === "delta" && event.text === "Hello world, a live answer while it streams."))

  // Reasoning deltas (same field "text", different part id) are routed to the
  // reasoning estimate and never pollute the output counter.
  await emit({
    event: {
      type: "message.part.updated",
      properties: { sessionID: "s1", part: { id: "p2", sessionID: "s1", messageID: "msg-1", type: "reasoning", text: "tracing" } },
    },
  })
  await emit({
    event: {
      type: "message.part.delta",
      properties: { sessionID: "s1", messageID: "msg-1", partID: "p2", field: "text", delta: "thinking hard about the issue" },
    },
  })
  const reasoning = await waitFor((snapshot) => (snapshot.active[0]?.tokens.reasoning ?? 0) > 0)
  assert.equal(reasoning.active[0]?.tokens.output, 11)
  assert.equal(reasoning.active[0]?.tokens.reasoning, 9)

  // A cumulative part.updated with the same content must not re-add text.
  const before = await readSnapshot()
  await emit({
    event: {
      type: "message.part.updated",
      properties: {
        sessionID: "s1",
        part: { id: "p1", sessionID: "s1", messageID: "msg-1", type: "text", text: "Hello world, a live answer while it streams." },
      },
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 200))
  const after = await readSnapshot()
  assert.equal(after.active[0]?.tokens.output, before.active[0]?.tokens.output)

  // Finish removes the row; a late delta must not resurrect it.
  await emit({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "msg-1",
          sessionID: "s1",
          role: "assistant",
          time: { completed: Date.now() },
          finish: "complete",
          cost: 0.001,
          tokens: { input: 10, output: 10, reasoning: 2 },
        },
      },
    },
  })
  await emit({
    event: {
      type: "message.part.delta",
      properties: { sessionID: "s1", messageID: "msg-1", partID: "p1", field: "text", delta: "zombie text" },
    },
  })
  const ended = await waitFor((snapshot) => snapshot.active.length === 0 && snapshot.seq > 0)
  assert.equal(ended.active.length, 0)
  await (hooks.dispose as () => Promise<void>)()
})
