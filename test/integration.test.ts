import assert from "node:assert/strict"
import test from "node:test"
import { OrchestraPlugin } from "../src/index.js"

/**
 * End-to-end integration test that drives the full plugin pipeline with a
 * mock provider catalog. This is a "real run" in the sense that it exercises
 * the same entry point OpenCode invokes — `OrchestraPlugin` — rather than
 * individual pure functions. Only the network boundary (`client.provider.list`
 * and app logging) is stubbed.
 */

interface DiscoveredRunResult {
  agents: Record<string, { model?: string; mode: string }>
  commands: Record<string, { template: string }>
  tools: Record<string, unknown>
  service: Array<{ level: string; message: string; extra: Record<string, unknown> }>
}

/** Build a mock provider catalog that yields one reasoning model and one code model. */
const MOCK_CATALOG = {
  data: {
    connected: ["mockvendor"],
    all: [
      {
        id: "mockvendor",
        models: {
          "reasoner-pro": {
            id: "reasoner-pro",
            reasoning: true,
            tool_call: true,
            cost: { input: 2, output: 4 },
            limit: { context: 250_000, output: 64_000 },
            modalities: { input: ["text"], output: ["text"] },
          },
          "reasoner-lite": {
            id: "reasoner-lite",
            reasoning: true,
            tool_call: true,
            cost: { input: 0, output: 0 },
            limit: { context: 128_000, output: 32_000 },
            modalities: { input: ["text"], output: ["text"] },
          },
          "coder-lite": {
            id: "coder-lite",
            reasoning: false,
            tool_call: true,
            cost: { input: 0, output: 0 },
            limit: { context: 64_000, output: 16_000 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
      { id: "offline-vendor", models: { "never": { id: "never" } } },
    ],
  },
}

async function initializePlugin(
  client: Record<string, unknown>,
  options: Record<string, unknown> = {},
) {
  const initialize = OrchestraPlugin as unknown as (
    input: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
  return initialize({ directory: process.cwd(), client }, options)
}

function mockClient(logs: Array<{ level: string; message: string; extra: Record<string, unknown> }>) {
  return {
    app: {
      log: async (input: { body: { level: string; message: string; extra: Record<string, unknown> } }) => {
        logs.push(input.body)
        return undefined
      },
    },
    provider: { list: async () => MOCK_CATALOG },
  }
}

test("full plugin run discovers mock provider models and assigns them to agents", async () => {
  const logs: Array<{ level: string; message: string; extra: Record<string, unknown> }> = []
  const hooks = await initializePlugin(mockClient(logs), { telemetry: { enabled: false } })

  const runtime: Record<string, unknown> = {}
  await (hooks.config as (input: Record<string, unknown>) => Promise<void>)(runtime)

  // Assert the init log carried the discovered-model count, proving the API
  // call actually happened (not just a static fallback). If `provider.list`
  // were dropped, `discoveredModels` would be 0.
  const init = logs.find((entry) => entry.message === "OpenCode Orchestra initialized")
  assert.ok(init, "expected the plugin to emit an initialization log")
  assert.equal(init.extra.discoveredModels, 3, "three connected models should be discovered")

  const agents = runtime.agent as Record<string, { model?: string; mode: string }>
  assert.equal(agents["orch-lead"]?.mode, "primary")
  // Auto strategy + empty manual pools should be filled from discovery.
  assert.ok(agents["orch-lead"]?.model?.startsWith("mockvendor/"), "lead should resolve to a discovered mock model")
  assert.ok(agents["orch-repo"]?.model?.startsWith("mockvendor/"), "code worker should resolve to a discovered mock model")

  const commands = runtime.command as Record<string, { template: string }>
  assert.ok(commands["orchestra-status"]?.template.includes("orchestra_status"))

  const tools = hooks.tool as Record<string, unknown>
  assert.ok(tools.orchestra_route, "orchestra_route tool should be registered")
})

test("manual strategy keeps explicit pools and ignores the mock provider", async () => {
  const logs: Array<{ level: string; message: string; extra: Record<string, unknown> }> = []
  const hooks = await initializePlugin(mockClient(logs), {
    telemetry: { enabled: false },
    models: {
      strategy: "manual",
      lead: ["explicit/lead-model"],
      worker: { code: ["explicit/code-model"] },
    },
  })

  const runtime: Record<string, unknown> = {}
  await (hooks.config as (input: Record<string, unknown>) => Promise<void>)(runtime)

  const agents = runtime.agent as Record<string, { model?: string }>
  assert.equal(agents["orch-lead"]?.model, "explicit/lead-model")
  assert.equal(agents["orch-repo"]?.model, "explicit/code-model")
})

test("route tool runs the full routing pipeline against discovered models", async () => {
  const logs: Array<{ level: string; message: string; extra: Record<string, unknown> }> = []
  const hooks = await initializePlugin(mockClient(logs), {
    budget: "balanced",
    telemetry: { enabled: false },
  })

  const route = (hooks.tool as Record<string, unknown>).orchestra_route as {
    execute: (args: { task: string }, context: Record<string, unknown>) => Promise<string>
  }
  const result = JSON.parse(
    await route.execute({ task: "Fix the intermittent 502 bug in the login flow" }, {}),
  ) as {
    profile: string
    workers: string[]
    parallelWorkers: number
    paidBudget: { enabled: boolean }
    plan: { nodes: Array<{ worker: string }> }
    escalation: { escalate: boolean }
  }

  // Debug signal wins (bug, 502, intermittent bonus), and debug profile workers
  // are orch-repo, orch-tests, orch-critic.
  assert.equal(result.profile, "debug")
  assert.ok(result.workers.includes("orch-repo"))
  assert.ok(result.workers.includes("orch-tests"))
  assert.ok(result.parallelWorkers >= 1)
  // balanced enables a paid-call guard but caps it at one per branch.
  assert.equal(result.paidBudget.enabled, true)
  // A non-critical, high-confidence task should not escalate under balanced.
  assert.equal(result.escalation.escalate, false)
  assert.ok(result.plan.nodes.length > 0)
})
