import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { Ledger } from "../src/telemetry/ledger.js"
import type { ModelCandidateInput } from "../src/config/schema.js"

test("records assistant responses outside the orchestra subagent modes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-ledger-"))
  const ledger = new Ledger(root, ".orchestra", true, [])

  try {
    await ledger.recordAssistant({
      id: "main-message",
      sessionID: "session-1",
      role: "assistant",
      mode: "build",
      providerID: "openai",
      modelID: "gpt-5",
      cost: 0.03,
      time: { created: 100, completed: 200 },
      tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 0 } },
      finish: "stop",
    })
    await ledger.recordAssistant({
      id: "main-message",
      sessionID: "session-1",
      role: "assistant",
      mode: "build",
      providerID: "openai",
      modelID: "gpt-5",
      cost: 0.08,
      time: { created: 100, completed: 300 },
      tokens: { input: 12, output: 8, reasoning: 2, cache: { read: 4, write: 0 } },
      finish: "stop",
    })

    const state = JSON.parse(await readFile(path.join(root, ".orchestra", "state.json"), "utf8")) as {
      sessions: Record<string, { agents: Record<string, number>; estimatedPaidUsage: number; messages: Record<string, { cost: number; tokens: { output: number } }> }>
    }
    const session = state.sessions["session-1"]

    assert.equal(session?.agents.build, 1)
    assert.equal(session?.estimatedPaidUsage, 0.08)
    assert.equal(session?.messages["main-message"]?.cost, 0.08)
    assert.equal(session?.messages["main-message"]?.tokens.output, 8)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("recordText is a no-op when storeTexts is disabled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-ledger-"))
  const ledger = new Ledger(root, ".orchestra", true, [])

  try {
    await ledger.recordText("session-1", "msg", { prompt: "secret", reply: "answer" })
    // storeTexts defaults to false, so nothing is persisted at all.
    await assert.rejects(readFile(path.join(root, ".orchestra", "state.json"), "utf8"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("recordText persists prompt and reply when storeTexts is enabled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-ledger-"))
  const ledger = new Ledger(root, ".orchestra", true, [], true)

  try {
    await ledger.recordAssistant({
      id: "msg",
      sessionID: "session-1",
      role: "assistant",
      mode: "build",
      providerID: "openai",
      modelID: "gpt-5",
      cost: 0.01,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    await ledger.recordText("session-1", "msg", { prompt: "hello", reply: "world" })
    const state = JSON.parse(await readFile(path.join(root, ".orchestra", "state.json"), "utf8")) as {
      sessions: Record<string, { messages: Record<string, { prompt?: string; reply?: string }> }>
    }
    const message = state.sessions["session-1"]?.messages["msg"]
    assert.equal(message?.prompt, "hello")
    assert.equal(message?.reply, "world")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("recordAssistant stores pricingStatus and counts unknown-price calls", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-ledger-"))
  const ledger = new Ledger(root, ".orchestra", true, [], false, () => "unknown")

  try {
    await ledger.recordAssistant({
      id: "msg",
      sessionID: "session-1",
      role: "assistant",
      mode: "build",
      providerID: "mystery",
      modelID: "gpt-5",
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const state = JSON.parse(await readFile(path.join(root, ".orchestra", "state.json"), "utf8")) as {
      sessions: Record<string, { unknownPriceCalls: number; messages: Record<string, { pricingStatus?: string; cost: number }> }>
    }
    const session = state.sessions["session-1"]
    assert.equal(session?.messages["msg"]?.pricingStatus, "unknown")
    assert.equal(session?.messages["msg"]?.cost, 0)
    assert.equal(session?.unknownPriceCalls, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("freeWorkerCalls counts discovered free models via resolved status", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-ledger-"))
  const ledger = new Ledger(root, ".orchestra", true, [], false, () => "free")

  try {
    await ledger.recordAssistant({
      id: "msg",
      sessionID: "session-1",
      role: "assistant",
      mode: "orch-code",
      providerID: "discovered",
      modelID: "free-model",
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const state = JSON.parse(await readFile(path.join(root, ".orchestra", "state.json"), "utf8")) as {
      sessions: Record<string, { freeWorkerCalls: number }>
    }
    assert.equal(state.sessions["session-1"]?.freeWorkerCalls, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("tracks distinct paid calls and session consensus", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-ledger-"))
  const paid: ModelCandidateInput = { id: "vendor/paid", cost: "paid", tier: "frontier", priority: 50, capabilities: [], scores: {} }
  const ledger = new Ledger(root, ".orchestra", true, [[paid]])
  try {
    const info = { id: "paid-1", sessionID: "s", role: "assistant" as const, providerID: "vendor", modelID: "paid", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }
    await ledger.recordAssistant(info)
    await ledger.recordAssistant(info)
    await ledger.setConsensus("s", 0.4, { uncertainty: 0.3, notes: "workers differ" })
    const session = await ledger.getSession("s")
    assert.equal(session.paidCallsUsed, 1)
    assert.equal(session.consensus, 0.4)
    assert.equal(session.consensusUncertainty, 0.3)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
