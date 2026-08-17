import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { startDashboard } from "../src/dashboard/server.js"

test("dashboard serves local telemetry and saves validated config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-dashboard-"))
  const project = path.join(root, "project")
  const config = path.join(root, "config")
  const assets = path.join(root, "assets")
  await mkdir(path.join(project, ".orchestra"), { recursive: true })
  await mkdir(config, { recursive: true })
  await mkdir(assets, { recursive: true })
  await writeFile(path.join(assets, "index.html"), "<h1>Orchestra</h1>")
  await writeFile(path.join(config, "orchestra.jsonc"), '{\n  // preserve me\n  "budget": "balanced"\n}\n')
  await writeFile(path.join(config, "opencode.json"), '{"mcp":{"supermemory":{"type":"remote"}}}\n')
  await writeFile(path.join(project, ".orchestra", "state.json"), JSON.stringify({
    version: 2,
    updatedAt: "2026-08-16T00:00:00.000Z",
    sessions: {
      one: {
        agents: { "orch-lead": 1 }, premiumEscalations: 0, estimatedPaidUsage: 0.01, freeWorkerCalls: 0,
        messages: { msg: { cost: 0.01, agent: "orch-lead", provider: "openai", model: "gpt-test", tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 20, write: 0 } } } },
      },
    },
  }))

  const dashboard = await startDashboard({ directory: project, configDirectory: config, assetsDirectory: assets, open: false })
  try {
    const url = new URL(dashboard.url)
    const token = url.searchParams.get("token") ?? ""
    const response = await fetch(new URL("/api/snapshot", url), { headers: { "X-Orchestra-Token": token } })
    assert.equal(response.status, 200)
    const snapshot = await response.json() as { summary: { calls: number; tokens: { input: number } }; mcp: { supermemory: boolean } }
    assert.equal(snapshot.summary.calls, 1)
    assert.equal(snapshot.summary.tokens.input, 100)
    assert.equal(snapshot.mcp.supermemory, true)

    const save = await fetch(new URL("/api/config", url), {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Orchestra-Token": token },
      body: JSON.stringify({ budget: "ebobo", models: { strategy: "auto", agents: {} }, telemetry: { enabled: true } }),
    })
    assert.equal(save.status, 200)
    const text = await readFile(path.join(config, "orchestra.jsonc"), "utf8")
    assert.ok(text.includes("// preserve me"))
    assert.ok(text.includes('"budget": "ebobo"'))
  } finally {
    await dashboard.close()
  }
})
