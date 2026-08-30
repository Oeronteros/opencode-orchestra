import assert from "node:assert/strict"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { OrchestraPlugin } from "../src/index.js"
import { integrateValidatedCommits, systemGit } from "../src/orchestration/worktrees.js"

/**
 * End-to-end integration test that drives the full plugin pipeline with a
 * mock provider catalog. This is a "real run" in the sense that it exercises
 * the same entry point OpenCode invokes — `OrchestraPlugin` — rather than
 * individual pure functions. Only the network boundary (`client.provider.list`
 * and app logging) is stubbed.
 */

interface DiscoveredRunResult {
  agents: Record<string, { model?: string; mode: string }>
  commands: Record<string, { template: string }>
  tools: Record<string, unknown>
  service: Array<{ level: string; message: string; extra: Record<string, unknown> }>
}

const EMPTY_CONFIG = path.join(process.cwd(), "test", "fixtures", "empty-orchestra.jsonc")

/** Build a mock provider catalog that yields one reasoning model and one code model. */
const MOCK_CATALOG = {
  data: {
    connected: ["mockvendor"],
    all: [
      {
        id: "mockvendor",
        models: {
          "reasoner-pro": {
            id: "reasoner-pro",
            reasoning: true,
            tool_call: true,
            cost: { input: 2, output: 4 },
            limit: { context: 250_000, output: 64_000 },
            modalities: { input: ["text"], output: ["text"] },
          },
          "reasoner-lite": {
            id: "reasoner-lite",
            reasoning: true,
            tool_call: true,
            cost: { input: 0, output: 0 },
            limit: { context: 128_000, output: 32_000 },
            modalities: { input: ["text"], output: ["text"] },
          },
          "coder-lite": {
            id: "coder-lite",
            reasoning: false,
            tool_call: true,
            cost: { input: 0, output: 0 },
            limit: { context: 64_000, output: 16_000 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
      { id: "offline-vendor", models: { "never": { id: "never" } } },
    ],
  },
}

async function initializePlugin(
  client: Record<string, unknown>,
  options: Record<string, unknown> = {},
) {
  const initialize = OrchestraPlugin as unknown as (
    input: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
  // Integration tests exercise the full plugin pipeline, but must not inherit
  // the developer's global or project-level Orchestra model assignments.
  return initialize({ directory: process.cwd(), client }, { ...options, configFile: EMPTY_CONFIG })
}

function mockClient(logs: Array<{ level: string; message: string; extra: Record<string, unknown> }>) {
  return {
    app: {
      log: async (input: { body: { level: string; message: string; extra: Record<string, unknown> } }) => {
        logs.push(input.body)
        return undefined
      },
    },
    provider: { list: async () => MOCK_CATALOG },
  }
}

test("full plugin run discovers mock provider models and assigns them to agents", async () => {
  const logs: Array<{ level: string; message: string; extra: Record<string, unknown> }> = []
  const hooks = await initializePlugin(mockClient(logs), { telemetry: { enabled: false } })

  const runtime: Record<string, unknown> = {}
  await (hooks.config as (input: Record<string, unknown>) => Promise<void>)(runtime)

  // Assert the init log carried the discovered-model count, proving the API
  // call actually happened (not just a static fallback). If `provider.list`
  // were dropped, `discoveredModels` would be 0.
  const init = logs.find((entry) => entry.message === "OpenCode Orchestra initialized")
  assert.ok(init, "expected the plugin to emit an initialization log")
  assert.equal(init.extra.discoveredModels, 3, "three connected models should be discovered")

  const agents = runtime.agent as Record<string, { model?: string; mode: string }>
  assert.equal(agents["orch-lead"]?.mode, "primary")
  // Auto strategy + empty manual pools should be filled from discovery.
  assert.ok(agents["orch-lead"]?.model?.startsWith("mockvendor/"), "lead should resolve to a discovered mock model")
  assert.ok(agents["orch-repo"]?.model?.startsWith("mockvendor/"), "code worker should resolve to a discovered mock model")

  const commands = runtime.command as Record<string, { template: string }>
  assert.ok(commands["orchestra-status"]?.template.includes("orchestra_status"))

  const tools = hooks.tool as Record<string, unknown>
  assert.ok(tools.orchestra_route, "orchestra_route tool should be registered")
})

test("manual strategy keeps explicit pools and ignores the mock provider", async () => {
  const logs: Array<{ level: string; message: string; extra: Record<string, unknown> }> = []
  const hooks = await initializePlugin(mockClient(logs), {
    telemetry: { enabled: false },
    models: {
      strategy: "manual",
      lead: ["explicit/lead-model"],
      worker: { code: ["explicit/code-model"] },
    },
  })

  const runtime: Record<string, unknown> = {}
  await (hooks.config as (input: Record<string, unknown>) => Promise<void>)(runtime)

  const agents = runtime.agent as Record<string, { model?: string }>
  assert.equal(agents["orch-lead"]?.model, "explicit/lead-model")
  assert.equal(agents["orch-repo"]?.model, "explicit/code-model")
})

test("plugin preserves lead edit access over an inherited agent denial", async () => {
  const logs: Array<{ level: string; message: string; extra: Record<string, unknown> }> = []
  const hooks = await initializePlugin(mockClient(logs), { telemetry: { enabled: false } })
  const runtime: Record<string, unknown> = {
    agent: {
      "orch-lead": { permission: { edit: "deny", bash: "ask" } },
    },
  }

  await (hooks.config as (input: Record<string, unknown>) => Promise<void>)(runtime)

  const agents = runtime.agent as Record<string, { permission: Record<string, unknown> }>
  assert.equal(agents["orch-lead"]?.permission.edit, "allow")
  assert.equal(agents["orch-lead"]?.permission.bash, "ask")
})

test("route tool runs the full routing pipeline against discovered models", async () => {
  const logs: Array<{ level: string; message: string; extra: Record<string, unknown> }> = []
  const hooks = await initializePlugin(mockClient(logs), {
    budget: "balanced",
    telemetry: { enabled: false },
  })

  const route = (hooks.tool as Record<string, unknown>).orchestra_route as {
    execute: (args: { task: string }, context: Record<string, unknown>) => Promise<string>
  }
  const result = JSON.parse(
    await route.execute({ task: "Fix the intermittent 502 bug in the login flow" }, {}),
  ) as {
    profile: string
    workers: string[]
    parallelWorkers: number
    paidBudget: { enabled: boolean }
    plan: { nodes: Array<{ worker: string }> }
    escalation: { escalate: boolean }
  }

  // Debug signal wins (bug, 502, intermittent bonus), and debug profile workers
  // are orch-repo, orch-tests, orch-critic.
  assert.equal(result.profile, "debug")
  assert.ok(result.workers.includes("orch-repo"))
  assert.ok(result.workers.includes("orch-tests"))
  assert.ok(result.parallelWorkers >= 1)
  // balanced enables a paid-call guard but caps it at one per branch.
  assert.equal(result.paidBudget.enabled, true)
  // A non-critical, high-confidence task should not escalate under balanced.
  assert.equal(result.escalation.escalate, false)
  assert.ok(result.plan.nodes.length > 0)
})

test("simulated git conflict rejects without destructive worktree cleanup", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "orch-conflict-"))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const repo = path.join(root, "repo")
  await mkdir(repo, { recursive: true })

  await systemGit.run(["init", "-b", "main"], repo)
  await systemGit.run(["config", "user.email", "test@example.com"], repo)
  await systemGit.run(["config", "user.name", "Orchestra Test"], repo)
  await systemGit.run(["config", "commit.gpgsign", "false"], repo)
  // Windows git defaults to core.autocrlf=true, which rewrites working-tree
  // files as CRLF on checkout/abort and breaks the byte-exact content
  // assertions below. Disable eol conversion for this fixture repo.
  await systemGit.run(["config", "core.autocrlf", "false"], repo)

  const shared = path.join(repo, "shared.txt")
  await writeFile(shared, "base\n")
  await systemGit.run(["add", "shared.txt"], repo)
  await systemGit.run(["commit", "-m", "base"], repo)

  // A feature branch edits the same line the main branch will later change.
  await systemGit.run(["checkout", "-b", "feature"], repo)
  await writeFile(shared, "feature\n")
  await systemGit.run(["add", "shared.txt"], repo)
  await systemGit.run(["commit", "-m", "feature change"], repo)
  const feature = (await systemGit.run(["rev-parse", "HEAD"], repo)).stdout.trim()

  // Main diverges with a conflicting edit to the same line.
  await systemGit.run(["checkout", "main"], repo)
  await writeFile(shared, "main\n")
  await systemGit.run(["add", "shared.txt"], repo)
  await systemGit.run(["commit", "-m", "main change"], repo)

  // A worktree artifact that must survive a failed integration attempt.
  const worktreeMarker = path.join(root, ".orchestra", "worktrees", "task-a", "marker.txt")
  await mkdir(path.dirname(worktreeMarker), { recursive: true })
  await writeFile(worktreeMarker, "keep\n")

  await assert.rejects(
    () => integrateValidatedCommits(systemGit, repo, [feature]),
    /cherry-pick conflict/,
  )

  // No destructive cleanup: the repo is intact, the aborted cherry-pick restored
  // the pre-integration state, and the retained worktree artifact is untouched.
  await access(repo)
  assert.equal(await readFile(shared, "utf8"), "main\n")
  assert.equal(await readFile(worktreeMarker, "utf8"), "keep\n")
})
