import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { estimateLiveCost, estimateOutputTokens, LiveStream, parseLiveSnapshot, renameWithRetry } from "../src/telemetry/live.js"

const PRICE = { input: 1.25, output: 10 }

test("LiveStream records start/delta/finish and estimates live cost", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-live-"))
  const project = path.join(root, "project")
  const live = new LiveStream(project, ".orchestra", true, () => PRICE, 100, 5, true)
  live.start({ key: "msg-1", sessionID: "s1", agent: "orch-lead", provider: "openai", model: "gpt-test" })
  live.delta({ key: "msg-1", sessionID: "s1", agent: "orch-lead", provider: "openai", model: "gpt-test", text: "Hello world, this is a streaming response." })
  live.delta({ key: "msg-1", sessionID: "s1", agent: "orch-lead", provider: "openai", model: "gpt-test", text: "Hello world, this is a streaming response. More tokens flow in." })
  live.finish({ key: "msg-1", sessionID: "s1", agent: "orch-lead", cost: 0.0123, tokens: { input: 100, output: 50, reasoning: 10 }, finish: "complete" })

  await live.dispose()
  const text = await readFile(live.liveFile, "utf8")
  const snapshot = parseLiveSnapshot(text)
  assert.equal(snapshot.version, 1)
  // The agent finished, so it is no longer active.
  assert.equal(snapshot.active.length, 0)
  const recent = snapshot.recent
  assert.equal(recent[0]?.e, "start")
  assert.equal(recent.at(-1)?.e, "finish")
  assert.equal(recent.at(-1)?.k, "msg-1")
  assert.equal(recent.at(-1)?.cost, 0.0123)
  assert.ok(recent.some((event) => event.e === "delta" && typeof event.cost === "number"))
})

test("LiveStream.start is idempotent per key and records a single start event", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-live-start-"))
  const live = new LiveStream(path.join(root, "project"), ".orchestra", true, () => PRICE, 100, 5, true)
  live.start({ key: "msg-2", sessionID: "s2", agent: "orch-lead", provider: "openai", model: "gpt-test" })
  // The live panel calls start() on every assistant-only part update; a repeat
  // for the same key must not mint a second start event or reset the row.
  live.start({ key: "msg-2", sessionID: "s2", agent: "orch-lead", provider: "openai", model: "gpt-test" })
  const snapshot = live.current()
  assert.equal(snapshot.active.length, 1)
  assert.equal(snapshot.active[0]?.key, "msg-2")
  assert.equal(snapshot.active[0]?.agent, "orch-lead")
  assert.equal(snapshot.recent.filter((event) => event.e === "start").length, 1)
  await live.dispose()
})

test("LiveStream keeps running agents in the active set", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-live-active-"))
  const live = new LiveStream(path.join(root, "project"), ".orchestra", true, () => undefined, 100, 5, true)
  // A delta without an explicit start must retain the first chunk.
  live.delta({ key: "a", sessionID: "s1", agent: "orch-repo", text: "editing code" })
  await live.dispose()
  const snapshot = parseLiveSnapshot(await readFile(live.liveFile, "utf8"))
  assert.equal(snapshot.active.length, 1)
  assert.equal(snapshot.active[0]?.agent, "orch-repo")
  assert.equal(snapshot.active[0]?.text, "editing code")
  assert.ok(snapshot.recent.some((event) => event.e === "delta" && event.text === "editing code"))
})

test("LiveStream cost grows using full output length while persisting only a snippet", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-live-cost-"))
  const live = new LiveStream(path.join(root, "project"), ".orchestra", true, () => PRICE, 100, 5, true)
  live.delta({ key: "a", text: "x".repeat(240), chars: 240 })
  const first = live.current().active[0]!
  live.delta({ key: "a", text: "y".repeat(240), chars: 2_400 })
  const second = live.current().active[0]!
  assert.equal(second.text.length, 240)
  assert.ok(second.cost > first.cost)
  assert.equal(second.tokens.output, 600)
  await live.dispose()
})

test("LiveStream redacts partial text unless storeTexts is enabled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-live-private-"))
  const live = new LiveStream(path.join(root, "project"), ".orchestra", true, () => PRICE, 100, 5)
  live.delta({ key: "a", text: "secret partial reply", chars: 20 })
  await live.dispose()
  const snapshot = parseLiveSnapshot(await readFile(live.liveFile, "utf8"))
  assert.equal(snapshot.active[0]?.text, "")
  assert.ok(snapshot.recent.every((event) => event.text === undefined || event.text === ""))
  assert.ok((snapshot.active[0]?.cost ?? 0) > 0)
})

test("LiveStream with telemetry disabled records nothing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-live-off-"))
  const live = new LiveStream(path.join(root, "project"), ".orchestra", false)
  live.start({ key: "a", agent: "orch-lead" })
  live.delta({ key: "a", text: "x" })
  live.finish({ key: "a", cost: 0, tokens: { input: 1, output: 1, reasoning: 0 } })
  await live.dispose()
  // Telemetry disabled: the live file is never created and nothing is recorded.
  await assert.rejects(readFile(live.liveFile, "utf8"), { code: "ENOENT" })
})

test("estimateLiveCost prices text and estimates tokens", () => {
  assert.equal(estimateOutputTokens(40), 10)
  const est = estimateLiveCost(40, PRICE, 100)
  assert.equal(est.output, 10)
  assert.equal(est.input, 100)
  assert.equal(est.cost, (100 * PRICE.input + 10 * PRICE.output) / 1_000_000)
  // No price -> zero estimated cost.
  assert.equal(estimateLiveCost(40, undefined, 100).cost, 0)
})

