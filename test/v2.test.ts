import assert from "node:assert/strict"
import test from "node:test"
import { z } from "zod"
import type { Plugin as LegacyPlugin } from "@opencode-ai/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { setupV2 } from "../src/v2.js"

function eventContext(context: () => Promise<unknown[]>, subscribe: (signal: AbortSignal) => AsyncIterable<unknown>): Context {
  const domain = () => ({ transform: async (edit: (editor: Record<string, unknown>) => void) => edit({}), hook: async () => undefined })
  return {
    location: { directory: process.cwd() }, options: {}, agent: domain(), command: domain(), tool: domain(), permission: domain(),
    model: { list: async () => ({ data: [] }) }, session: { ...domain(), context },
    event: { subscribe: ({ signal }: { signal: AbortSignal }) => subscribe(signal) },
  } as unknown as Context
}

function answer(id: string, created: number, finished = true) {
  return { id, type: "assistant", agent: "orch-lead", model: { providerID: "mock", id: "model" }, content: [],
    time: { created, ...(finished ? { completed: created + 1 } : {}) }, ...(finished ? { finish: "stop" } : {}) }
}

async function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
}

for (const failure of ["disconnect", "end"] as const) {
  test(`V2 reconnects after stream ${failure} and reconciles only finalized messages`, { timeout: 3000 }, async () => {
    let subscriptions = 0
    let history: unknown[] = [answer("first", 1)]
    const finals: string[] = []
    let notify!: () => void
    const recovered = new Promise<void>((resolve) => { notify = resolve })
    const ctx = eventContext(async () => subscriptions === 1 ? [answer("first", 1)] : history, (signal) => ({ async *[Symbol.asyncIterator]() {
      subscriptions++
      if (subscriptions === 1) {
        yield { type: "session.idle", data: { sessionID: "session" } }
        history = [answer("first", 1), answer("second", 2), answer("unfinished", 3, false)]
        if (failure === "disconnect") throw new Error("transport disconnected")
        return
      }
      await untilAborted(signal)
    } }))
    const cleanup = await setupV2(ctx, (async () => ({ event: async ({ event }: any) => {
      if (event.type === "message.updated") {
        finals.push(event.properties.info.id)
        if (event.properties.info.id === "second") notify()
      }
    } })) as LegacyPlugin, { baseDelayMs: 5, maxDelayMs: 10 })
    try {
      await recovered
      assert.equal(subscriptions, 2)
      assert.deepEqual(finals, ["first", "second"])
    } finally { await cleanup() }
  })
}

test("V2 restores a missed idle event from the session history", { timeout: 3000 }, async () => {
  let subscriptions = 0
  const events: string[] = []
  let notify!: () => void
  const restored = new Promise<void>((resolve) => { notify = resolve })
  const ctx = eventContext(async () => [answer("done", 1), { id: "idle", type: "idle", outcome: "succeeded", time: { created: 3 } }],
    (signal) => ({ async *[Symbol.asyncIterator]() {
      subscriptions++
      if (subscriptions === 1) {
        yield { type: "session.text.delta", data: { sessionID: "session", assistantMessageID: "done", ordinal: 0, delta: "hello" } }
        throw new Error("lost idle event")
      }
      await untilAborted(signal)
    } }))
  const cleanup = await setupV2(ctx, (async () => ({ event: async ({ event }: any) => {
    events.push(event.type)
    if (event.type === "session.idle") notify()
  } })) as LegacyPlugin, { baseDelayMs: 5 })
  try { await restored; assert.deepEqual(events, ["message.part.delta", "message.updated", "session.idle"]) }
  finally { await cleanup() }
})

test("V2 deduplication survives histories longer than 2048 responses", { timeout: 3000 }, async () => {
  let finals = 0
  let idles = 0
  let notify!: () => void
  const processed = new Promise<void>((resolve) => { notify = resolve })
  const history = Array.from({ length: 2050 }, (_, i) => answer(`answer-${i}`, i))
  const ctx = eventContext(async () => history, (signal) => ({ async *[Symbol.asyncIterator]() {
    yield { type: "session.idle", data: { sessionID: "session" } }
    yield { type: "session.idle", data: { sessionID: "session" } }
    await untilAborted(signal)
  } }))
  const cleanup = await setupV2(ctx, (async () => ({ event: async ({ event }: any) => {
    if (event.type === "message.updated") finals++
    if (event.type === "session.idle" && ++idles === 2) notify()
  } })) as LegacyPlugin)
  try { await processed; assert.equal(finals, 2050) }
  finally { await cleanup() }
})

test("V2 disposal cancels reconnect backoff immediately", { timeout: 3000 }, async () => {
  let notify!: () => void
  const failed = new Promise<void>((resolve) => { notify = resolve })
  let subscriptions = 0
  const ctx = eventContext(async () => [], () => ({ async *[Symbol.asyncIterator]() { subscriptions++; notify(); throw new Error("offline") } }))
  const cleanup = await setupV2(ctx, (async () => ({})) as LegacyPlugin, { baseDelayMs: 30_000 })
  await failed
  await cleanup()
  assert.equal(subscriptions, 1)
})

test("V2 reconciles a transport reconnect announced within the same subscription", { timeout: 3000 }, async () => {
  let notify!: () => void
  const recovered = new Promise<void>((resolve) => { notify = resolve })
  let contextReads = 0
  const ctx = eventContext(async () => { contextReads++; return [answer("missed", 1)] }, (signal) => ({ async *[Symbol.asyncIterator]() {
    yield { type: "server.connected", data: {} }
    yield { type: "session.text.delta", data: { sessionID: "session", assistantMessageID: "missed", ordinal: 0, delta: "hello" } }
    yield { type: "server.connected", data: {} }
    await untilAborted(signal)
  } }))
  const cleanup = await setupV2(ctx, (async () => ({ event: async ({ event }: any) => {
    if (event.type === "message.updated") notify()
  } })) as LegacyPlugin)
  try { await recovered; assert.equal(contextReads, 1) }
  finally { await cleanup() }
})

test("V2 accounts for older responses that finalize after newer ones", { timeout: 3000 }, async () => {
  const finals: string[] = []
  let reads = 0
  let idles = 0
  let notify!: () => void
  const processed = new Promise<void>((resolve) => { notify = resolve })
  const ctx = eventContext(async () => [answer("older", 1, ++reads > 1), answer("newer", 2)], (signal) => ({ async *[Symbol.asyncIterator]() {
    yield { type: "session.idle", data: { sessionID: "session" } }
    yield { type: "session.idle", data: { sessionID: "session" } }
    await untilAborted(signal)
  } }))
  const cleanup = await setupV2(ctx, (async () => ({ event: async ({ event }: any) => {
    if (event.type === "message.updated") finals.push(event.properties.info.id)
    if (event.type === "session.idle" && ++idles === 2) notify()
  } })) as LegacyPlugin)
  try { await processed; assert.deepEqual(finals, ["newer", "older"]) }
  finally { await cleanup() }
})

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
    mcp: { list: async () => ({ data: [{ name: "github", status: { status: "needs_auth" } }] }) },
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
  assert.deepEqual(await legacyClient.mcp.status(), { data: { github: { status: "needs_auth" } } })
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
