import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { Ledger } from "../src/telemetry/ledger.js"

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
