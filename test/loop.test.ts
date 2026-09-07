import assert from "node:assert/strict"
import test from "node:test"
import { LoopController } from "../src/loop/controller.js"
import { classifyLoopReply, resolveLoopGoal } from "../src/loop/protocol.js"
import { OrchestraPlugin } from "../src/index.js"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("loop protocol only accepts an unquoted final line", () => {
  for (const text of ["DONE: example\nStill working", "> DONE: quoted", "```\nDONE: quoted", "DONE: ", "Question?"]) assert.equal(classifyLoopReply(text).kind, "unknown")
  assert.equal(classifyLoopReply("Tests passed\nDONE: finished").kind, "done")
  assert.equal(classifyLoopReply("MORE: tests remain").kind, "more")
})

test("markdown is explicit, permissioned and rejects traversal", () => {
  assert.equal(resolveLoopGoal("plan.md"), "plan.md")
  assert.match(resolveLoopGoal("--file docs/plan.md"), /permissioned read/)
  for (const goal of ["", "--file ../plan.md", "--file /etc/plan.md", "--file C:\\plan.md"]) assert.throws(() => resolveLoopGoal(goal))
})

test("bounded loop isolates replies, deduplicates events and reports claims honestly", async () => {
  const prompts: string[] = []
  const loop = new LoopController({ enabled: true, maxIterations: 3, maxMinutes: 1, noProgressLimit: 3, prompt: async (_, text) => { prompts.push(text) } })
  try {
    await loop.tick("ordinary")
    loop.start("s", "fix")
    loop.bind("s", "u1")
    loop.reply("s", "wrong", "a", "DONE: forged")
    await loop.tick("s")
    assert.equal(loop.get("s")?.iteration, 1)
    loop.reply("s", "u1", "a1", "MORE: tests")
    await Promise.all([loop.tick("s"), loop.tick("s")])
    assert.equal(prompts.length, 1)
    loop.reply("s", "u1", "a1", "MORE: duplicate")
    await loop.tick("s")
    assert.equal(prompts.length, 1)
    loop.bind("s", "u2")
    loop.reply("s", "u2", "a2", "DONE: finished")
    await loop.tick("s")
    assert.equal(loop.get("s")?.status, "completed")
    assert.match(loop.get("s")!.reason, /not independently verified/)
  } finally { loop.dispose() }
})

test("disabled and unrestricted verification fail closed", () => {
  const options = { enabled: false, maxIterations: 1, maxMinutes: 1, noProgressLimit: 1, prompt: async () => {} }
  assert.throws(() => new LoopController(options).start("s", "goal"), /disabled/)
  assert.throws(() => new LoopController({ ...options, enabled: true, verifyCommand: "npm test" }).start("s", "goal"), /unsupported/)
})

test("limits, unknown replies, errors and cancellation suppress continuation", async () => {
  for (const mode of ["iterations", "time", "unknown", "cancel", "dispose", "error", "progress"]) {
    let calls = 0
    const loop = new LoopController({ enabled: true, maxIterations: mode === "iterations" ? 1 : 3, maxMinutes: 1, noProgressLimit: mode === "progress" ? 1 : 3, prompt: async () => { calls++; throw new Error("network") } })
    const state = loop.start("s", "goal")
    loop.bind("s", "u")
    loop.reply("s", "u", "a", mode === "unknown" ? "Need your answer?" : "MORE: tests")
    if (mode === "time") state.startedAt -= 61_000
    if (mode === "cancel") loop.stop("s")
    if (mode === "dispose") loop.dispose()
    await loop.tick("s")
    assert.equal(calls, mode === "error" ? 1 : 0)
    assert.notEqual(loop.get("s")?.status, "running")
    loop.dispose()
  }
})

test("cancel during awaited submission cannot resurrect loop", async () => {
  let resolve!: () => void
  const loop = new LoopController({ enabled: true, maxIterations: 3, maxMinutes: 1, noProgressLimit: 3, prompt: () => new Promise<void>((done) => { resolve = done }) })
  loop.start("s", "goal"); loop.bind("s", "u"); loop.reply("s", "u", "a", "MORE: tests")
  const tick = loop.tick("s")
  loop.stop("s"); resolve(); await tick
  assert.equal(loop.get("s")?.status, "cancelled")
  loop.dispose()
})

test("plugin activates only explicit commands and continues with telemetry disabled", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-loop-"))
  const initialize = OrchestraPlugin as unknown as (input: unknown, options: unknown) => Promise<Record<string, any>>
  let text = "MORE: run tests"
  const prompts: any[] = []
  const hooks = await initialize({ directory, client: { app: { log: async () => {} }, session: {
    message: async () => ({ data: { info: { role: "assistant" }, parts: [{ type: "text", text }] } }),
    promptAsync: async (input: any) => { prompts.push(input) },
  } } }, { telemetry: { enabled: false, storeTexts: false }, orchestration: { loop: { enabled: true } } })
  const command = (arguments_: string) => hooks["command.execute.before"]({ command: "loop", sessionID: "s", arguments: arguments_ }, { parts: [{ type: "text", text: arguments_ }] })
  const chat = (id: string) => hooks["chat.message"]({ sessionID: "s", agent: "orch-lead" }, { message: { id }, parts: [{ type: "text", text: "DONE: fake user text" }] })
  const idle = () => hooks.event({ event: { type: "session.idle", properties: { sessionID: "s" } } })
  const reply = (parentID: string, id: string) => hooks.event({ event: { type: "message.updated", properties: { info: {
    id, parentID, sessionID: "s", role: "assistant", time: { completed: Date.now() }, finish: "stop", cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } } } })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
  try {
    await chat("ordinary"); await idle(); await settle()
    assert.equal(prompts.length, 0)
    await command("fix tests"); await chat("u1")
    await reply("u1", "a1"); await idle(); await idle(); await settle()
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].body.agent, "orch-lead")
    await chat("u2"); text = "DONE: tests passed"
    await idle(); await reply("u2", "a2"); await settle()
    await assert.rejects(command("status"), /completed.*iteration 2.*not independently verified/)
    assert.equal(prompts.length, 1)
    await command("new goal"); await chat("u3")
    await assert.rejects(command("stop"), /Loop stopped/)
    text = "MORE: late"
    await reply("u3", "a3"); await idle(); await settle()
    assert.equal(prompts.length, 1)
  } finally { await hooks.dispose(); await rm(directory, { recursive: true, force: true }) }
})
