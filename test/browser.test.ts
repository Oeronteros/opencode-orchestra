import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, mkdir, readFile, writeFile, utimes, readdir } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import os from "node:os"
import path from "node:path"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { browserConfigSchema, orchestraConfigSchema } from "../src/config/schema.js"
import { assertBrowserGrant, chooseBackend, browserTaskSchema, operationForTool } from "../src/browser/policy.js"
import { ProfileLock, profileDirectory, projectIdentity, profileLocked } from "../src/browser/profile.js"
import { BrowserManager } from "../src/browser/manager.js"
import { BrowserRuntime, type BrowserHost, type BrowserCallRecord } from "../src/browser/runtime.js"
import { backendCommand, backendEntry } from "../src/browser/packages.js"
import { refreshBrowserStatus } from "../src/browser/diagnostics.js"
import { createAgentSet } from "../src/agents/build.js"
import { loadPrompts } from "../src/prompts/load.js"
import { OrchestrationRunState } from "../src/orchestration/run-state.js"
import type { TaskContract } from "../src/orchestration/contracts.js"

const execute = promisify(execFile)
const all = { playwright: true, devtools: true }
const grant = browserTaskSchema.parse({ task: "ui", origins: ["http://127.0.0.1:4321"], operations: ["observe", "navigate", "interact", "evaluate"] })
const contract: TaskContract = { objective: "Verify the fixture", inputs: [], deliverable: "Evidence", acceptanceCriteria: ["Check expected and actual behavior"], allowedPaths: [], exclusiveResources: ["browser:default"], delegation: { allowed: false, maxChildren: 0 }, browser: grant }
function context(sessionID: string, agent = "orch-tests"): ToolContext {
  return { sessionID: sessionID as ToolContext["sessionID"], agent: agent as ToolContext["agent"], messageID: "message" as ToolContext["messageID"], id: "call" as ToolContext["id"], signal: new AbortController().signal, progress: async () => undefined }
}
async function worker(state: OrchestrationRunState, root: string, sessionID: string, agent = "orch-tests", taskContract = contract) {
  state.registerPlan(root, { nodes: [{ id: "browser-node", worker: agent, description: "Browser", dependsOn: [], role: "specialist", contract: taskContract }], levels: [["browser-node"]], maxParallel: 1 })
  const result = await state.acquire({ parentSessionID: root, nodeId: "browser-node", agent, task: "Browser", contract: taskContract })
  assert.ok(result.ok, result.ok ? "" : `${result.code}: ${result.error}`)
  state.attachSession(result.lease, sessionID)
  return result.lease
}
class FakeManager extends BrowserManager {
  started = false
  launches = 0
  url = "about:blank"
  override get running(): boolean { return this.started }
  override async start(): Promise<string> { if (!this.started) { await this.lock.acquire(); this.started = true; this.launches++ }; return "http://127.0.0.1:12345" }
  override async verify(): Promise<void> { if (!this.started) throw new Error("browser_crashed") }
  override async targets() { await this.verify(); return [{ id: "real-target", type: "page", url: this.url }] }
  override async stop(): Promise<void> { this.started = false; await this.lock.release() }
}
async function setup(overrides: Record<string, unknown> = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-browser-"))
  const config = browserConfigSchema.parse({ mode: "auto", ...overrides })
  const state = new OrchestrationRunState({ maxWorkers: 4, parallelWorkers: 4, maxDelegationDepth: 2 })
  let manager: FakeManager | undefined
  const connected = { playwright: false, devtools: false }
  const calls: BrowserCallRecord[] = []
  const host: BrowserHost = { bind: () => undefined, available: () => all, connected: async () => ({ ...connected }), connect: async (backend) => { connected[backend] = true }, disconnect: async () => { connected.playwright = connected.devtools = false }, call: async (_backend, name) => ({ content: name === "list_pages" ? "0: about:blank [selected]" : "snapshot" }) }
  const runtime = new BrowserRuntime(config, directory, state, host, async (call) => { calls.push(call) }, directory, (profile, cfg) => { manager = new FakeManager(profile, cfg); return manager })
  return { directory, runtime, state, get manager() { return manager! }, calls }
}

