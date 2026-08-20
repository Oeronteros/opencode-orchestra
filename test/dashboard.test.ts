import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { startDashboard } from "../src/dashboard/server.js"
import { projectId, registerProject } from "../src/dashboard/registry.js"

test("dashboard serves local telemetry and saves validated config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-dashboard-"))
  const project = path.join(root, "project")
  const config = path.join(root, "config")
  const assets = path.join(root, "assets")
  await mkdir(path.join(project, ".orchestra"), { recursive: true })
  await mkdir(config, { recursive: true })
  await mkdir(assets, { recursive: true })
  await writeFile(path.join(assets, "index.html"), "<h1>Orchestra</h1>")
  await writeFile(path.join(config, "orchestra.jsonc"), '\ufeff{\n  // preserve me\n  "budget": "balanced"\n}\n')
  await writeFile(path.join(config, "opencode.json"), '\ufeff{"mcp":{"playwright":{"type":"local"}}}\n')
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
    const snapshot = await response.json() as { summary: { calls: number; tokens: { input: number } }; mcp: { playwright: boolean }; projection: { projected: number }; anomalies: Array<{ date: string }>; config: { telemetry: { storeTexts: boolean } } }
    assert.equal(snapshot.summary.calls, 1)
    assert.equal(snapshot.summary.tokens.input, 100)
    assert.equal(snapshot.mcp.playwright, true)
    // Analytics are exposed on the snapshot; projection is a finite number and
    // storeTexts defaults to false when not configured.
    assert.equal(typeof snapshot.projection.projected, "number")
    assert.ok(Array.isArray(snapshot.anomalies))
    assert.equal(snapshot.config.telemetry.storeTexts, false)

    const save = await fetch(new URL("/api/config", url), {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Orchestra-Token": token },
      body: JSON.stringify({ budget: "ebobo", models: { strategy: "auto", agents: { "orch-repo": "" } }, telemetry: { enabled: true } }),
    })
    assert.equal(save.status, 200)
    const text = await readFile(path.join(config, "orchestra.jsonc"), "utf8")
    assert.ok(text.includes("// preserve me"))
    assert.ok(text.includes('"budget": "ebobo"'))
    assert.ok(!text.includes('orch-repo'))

    const csv = await fetch(new URL("/api/export?scope=activity&format=csv", url), { headers: { "X-Orchestra-Token": token } })
    assert.equal(csv.status, 200)
    assert.match(csv.headers.get("content-type") ?? "", /text\/csv/)
    assert.match(csv.headers.get("content-disposition") ?? "", /attachment; filename="project-orchestra-activity-/)
    const csvText = await csv.text()
    assert.ok(csvText.startsWith("id,sessionID,agent,provider,model,createdAt,completedAt,finish,cost,tokensInput,tokensOutput,tokensReasoning,cacheRead,cacheWrite"))
    assert.ok(csvText.includes("msg,one,orch-lead,openai,gpt-test"))

    const json = await fetch(new URL("/api/export?scope=models&format=json", url), { headers: { "X-Orchestra-Token": token } })
    assert.equal(json.status, 200)
    assert.match(json.headers.get("content-type") ?? "", /application\/json/)
    const jsonBody = await json.json() as { scope: string; rows: Array<Record<string, unknown>> }
    assert.equal(jsonBody.scope, "models")
    assert.equal(jsonBody.rows.length, 1)
    const first = jsonBody.rows[0]!
    assert.equal(first.id, "openai/gpt-test")
    assert.equal(first.calls, 1)

    const badScope = await fetch(new URL("/api/export?scope=nope&format=csv", url), { headers: { "X-Orchestra-Token": token } })
    assert.equal(badScope.status, 400)

    const noAuth = await fetch(new URL("/api/export?scope=summary&format=csv", url))
    assert.equal(noAuth.status, 401)
  } finally {
    await dashboard.close()
  }
})

