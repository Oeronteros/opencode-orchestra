import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { Ledger } from "../src/telemetry/ledger.js"
import { isRetryable, type ErrorKind } from "../src/routing/fallback.js"
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

test("retryable failure records one failed then one retried transition on the next attempt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-ledger-"))
  const ledger = new Ledger(root, ".orchestra", true, [])

  try {
    await ledger.recordAssistant({
      id: "msg-1",
      sessionID: "s",
      role: "assistant",
      mode: "build",
      providerID: "openai",
      modelID: "gpt-5",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      error: { message: "rate limit exceeded", status: 429 },
    })
    await ledger.recordAssistant({
      id: "msg-2",
      sessionID: "s",
      role: "assistant",
      mode: "build",
      providerID: "openai",
      modelID: "gpt-4o",
      cost: 0.01,
      finish: "stop",
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    })

    const session = await ledger.getSession("s")
    const events = session.reliability ?? []
    assert.equal(events.length, 2)
    assert.equal(events[0]?.outcome, "failed")
    assert.equal(events[0]?.errorKind, "rate-limit")
    assert.equal(events[0]?.attempt, 1)
    assert.equal(events[0]?.model, "openai/gpt-5")
    assert.equal(events[1]?.outcome, "retried")
    assert.equal(events[1]?.model, "openai/gpt-4o")
    assert.equal(events[1]?.nextModel, "openai/gpt-4o")
    assert.equal(events[1]?.attempt, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("terminal auth failure records only failed and no retry transition", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-ledger-"))
  const ledger = new Ledger(root, ".orchestra", true, [])

  try {
    await ledger.recordAssistant({
      id: "msg-1",
      sessionID: "s",
      role: "assistant",
      mode: "build",
      providerID: "openai",
      modelID: "gpt-5",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      error: { message: "unauthorized", status: 401 },
    })
    await ledger.recordAssistant({
      id: "msg-2",
      sessionID: "s",
      role: "assistant",
      mode: "build",
      providerID: "openai",
      modelID: "gpt-4o",
      cost: 0.01,
      finish: "stop",
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    })

    const session = await ledger.getSession("s")
    const events = session.reliability ?? []
    assert.equal(events.length, 1)
    assert.equal(events[0]?.outcome, "failed")
    assert.equal(events[0]?.errorKind, "auth")
    assert.equal(events[0]?.attempt, 1)
    assert.equal(events[0]?.model, "openai/gpt-5")
    assert.equal(isRetryable("auth"), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("reliability events persist only the sanitized kind, never the raw message", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-ledger-"))
  const ledger = new Ledger(root, ".orchestra", true, [])

  try {
    await ledger.recordAssistant({
      id: "msg-1",
      sessionID: "s",
      role: "assistant",
      mode: "build",
      providerID: "openai",
      modelID: "gpt-5",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      error: { message: "secret-key-leak exceeded 429", status: 429 },
    })

    const raw = await readFile(path.join(root, ".orchestra", "state.json"), "utf8")
    assert.equal(raw.includes("secret-key-leak"), false, "raw error message must not be persisted")
    assert.equal(raw.includes("exceeded"), false)

    // Preserved through a fresh reload of the same state file.
    const reloaded = new Ledger(root, ".orchestra", true, [])
    const session = await reloaded.getSession("s")
    const event = session.reliability?.[0]
    assert.equal(event?.attempt, 1)
    assert.equal(event?.model, "openai/gpt-5")
    assert.equal(event?.errorKind, "rate-limit")
    assert.equal(event?.outcome, "failed")
    assert.equal(typeof event?.at, "number")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("reliability events are bounded to the most recent 100", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-ledger-"))
  const ledger = new Ledger(root, ".orchestra", true, [])

  try {
    for (let i = 0; i < 150; i++) {
      await ledger.recordReliabilityEvent("s", {
        attempt: i + 1,
        outcome: "failed",
        errorKind: "other",
        at: 1000 + i,
      })
    }
    const session = await ledger.getSession("s")
    const events = session.reliability ?? []
    assert.equal(events.length, 100)
    assert.equal(events[0]?.attempt, 51)
    assert.equal(events[99]?.attempt, 150)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("recordReliabilityEvent sanitizes fields and rejects unknown error kinds", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-ledger-"))
  const ledger = new Ledger(root, ".orchestra", true, [])

  try {
    await ledger.recordReliabilityEvent("s", {
      attempt: 1,
      model: "x".repeat(500),
      nextModel: "y".repeat(300),
      errorKind: "not-a-kind" as unknown as ErrorKind,
      outcome: "retried",
      at: 123,
    })
    const session = await ledger.getSession("s")
    const event = session.reliability?.[0]
    assert.equal(event?.errorKind, undefined, "unknown error kind must be dropped")
    assert.equal(event?.model?.length, 200)
    assert.equal(event?.nextModel?.length, 200)
    assert.equal(event?.outcome, "retried")
    assert.equal(event?.at, 123)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("failure finish records a terminal failed event and no retry transition", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-ledger-"))
  const ledger = new Ledger(root, ".orchestra", true, [])

  try {
    await ledger.recordAssistant({
      id: "msg-1",
      sessionID: "s",
      role: "assistant",
      mode: "build",
      providerID: "openai",
      modelID: "gpt-5",
      cost: 0,
      finish: "error",
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    await ledger.recordAssistant({
      id: "msg-2",
      sessionID: "s",
      role: "assistant",
      mode: "build",
      providerID: "openai",
      modelID: "gpt-4o",
      cost: 0.01,
      finish: "stop",
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    })

    const session = await ledger.getSession("s")
    const events = session.reliability ?? []
    assert.equal(events.length, 1)
    assert.equal(events[0]?.outcome, "failed")
    assert.equal(events[0]?.errorKind, "other")
    assert.equal(events[0]?.attempt, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("SDK-shaped nested error data is flattened and never persisted verbatim", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-ledger-"))
  const ledger = new Ledger(root, ".orchestra", true, [])

  try {
    await ledger.recordAssistant({
      id: "msg-1",
      sessionID: "s",
      role: "assistant",
      mode: "build",
      providerID: "openai",
      modelID: "gpt-5",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      error: { data: { message: "secret-response-body", statusCode: 429, isRetryable: true } },
    })

    const session = await ledger.getSession("s")
    const events = session.reliability ?? []
    assert.equal(events.length, 1)
    assert.equal(events[0]?.outcome, "failed")
    assert.equal(events[0]?.errorKind, "rate-limit")

    const raw = await readFile(path.join(root, ".orchestra", "state.json"), "utf8")
    assert.equal(raw.includes("secret-response-body"), false, "raw provider error text must not be persisted")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("recordAssistant with a null error does not throw and keeps later writes working", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-ledger-"))
  const ledger = new Ledger(root, ".orchestra", true, [])

  try {
    // A runtime literal-null error (not representable in AssistantInfo's type)
    // must not throw inside the queued mutation or poison subsequent writes.
    await ledger.recordAssistant({
      id: "msg-1",
      sessionID: "s",
      role: "assistant",
      mode: "build",
      providerID: "openai",
      modelID: "gpt-5",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      error: null,
    } as unknown as Parameters<Ledger["recordAssistant"]>[0])

    await ledger.recordAssistant({
      id: "msg-2",
      sessionID: "s",
      role: "assistant",
      mode: "build",
      providerID: "openai",
      modelID: "gpt-4o",
      cost: 0.01,
      finish: "stop",
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    })

    const session = await ledger.getSession("s")
    assert.equal(session.messages["msg-2"]?.cost, 0.01)
    assert.deepEqual(session.reliability ?? [], [], "null error must not fabricate a failed event")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("corrupted reliability entries in state are dropped instead of fabricated", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-ledger-"))
  const dir = path.join(root, ".orchestra")
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, "state.json"), JSON.stringify({
    version: 2,
    updatedAt: new Date(0).toISOString(),
    sessions: {
      s: {
        agents: {},
        premiumEscalations: 0,
        estimatedPaidUsage: 0,
        freeWorkerCalls: 0,
        unknownPriceCalls: 0,
        paidCallsUsed: 0,
        messages: {},
        reliability: [
          { attempt: 1, outcome: "bogus", at: 123 },
          { outcome: "failed" },
        ],
      },
    },
  }), "utf8")

  try {
    const ledger = new Ledger(root, ".orchestra", true, [])
    const session = await ledger.getSession("s")
    assert.deepEqual(session.reliability, [], "unrecognizable records must be dropped, not coerced into failed events")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
