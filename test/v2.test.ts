import assert from "node:assert/strict"
import test from "node:test"
import { z } from "zod"
import type { Plugin as LegacyPlugin } from "@opencode-ai/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { setupV2 } from "../src/v2.js"

test("V2 setup registers legacy behavior on the new domains and adapts tool execution", async () => {
  const registrations: Record<string, (event: any) => Promise<void> | void> = {}
  const commands: Array<{ name: string; execute: (input: any) => Promise<void> }> = []
  const tools: Array<{ name: string; execute: (input: any, context: any) => Promise<any> }> = []
  const agents = new Map<string, Record<string, any>>([["orch-lead", {
    description: undefined,
    system: undefined,
    mode: "primary",
    hidden: false,
    permissions: [],
  }]])
  const prompted: string[] = []
  const selectedModels: string[] = []
  const events: string[] = []
  let permissionCalls = 0
  let legacyClient: any
  let disposed = false
  const domain = (name: string) => ({
    transform: async (callback: (editor: any) => void) => {
      if (name === "agent") callback({ get: (id: string) => agents.get(id), update: (id: string, edit: (draft: any) => void) => edit(agents.get(id)) })
      if (name === "command") callback({ add: (value: any) => commands.push(value) })
      if (name === "tool") callback({ add: (value: any) => tools.push(value) })
      return { dispose: async () => undefined }
    },
    hook: async (key: string, callback: (event: any) => Promise<void> | void) => {
      registrations[`${name}.${key}`] = callback
      return { dispose: async () => undefined }
    },
  })
  const ctx = {
    location: { directory: process.cwd() },
    options: {},
    agent: domain("agent"),
    command: domain("command"),
    tool: { ...domain("tool") },
    permission: domain("permission"),
    model: { list: async () => ({ data: [] }) },
    session: {
      ...domain("session"),
      get: async () => ({ location: { directory: process.cwd() } }),
      prompt: async (input: { text: string }) => { prompted.push(input.text) },
      switchAgent: async () => undefined,
      switchModel: async (input: { model: { id: string } }) => { selectedModels.push(input.model.id) },
      create: async () => ({ id: "child", location: { directory: process.cwd() } }),
      wait: async () => undefined,
      context: async () => [
        { id: "user", type: "user" },
        { id: `reply-${prompted.length}`, type: "assistant", agent: "orch-lead", model: { providerID: "mock", id: "reasoner" }, content: [{ type: "text", text: "done" }], time: { created: 1, completed: 2 }, finish: "stop", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
      ],
    },
    event: { subscribe: ({ signal }: { signal: AbortSignal }) => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "session.text.delta", data: { sessionID: "session", assistantMessageID: "reply", ordinal: 0, delta: "hello" } }
        yield { type: "session.idle", data: { sessionID: "session" } }
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
      },
    }) },
  } as unknown as Context
  const initialize = (async (input: { client: unknown }) => {
    legacyClient = input.client
    return {
    config: async (config: any) => {
      config.agent = { "orch-lead": { description: "lead", prompt: "Guide the work", mode: "primary", hidden: false, permission: { bash: { "git status*": "allow" }, task: "deny" } } }
      config.command = { orchestra: { template: "Route $ARGUMENTS", agent: "orch-lead" } }
    },
    tool: { orchestra_test: { description: "Test", args: { text: z.string() }, execute: async (input: { text: string }, context: { directory: string }) => `${input.text}:${context.directory}` } },
    event: async ({ event }: { event: { type: string } }) => { events.push(event.type) },
    "permission.ask": async (_input: unknown, output: { status: string }) => { permissionCalls++; output.status = "allow" },
    dispose: async () => { disposed = true },
    }
  }) as unknown as LegacyPlugin

  const cleanup = await setupV2(ctx, initialize)
  assert.equal(agents.get("orch-lead")?.system, "Guide the work")
  assert.deepEqual(agents.get("orch-lead")?.permissions, [
    { action: "shell", resource: "git status*", effect: "allow" },
    { action: "subagent", resource: "*", effect: "deny" },
  ])
  assert.equal(commands[0]?.name, "orchestra")
  await commands[0]!.execute({ sessionID: "session", prompt: { text: "task" }, delivery: "steer" })
  assert.deepEqual(prompted, ["Route task"])
  assert.equal(tools[0]?.name, "orchestra_test")
  assert.deepEqual(await tools[0]!.execute({ text: "hello" }, { sessionID: "session", messageID: "message", agent: "orch-lead", signal: new AbortController().signal }), { content: `hello:${process.cwd()}` })
  const child = await legacyClient.session.create({ body: { parentID: "parent", title: "Work" }, query: { directory: process.cwd() } })
  assert.equal(child.data.id, "child")
  const reply = await legacyClient.session.prompt({ path: { id: "child" }, body: { agent: "orch-lead", model: { providerID: "mock", modelID: "reasoner" }, parts: [{ type: "text", text: "please work" }] } })
  assert.equal(reply.data.parts[0].text, "done")
  assert.deepEqual(selectedModels, ["reasoner"])
  assert.ok(registrations["session.context"])
  assert.ok(registrations["tool.execute.before"])
  assert.ok(registrations["permission.evaluate"])
  const allowed = { sessionID: "session", effect: "allow" }
  await registrations["permission.evaluate"]!(allowed)
  assert.equal(permissionCalls, 0)
  const pending = { sessionID: "session", effect: "ask" }
  await registrations["permission.evaluate"]!(pending)
  assert.equal(permissionCalls, 1)
  assert.equal(pending.effect, "allow")
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(events, ["message.part.delta", "message.updated", "session.idle"])
  await cleanup()
  assert.equal(disposed, true)
})

test("V2 event stream retries an assistant message after a handler failure", async () => {
  let resolveIdle!: () => void
  const idleProcessed = new Promise<void>((resolve) => { resolveIdle = resolve })
  const attempts: string[] = []
  const domain = () => ({
    transform: async (edit: (editor: Record<string, unknown>) => void) => { edit({}) },
    hook: async () => undefined,
  })
  const ctx = {
    location: { directory: process.cwd() },
    options: {},
    agent: domain(),
    command: domain(),
    tool: domain(),
    permission: domain(),
    model: { list: async () => ({ data: [] }) },
    session: {
      ...domain(),
      context: async () => [
        { id: "user", type: "user" },
        { id: "reply", type: "assistant", agent: "orch-lead", model: { providerID: "mock", id: "reasoner" }, content: [{ type: "text", text: "done" }], time: { created: 1, completed: 2 }, finish: "stop", tokens: { input: 1, output: 1, reasoning: 0 } },
      ],
    },
    event: { subscribe: ({ signal }: { signal: AbortSignal }) => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "session.idle", data: { sessionID: "session" } }
        yield { type: "session.idle", data: { sessionID: "session" } }
        if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
      },
    }) },
  } as unknown as Context
  const initialize = (async () => ({
    event: async ({ event }: { event: { type: string } }) => {
      attempts.push(event.type)
      if (event.type === "message.updated" && attempts.filter((type) => type === "message.updated").length === 1) throw new Error("transient ledger failure")
      if (event.type === "session.idle") resolveIdle()
    },
  })) as unknown as LegacyPlugin

  const cleanup = await setupV2(ctx, initialize)
  const timeout = setTimeout(() => resolveIdle(), 1_000)
  try {
    await idleProcessed
    assert.deepEqual(attempts, ["message.updated", "message.updated", "session.idle"])
  } finally {
    clearTimeout(timeout)
    await cleanup()
  }
})