test("dashboard validates the full schema on the fly and rejects invalid patches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-dashboard-validate-"))
  const project = path.join(root, "project")
  const config = path.join(root, "config")
  const assets = path.join(root, "assets")
  await mkdir(path.join(project, ".orchestra"), { recursive: true })
  await mkdir(config, { recursive: true })
  await mkdir(assets, { recursive: true })
  await writeFile(path.join(assets, "index.html"), "<h1>Orchestra</h1>")
  await writeFile(path.join(config, "orchestra.jsonc"), '{ "budget": "balanced" }\n')

  const dashboard = await startDashboard({ directory: project, configDirectory: config, assetsDirectory: assets, open: false })
  try {
    const url = new URL(dashboard.url)
    const token = url.searchParams.get("token") ?? ""
    const headers = { "Content-Type": "application/json", "X-Orchestra-Token": token } as const

    // Non-mutating validation of a valid patch.
    const valid = await fetch(new URL("/api/config/validate", url), {
      method: "POST",
      headers,
      body: JSON.stringify({ orchestration: { parallelWorkers: 4 }, superpowers: { compatibility: false } }),
    })
    assert.equal(valid.status, 200)
    const validBody = await valid.json() as { valid: boolean; issues: Array<{ path: string }> }
    assert.equal(validBody.valid, true)
    assert.deepEqual(validBody.issues, [])

    // Invalid values produce structured field errors, not a bare 500.
    const invalid = await fetch(new URL("/api/config/validate", url), {
      method: "POST",
      headers,
      body: JSON.stringify({ orchestration: { parallelWorkers: 99 }, budget: "not-a-mode" }),
    })
    assert.equal(invalid.status, 200)
    const invalidBody = await invalid.json() as { valid: boolean; issues: Array<{ path: string; message: string }> }
    assert.equal(invalidBody.valid, false)
    assert.ok(invalidBody.issues.some((issue) => issue.path === "orchestration.parallelWorkers"))
    assert.ok(invalidBody.issues.some((issue) => issue.path === "budget"))

    // A full-schema PUT edits more than the old narrow subset and round-trips.
    const save = await fetch(new URL("/api/config", url), {
      method: "PUT",
      headers,
      body: JSON.stringify({
        budget: "quality",
        orchestration: { parallelWorkers: 4, confidenceThreshold: 0.5 },
        superpowers: { injectPrimaryHint: true },
      }),
    })
    assert.equal(save.status, 200)
    const text = await readFile(path.join(config, "orchestra.jsonc"), "utf8")
    assert.ok(text.includes('"parallelWorkers": 4'))
    assert.ok(text.includes('"confidenceThreshold": 0.5'))
    assert.ok(text.includes('"injectPrimaryHint": true'))

    // An invalid PUT is rejected with 422 and structured issues (no write).
    const badSave = await fetch(new URL("/api/config", url), {
      method: "PUT",
      headers,
      body: JSON.stringify({ orchestration: { parallelWorkers: -1 } }),
    })
    assert.equal(badSave.status, 422)
    const badSaveBody = await badSave.json() as { error: string; issues: Array<{ path: string }> }
    assert.equal(badSaveBody.error, "Invalid configuration")
    assert.ok(badSaveBody.issues.some((issue) => issue.path === "orchestration.parallelWorkers"))
  } finally {
    await dashboard.close()
  }
})
test("dashboard /api/live streams the live snapshot over SSE", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-live-sse-"))
  const project = path.join(root, "project")
  const config = path.join(root, "config")
  const assets = path.join(root, "assets")
  await mkdir(path.join(project, ".orchestra"), { recursive: true })
  await mkdir(config, { recursive: true })
  await mkdir(assets, { recursive: true })
  await writeFile(path.join(assets, "index.html"), "<h1>Orchestra</h1>")
  await writeFile(path.join(config, "orchestra.jsonc"), '{ "budget": "balanced" }\n')
  // Pre-seed a live snapshot as the plugin would leave it.
  await writeFile(path.join(project, ".orchestra", "live.ndjson"), JSON.stringify({
    version: 1,
    updatedAt: 1700000000000,
    seq: 3,
    active: [{ key: "msg-1", sessionID: "s1", agent: "orch-lead", model: "gpt-test", provider: "openai", startedAt: 1699999999000, text: "working", cost: 0.0002, tokens: { input: 100, output: 20, reasoning: 0 } }],
    recent: [{ seq: 1, e: "start", ts: 1699999999000, k: "msg-1", agent: "orch-lead" }, { seq: 2, e: "delta", ts: 1699999999100, k: "msg-1", text: "working", cost: 0.0002 }],
  }) + "\n")
  const dashboard = await startDashboard({ directory: project, configDirectory: config, assetsDirectory: assets, open: false })
  try {
    const url = new URL(dashboard.url)
    const token = url.searchParams.get("token") ?? ""
    const controller = new AbortController()
    const response = await fetch(new URL("/api/live?token=" + encodeURIComponent(token), url), { signal: controller.signal })
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let data = ""
    const timeout = setTimeout(() => controller.abort(), 5000)
    try {
      // Read until we have captured the initial snapshot event.
      for (let i = 0; i < 60 && !data.includes("event: snapshot"); i += 1) {
        const { value, done } = await reader.read()
        if (done) break
        data += decoder.decode(value, { stream: true })
      }
    } finally {
      clearTimeout(timeout)
      try { await reader.cancel() } catch { /* connection already closed */ }
      controller.abort()
    }
    const match = /event: snapshot\ndata: (\{.*?\})\n\n/s.exec(data)
    assert.ok(match, "expected an SSE snapshot frame, got: " + data.slice(0, 200))
    const snapshot = JSON.parse(match[1]!) as { active: Array<{ agent?: string; cost: number }> }
    assert.equal(snapshot.active.length, 1)
    assert.equal(snapshot.active[0]?.agent, "orch-lead")
    assert.ok(snapshot.active[0]!.cost > 0)
  } finally {
    await dashboard.close()
  }
})