test("config is opt-in for existing installs and validates profiles", () => {
  assert.equal(orchestraConfigSchema.parse({}).browser.mode, "off")
  assert.equal(browserConfigSchema.parse({ mode: "auto" }).mode, "auto")
  for (const input of [{ mode: "wrong" }, { profile: "../personal" }, { profile: "CON" }, { profile: "other" }, { sharedProfiles: ["unknown"] }]) assert.equal(browserConfigSchema.safeParse(input).success, false)
  assert.equal(browserTaskSchema.safeParse({ ...grant, origins: ["https://user:password@example.com"] }).success, false)
  assert.equal(browserTaskSchema.safeParse({ ...grant, origins: ["https://example.com/private?token=secret"] }).success, false)
})
test("auto chooses sufficient backend, observes explicit modes, and avoids browser for docs/E2E", () => {
  const auto = browserConfigSchema.parse({ mode: "auto" })
  assert.equal(chooseBackend(auto, "ui", all), "playwright")
  assert.equal(chooseBackend(auto, "console-network", all, "devtools"), "devtools")
  assert.equal(chooseBackend(auto, "performance", all), "devtools")
  assert.equal(chooseBackend(auto, "ui", { playwright: false, devtools: true }), "devtools")
  assert.equal(chooseBackend(auto, "documentation", all), undefined)
  assert.equal(chooseBackend(auto, "e2e", all), undefined)
  assert.throws(() => chooseBackend(auto, "performance", { playwright: true, devtools: false }))
  assert.throws(() => chooseBackend(browserConfigSchema.parse({ mode: "playwright" }), "ui", { playwright: false, devtools: true }))
  assert.throws(() => chooseBackend(browserConfigSchema.parse({}), "ui", all))
})
test("shared browser policy reaches loaded worker prompts and retains file boundaries", async () => {
  const prompts = await loadPrompts()
  assert.match(prompts.security!, /Attack path/)
  for (const mode of ["off", "auto"] as const) {
    const agents = createAgentSet(orchestraConfigSchema.parse({ browser: { mode } }), prompts)
    for (const agent of Object.values(agents)) assert.match(agent.prompt, /Managed browser policy/)
    assert.equal(agents["orch-tests"]!.permission["playwright_*"], "deny")
    assert.equal(agents["orch-repo"]!.permission.orchestra_browser, undefined)
    assert.equal(agents["orch-tests"]!.permission.edit, undefined)
    assert.equal(agents["orch-tests"]!.permission.orchestra_browser, mode === "off" ? undefined : "ask")
    assert.equal(agents["orch-security"]!.permission["orchestra-browser-devtools_evaluate_script"], undefined)
  }
})
test("permissions require role, sealed grant, and exclusive profile; JS is never read-only", () => {
  assert.throws(() => assertBrowserGrant("orch-repo", contract, "default", "observe"))
  assert.throws(() => assertBrowserGrant("orch-tests", { ...contract, exclusiveResources: [] }, "default"))
  assert.throws(() => assertBrowserGrant("orch-tests", contract, "other"))
  assert.throws(() => assertBrowserGrant("orch-security", contract, "default", "evaluate"))
  assert.equal(operationForTool("browser_run_code"), "evaluate")
  assert.equal(operationForTool("new_page"), undefined)
  assert.equal(operationForTool("unknown_future_tool"), undefined)
  assert.equal(operationForTool("browser_run_code_unsafe"), undefined)
})
test("persistent identity unifies Git worktrees but separates unrelated repositories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-project-"))
  const repo = path.join(root, "repo Unicode пробел")
  await mkdir(repo)
  await execute("git", ["init", "--quiet"], { cwd: repo })
  await execute("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"], { cwd: repo })
  const worktree = path.join(root, "worktree")
  await execute("git", ["worktree", "add", "--detach", worktree], { cwd: repo })
  assert.equal(await projectIdentity(repo), await projectIdentity(worktree))
  const other = path.join(root, "other"); await mkdir(other); await execute("git", ["init", "--quiet"], { cwd: other })
  assert.notEqual(await projectIdentity(repo), await projectIdentity(other))
  assert.equal(await profileDirectory(repo, "account", true, root), await profileDirectory(other, "account", true, root))
  assert.notEqual(await profileDirectory(repo, "account", false, root), await profileDirectory(other, "account", false, root))
})
test("profile lock excludes another process and refuses foreign/orphan lock removal", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "orchestra-lock-"))
  const lock = new ProfileLock(profile); await lock.acquire()
  const source = new URL("../src/browser/profile.js", import.meta.url).href
  const probe = await execute(process.execPath, ["--input-type=module", "-e", `import {ProfileLock} from ${JSON.stringify(source)}; const lock=new ProfileLock(process.argv[1]);try{await lock.acquire();process.exitCode=1}catch(e){console.log(e.message)}`, profile])
  assert.match(probe.stdout, /browser_profile_busy/)
  await new ProfileLock(profile).release()
  assert.equal(await lock.owns(), true)
  await lock.release()
  await mkdir(path.join(profile, ".orchestra-lock"))
  assert.equal(await profileLocked(profile), true)
  await assert.rejects(new ProfileLock(profile).acquire(), /browser_profile_busy/)
})
test("runtime is lazy, serializes different runs, and reuses one manager across handoff", async () => {
  const fixture = await setup()
  assert.equal((await fixture.runtime.status()).browserRunning, false)
  await worker(fixture.state, "root-a", "worker-a")
  await worker(fixture.state, "root-b", "worker-b")
  const ctx = context("worker-a")
  await fixture.runtime.prepare(ctx)
  assert.equal(fixture.manager.launches, 1)
  await assert.rejects(fixture.runtime.prepare(context("worker-b")), /browser_scenario_busy/)
  await assert.rejects(fixture.runtime.execute("playwright", "browser_click", {}, ctx, async () => ({ content: "clicked" })), /fresh_snapshot/)
  await fixture.runtime.execute("playwright", "browser_snapshot", {}, ctx, async () => ({ content: "snapshot" }))
  await assert.rejects(fixture.runtime.prepare(ctx, "default", "diagnostics"), /handoff_reason/)
  await fixture.runtime.prepare(ctx, "default", "diagnostics", "Inspect controlled JS failure")
  assert.equal(fixture.manager.launches, 1)
  await assert.rejects(fixture.runtime.execute("playwright", "browser_snapshot", {}, ctx, async () => ({ content: "old" })), /lease_required/)
  await fixture.runtime.release(ctx)
  await fixture.runtime.prepare(context("worker-b"))
  await fixture.runtime.dispose()
  assert.equal(fixture.manager.running, false)
  assert.equal(await fixture.manager.lock.owns(), false)
})
test("direct/Code Mode executor bypass cannot access a profile without runtime ownership", async () => {
  const fixture = await setup()
  await assert.rejects(fixture.runtime.execute("playwright", "browser_snapshot", {}, context("forged", "orch-repo"), async () => ({ content: "secret" })), /lease_required/)
  await worker(fixture.state, "root", "worker")
  await fixture.runtime.prepare(context("worker"))
  await assert.rejects(fixture.runtime.execute("playwright", "browser_run_code", {}, context("worker", "orch-security"), async () => ({ content: "secret" })), /lease_required/)
  await assert.rejects(fixture.runtime.execute("playwright", "browser_navigate", { url: "https://unrelated.invalid" }, context("worker"), async () => ({ content: "bad" })), /origin_denied/)
  await fixture.runtime.dispose()
})
test("ambiguous mutation is fenced until inspection and cancellation keeps persistent files", async () => {
  const fixture = await setup()
  await worker(fixture.state, "root", "worker")
  const ctx = context("worker")
  await fixture.runtime.prepare(ctx)
  await writeFile(path.join(fixture.manager.profile, "persistent-site-data"), "retained")
  const snapshot = () => fixture.runtime.execute("playwright", "browser_snapshot", {}, ctx, async () => ({ content: "snapshot" }))
  await snapshot()
  await assert.rejects(fixture.runtime.execute("playwright", "browser_click", {}, ctx, async () => { throw new Error("ambiguous backend disconnect") }), /browser_operation_failed/)
  await assert.rejects(fixture.runtime.execute("playwright", "browser_click", {}, ctx, async () => ({ content: "retry" })), /fresh_snapshot/)
  fixture.runtime.releaseSession("worker")
  await fixture.runtime.dispose()
  assert.equal(await readFile(path.join(fixture.manager.profile, "persistent-site-data"), "utf8"), "retained")
  assert.equal(fixture.calls.some((call) => !call.success && call.tool === "browser_click"), true)
  assert.equal(JSON.stringify(fixture.calls).includes("ambiguous backend disconnect"), false)
})
test("browser checkpoints never automatically resume an interrupted external action", async () => {
  const state = new OrchestrationRunState({ maxWorkers: 4, parallelWorkers: 2, maxDelegationDepth: 2 })
  await worker(state, "root", "worker")
  const restored = new OrchestrationRunState({ maxWorkers: 4, parallelWorkers: 2, maxDelegationDepth: 2 })
  restored.restore(state.exportState())
  assert.equal(restored.sealedNode("root", "browser-node")?.status, "blocked")
})
test("observer navigation cannot inject JavaScript and trace reload requires navigation", async () => {
  const fixture = await setup()
  await worker(fixture.state, "root", "worker", "orch-security", { ...contract, browser: { ...grant, operations: ["observe", "navigate", "performance"] } })
  const ctx = context("worker", "orch-security")
  await fixture.runtime.prepare(ctx, "default", "diagnostics", "Inspect performance")
  let executed = false
  await assert.rejects(fixture.runtime.execute("devtools", "navigate_page", { url: grant.origins[0], initScript: "fetch('/mutate')" }, ctx, async () => { executed = true; return { content: "bad" } }), /operation_denied/)
  assert.equal(executed, false)
  await fixture.runtime.dispose()
  const second = await setup()
  await worker(second.state, "root", "worker", "orch-tests", { ...contract, browser: { ...grant, operations: ["observe", "performance"] } })
  await second.runtime.prepare(context("worker"), "default", "diagnostics", "Inspect performance")
  await assert.rejects(second.runtime.execute("devtools", "performance_start_trace", {}, context("worker"), async () => ({ content: "bad" })), /reload_requires_navigation/)
  await second.runtime.execute("devtools", "performance_start_trace", { reload: false }, context("worker"), async () => ({ content: "trace" }))
  await second.runtime.dispose()
})
test("in-flight cancellation holds the scenario until the executor stops and retains profile data", async () => {
  const fixture = await setup()
  await worker(fixture.state, "root-a", "worker-a")
  await worker(fixture.state, "root-b", "worker-b")
  const controller = new AbortController()
  const ctx = { ...context("worker-a"), signal: controller.signal }
  await fixture.runtime.prepare(ctx)
  await fixture.runtime.execute("playwright", "browser_snapshot", {}, ctx, async () => ({ content: "snapshot" }))
  await writeFile(path.join(fixture.manager.profile, "persistent-site-data"), "retained")
  let began!: () => void
  const running = new Promise<void>((resolve) => { began = resolve })
  const operation = fixture.runtime.execute("playwright", "browser_click", {}, ctx, (signal) => new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); began() }))
  await running
  fixture.runtime.releaseSession("worker-a")
  await assert.rejects(fixture.runtime.prepare(context("worker-b")), /scenario_busy/)
  controller.abort()
  await assert.rejects(operation, /browser_operation_failed/)
  assert.equal((await fixture.runtime.status()).activeScenario, false)
  await fixture.runtime.prepare(context("worker-b"))
  await fixture.runtime.dispose()
  assert.equal(await readFile(path.join(fixture.manager.profile, "persistent-site-data"), "utf8"), "retained")
})
test("operation timeout signals the executor and fences an ambiguous mutation", async () => {
  const fixture = await setup({ operationTimeoutMs: 1000 })
  await worker(fixture.state, "root", "worker")
  const ctx = context("worker")
  await fixture.runtime.prepare(ctx)
  await fixture.runtime.execute("playwright", "browser_snapshot", {}, ctx, async () => ({ content: "snapshot" }))
  await assert.rejects(fixture.runtime.execute("playwright", "browser_click", {}, ctx, (signal) => new Promise((_resolve, reject) => { const keepAlive = setTimeout(() => reject(new Error("executor did not receive timeout")), 3000); signal.addEventListener("abort", () => { clearTimeout(keepAlive); reject(signal.reason) }, { once: true }) })), /browser_operation_failed/)
  await assert.rejects(fixture.runtime.execute("playwright", "browser_click", {}, ctx, async () => ({ content: "retry" })), /fresh_snapshot/)
  await fixture.runtime.dispose()
})
test("browser crash leaves ordinary scheduler work available", async () => {
  const fixture = await setup()
  await worker(fixture.state, "root", "worker")
  await fixture.runtime.prepare(context("worker"))
  fixture.manager.started = false
  await assert.rejects(fixture.runtime.execute("playwright", "browser_snapshot", {}, context("worker"), async () => ({ content: "bad" })), /browser_crashed/)
  const { browser: _browser, ...ordinary } = contract
  await worker(fixture.state, "ordinary-root", "ordinary-worker", "orch-repo", { ...ordinary, exclusiveResources: [] })
  assert.equal(fixture.state.sessionContext("ordinary-worker")?.agent, "orch-repo")
  await fixture.runtime.dispose()
})
test("artifact retention preserves live owners and confines network export paths", async () => {
  const fixture = await setup({ artifactRetentionHours: 1, maxOutputChars: 1000 })
  const root = path.join(fixture.directory, "browser", "artifacts")
  const liveDirectory = path.join(root, randomUUID())
  const closedDirectory = path.join(root, randomUUID())
  for (const [directory, closed] of [[liveDirectory, false], [closedDirectory, true]] as const) {
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, ".owner.json"), JSON.stringify({ pid: process.pid, closed }))
    await utimes(directory, new Date(0), new Date(0))
  }
  await worker(fixture.state, "root", "worker")
  await fixture.runtime.prepare(context("worker"), "default", "diagnostics", "Inspect network")
  assert.ok((await readdir(root)).includes(path.basename(liveDirectory)))
  assert.equal((await readdir(root)).includes(path.basename(closedDirectory)), false)
  await assert.rejects(fixture.runtime.execute("devtools", "get_network_request", { responseFilePath: "../../private.txt" }, context("worker"), async () => ({ content: "bad" })), /artifact_path_denied/)
  const result = await fixture.runtime.execute("devtools", "take_snapshot", {}, context("worker"), async () => ({ content: "x".repeat(2000) }))
  assert.equal(result.metadata?.truncated, true)
  assert.match(String(result.content), /cleanup on a later prepare/)
  await fixture.runtime.dispose()
})
test("launch commands resolve pinned local entries and disable optional DevTools telemetry", () => {
  assert.ok(backendEntry("playwright")); assert.ok(backendEntry("devtools"))
  for (const backend of ["playwright", "devtools"] as const) {
    const command = backendCommand(backend, "http://127.0.0.1:1234", browserConfigSchema.parse({ mode: "auto" }), "C:/private artifacts")
    assert.equal(command.some((part) => part.includes("@latest") || part === "npx"), false)
    assert.equal(command.includes("--isolated"), false)
    if (backend === "devtools") { assert.ok(command.includes("--no-usage-statistics")); assert.ok(command.includes("--no-performance-crux")); assert.ok(command.includes("--redact-network-headers")) }
  }
})
test("diagnostics accept only safe snapshot fields and closed failure codes", async () => {
  const fixture = await setup()
  const file = path.join(fixture.directory, "status.json")
  await writeFile(file, JSON.stringify({ updatedAt: Date.now(), status: { connected: { playwright: true }, lastFailure: "cookie=password https://secret.invalid", url: "secret", authorization: "secret" } }))
  const safe = await refreshBrowserStatus(await fixture.runtime.status(), file)
  assert.equal(safe.lastFailure, undefined)
  assert.equal(JSON.stringify(safe).includes("secret"), false)
})