test("estimateLiveCost estimates reasoning tokens separately from output", () => {
  const est = estimateLiveCost(16, PRICE, 100, 80)
  assert.equal(est.output, 4)
  assert.equal(est.reasoning, 20)
  assert.equal(est.input, 100)
  // Reasoning text is not priced (no reasoning price in the price model).
  assert.equal(est.cost, (100 * PRICE.input + 4 * PRICE.output) / 1_000_000)
})

test("LiveStream tracks reasoning separately from output tokens", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-live-reasoning-"))
  const live = new LiveStream(path.join(root, "project"), ".orchestra", true, () => PRICE, 100, 5, true)
  live.delta({ key: "r1", text: "an output chunk from the agent", chars: 32, reasoningChars: 400 })
  const row = live.current().active[0]!
  assert.equal(row.tokens.output, 8)
  assert.equal(row.tokens.reasoning, 100)
  // The estimate does not leak reasoning into the output tok/s math.
  live.delta({ key: "r1", text: "more output", chars: 64, reasoningChars: 800 })
  const grown = live.current().active[0]!
  assert.equal(grown.tokens.output, 16)
  assert.equal(grown.tokens.reasoning, 200)
  // The internal reasoning counter never leaks into the snapshot.
  assert.equal((grown as unknown as Record<string, unknown>).reasoningChars, undefined)
  assert.ok(grown.cost > row.cost)
  await live.dispose()
})

test("LiveStream counts only active output intervals and ignores long pauses", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-live-generation-time-"))
  let now = 0
  const live = new LiveStream(path.join(root, "project"), ".orchestra", true, () => PRICE, 100, 5, true, () => now)

  live.start({ key: "generation", startedAt: 0 })
  now = 3_000
  live.delta({ key: "generation", text: "first", chars: 400 })
  assert.equal(live.current().active[0]?.generationMs, 0)

  now = 3_100
  live.delta({ key: "generation", text: "second", chars: 800 })
  assert.equal(live.current().active[0]?.generationMs, 100)

  now = 8_000
  live.delta({ key: "generation", text: "third", chars: 1_200 })
  assert.equal(live.current().active[0]?.generationMs, 100)

  now = 8_200
  live.delta({ key: "generation", text: "fourth", chars: 1_600 })
  assert.equal(live.current().active[0]?.generationMs, 300)
  await live.dispose()
})

test("LiveStream.start supersedes a stale row from the same session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-live-supersede-"))
  const live = new LiveStream(path.join(root, "project"), ".orchestra", true, () => PRICE, 100, 5, true)
  // The runtime sometimes never emits a completing message.updated for an
  // assistant message (abort / error before the first token). The session then
  // continues with a new message; the orphaned row must not stay "active"
  // forever or the dashboard counts a ghost agent.
  live.start({ key: "msg-old", sessionID: "s1", agent: "orch-lead" })
  live.start({ key: "msg-new", sessionID: "s1", agent: "orch-lead" })
  const snapshot = live.current()
  assert.equal(snapshot.active.length, 1)
  assert.equal(snapshot.active[0]?.key, "msg-new")
  const superseded = snapshot.recent.find((event) => event.e === "finish" && event.k === "msg-old")
  assert.ok(superseded)
  assert.equal(superseded.finish, "superseded")
  await live.dispose()
})

test("LiveStream.start keeps rows from other sessions untouched", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-live-sessions-"))
  const live = new LiveStream(path.join(root, "project"), ".orchestra", true, () => PRICE, 100, 5, true)
  live.start({ key: "a1", sessionID: "s1", agent: "orch-lead" })
  live.start({ key: "b1", sessionID: "s2", agent: "orch-repo" })
  live.start({ key: "a2", sessionID: "s1", agent: "orch-lead" })
  const keys = live.current().active.map((row) => row.key).sort()
  assert.deepEqual(keys, ["a2", "b1"])
  await live.dispose()
})

test("LiveStream.dropSession removes every active row of a finished/failed session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-live-drop-"))
  const live = new LiveStream(path.join(root, "project"), ".orchestra", true, () => PRICE, 100, 5, true)
  live.start({ key: "a1", sessionID: "s1", agent: "orch-lead" })
  live.start({ key: "b1", sessionID: "s2", agent: "orch-repo" })
  live.dropSession("s1", "session-error")
  const snapshot = live.current()
  assert.deepEqual(snapshot.active.map((row) => row.key), ["b1"])
  const dropped = snapshot.recent.find((event) => event.e === "finish" && event.k === "a1")
  assert.equal(dropped?.finish, "session-error")
  // Unknown sessions are a no-op.
  live.dropSession("nope", "session-idle")
  assert.equal(live.current().active.length, 1)
  await live.dispose()
})

test("parseLiveSnapshot tolerates malformed input", () => {
  const empty = parseLiveSnapshot("not json")
  assert.deepEqual(empty.active, [])
  assert.deepEqual(empty.recent, [])
  assert.equal(empty.version, 1)
})

test("renameWithRetry retries a transient rename failure", async () => {
  let calls = 0
  const flaky = async (): Promise<void> => {
    calls += 1
    if (calls < 3) {
      const error = new Error("EBUSY: resource busy or locked, rename") as NodeJS.ErrnoException
      error.code = "EBUSY"
      throw error
    }
  }
  await renameWithRetry("a.tmp", "a", flaky, 5, 1)
  assert.equal(calls, 3)
})

test("renameWithRetry gives up after exhausting attempts", async () => {
  let calls = 0
  const alwaysFails = async (): Promise<void> => {
    calls += 1
    const error = new Error("EPERM: operation not permitted, rename") as NodeJS.ErrnoException
    error.code = "EPERM"
    throw error
  }
  await assert.rejects(renameWithRetry("a.tmp", "a", alwaysFails, 4, 1), { code: "EPERM" })
  assert.equal(calls, 4)
})