test("dashboard aggregates registered projects and selects one by id", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-dashboard-global-"))
  const first = path.join(root, "first")
  const second = path.join(root, "second")
  const config = path.join(root, "config")
  const assets = path.join(root, "assets")
  await Promise.all([
    mkdir(path.join(first, ".orchestra"), { recursive: true }),
    mkdir(path.join(second, ".orchestra"), { recursive: true }),
    mkdir(config, { recursive: true }),
    mkdir(assets, { recursive: true }),
  ])
  await writeFile(path.join(assets, "index.html"), "<h1>Orchestra</h1>")
  await writeFile(path.join(config, "orchestra.jsonc"), '{ "budget": "balanced" }\n')
  const state = (cost: number, input: number) => JSON.stringify({
    version: 2,
    updatedAt: "2026-08-20T00:00:00.000Z",
    sessions: { one: { agents: {}, premiumEscalations: 0, estimatedPaidUsage: cost, freeWorkerCalls: 0, messages: { msg: { cost, provider: "openai", model: "gpt-test", tokens: { input, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } } } } },
  })
  await writeFile(path.join(first, ".orchestra", "state.json"), state(0.1, 100))
  await writeFile(path.join(second, ".orchestra", "state.json"), state(0.2, 200))
  await registerProject(second, config)

  const dashboard = await startDashboard({ directory: first, configDirectory: config, assetsDirectory: assets, open: false })
  try {
    const url = new URL(dashboard.url)
    const headers = { "X-Orchestra-Token": url.searchParams.get("token") ?? "" }
    const projectsResponse = await fetch(new URL("/api/projects", url), { headers })
    assert.equal(projectsResponse.status, 200)
    const projects = await projectsResponse.json() as Array<{ id: string; name: string; summary: { calls: number } }>
    assert.deepEqual(projects.map((project) => project.name).sort(), ["first", "second"])

    const globalResponse = await fetch(new URL("/api/global", url), { headers })
    assert.equal(globalResponse.status, 200)
    const global = await globalResponse.json() as { summary: { projects: number; calls: number; cost: number; tokens: { input: number } }; models: Array<{ id: string; calls: number }> }
    assert.equal(global.summary.projects, 2)
    assert.equal(global.summary.calls, 2)
    assert.ok(Math.abs(global.summary.cost - 0.3) < 1e-9)
    assert.equal(global.summary.tokens.input, 300)
    assert.equal(global.models[0]?.id, "openai/gpt-test")
    assert.equal(global.models[0]?.calls, 2)

    const selectedResponse = await fetch(new URL(`/api/snapshot?project=${projectId(second)}`, url), { headers })
    assert.equal(selectedResponse.status, 200)
    const selected = await selectedResponse.json() as { project: string; summary: { cost: number } }
    assert.equal(selected.project, "second")
    assert.equal(selected.summary.cost, 0.2)

    const missing = await fetch(new URL("/api/snapshot?project=missing", url), { headers })
    assert.equal(missing.status, 404)
  } finally {
    await dashboard.close()
  }
})
