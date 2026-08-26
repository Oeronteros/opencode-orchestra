import assert from "node:assert/strict"
import test from "node:test"
import { createAgentSet } from "../src/agents/build.js"
import { orchestraConfigSchema } from "../src/config/schema.js"
import { loadPrompts } from "../src/prompts/load.js"

const prompts = { lead: "Lead prompt", judge: "Judge prompt" }

test("builds a selectable primary lead and hidden workers", () => {
  const config = orchestraConfigSchema.parse({})
  const agents = createAgentSet(config, prompts)

  assert.equal(agents["orch-lead"]?.hidden, false)
  assert.equal(agents["orch-lead"]?.mode, "primary")
  assert.equal(agents["orch-repo"]?.hidden, true)
  assert.equal(agents["orch-judge"]?.hidden, true)
  assert.equal(agents["orch-merge"]?.hidden, true)
  assert.equal(agents["orch-editor"]?.hidden, true)
  assert.equal(agents["orch-editor"]?.permission.edit, "allow")
  assert.equal(agents["orch-editor"]?.permission.bash, "allow")
  assert.equal(agents["orch-editor"]?.permission.task, "deny")
  assert.equal(agents["orch-integrator"]?.hidden, true)
  assert.equal(agents["orch-integrator"]?.permission.task, "deny")
  assert.equal(agents["orch-integrator"]?.permission.edit, "deny")
  assert.equal(agents["orch-merge"]?.permission.task, "deny")
  assert.equal(agents["orch-repo"]?.permission.task, "deny")
})

test("lead can invoke Orchestra workers but workers cannot delegate", () => {
  const config = orchestraConfigSchema.parse({})
  const agents = createAgentSet(config, prompts)
  const taskPermission = agents["orch-lead"]?.permission.task

  assert.equal(typeof taskPermission, "object")
  assert.equal((taskPermission as Record<string, string>)["*"], "deny")
  assert.equal((taskPermission as Record<string, string>)["orch-repo"], "allow")
  assert.equal((taskPermission as Record<string, string>)["orch-merge"], "allow")
  assert.equal((taskPermission as Record<string, string>)["orch-editor"], "allow")
  assert.equal((taskPermission as Record<string, string>)["orch-integrator"], "allow")
  assert.equal((taskPermission as Record<string, string>)["orch-judge"], "allow")
  assert.equal(agents["orch-lead"]?.permission.edit, "allow")
  assert.equal(agents["orch-lead"]?.permission.bash, "ask")
  assert.equal(agents["orch-lead"]?.permission["memorygraph_*"], "allow")
  assert.equal(agents["orch-repo"]?.permission["codebase_memory_*"], "allow")
  assert.equal(agents["orch-tests"]?.permission.bash, "allow")
  assert.equal(agents["orch-lead"]?.permission["supermemory_*"], undefined)
})

test("assigns configured models through pools", () => {
  const config = orchestraConfigSchema.parse({
    models: {
      lead: [{ id: "go/lead", cost: "subscription", tier: "lead", capabilities: ["reasoning"] }],
      worker: { code: ["anymodel/code"] },
      judge: [{ id: "frontier/judge", cost: "paid", tier: "frontier", capabilities: ["review"] }],
    },
  })
  const agents = createAgentSet(config, prompts)

  assert.equal(agents["orch-lead"]?.model, "go/lead")
  assert.equal(agents["orch-repo"]?.model, "anymodel/code")
  assert.equal(agents["orch-judge"]?.model, "frontier/judge")
})

test("per-agent model override wins over a pool", () => {
  const config = orchestraConfigSchema.parse({
    models: {
      agents: { "orch-repo": "exact/repo-model" },
      worker: { code: ["pool/code-model"] },
    },
  })
  const agents = createAgentSet(config, prompts)

  assert.equal(agents["orch-repo"]?.model, "exact/repo-model")
  assert.equal(agents["orch-tests"]?.model, "pool/code-model")
})

test("balanced uses a subscription lead, free worker, and frontier judge", () => {
  const config = orchestraConfigSchema.parse({
    budget: "balanced",
    models: {
      lead: [
        { id: "vendor/free-lead", cost: "free", tier: "lead", priority: 60, capabilities: ["reasoning"] },
        { id: "vendor/sub-lead", cost: "subscription", tier: "lead", priority: 60, capabilities: ["reasoning"] },
      ],
      worker: {
        code: [
          { id: "vendor/free-worker", cost: "free", tier: "worker", priority: 40, capabilities: ["code"] },
          { id: "vendor/paid-worker", cost: "paid", tier: "frontier", priority: 100, capabilities: ["code"] },
        ],
      },
      judge: [
        { id: "vendor/lead-judge", cost: "subscription", tier: "lead", priority: 60, capabilities: ["review"] },
        { id: "vendor/frontier-judge", cost: "paid", tier: "frontier", priority: 50, capabilities: ["review"] },
      ],
    },
  })
  const agents = createAgentSet(config, prompts)

  assert.equal(agents["orch-lead"]?.model, "vendor/sub-lead")
  assert.equal(agents["orch-repo"]?.model, "vendor/free-worker")
  assert.equal(agents["orch-judge"]?.model, "vendor/frontier-judge")
})

test("loads external specialist prompts and safely falls back for missing names", async () => {
  const loaded = await loadPrompts([
    "lead", "judge", "repo", "docs", "research", "tests", "critic", "security",
    "visual-reference", "visual-generate", "visual-review", "editor", "integrator", "merge", "missing",
  ])

  assert.match(loaded.repo ?? "", /Return exactly:/)
  assert.match(loaded.security ?? "", /Attack path/)
  assert.match(loaded.merge ?? "", /orchestration_report/)
  assert.match(loaded.editor ?? "", /ownership partition/)
  assert.match(loaded.missing ?? "", /internal specialist agent/)
})

test("agent constructions use external contracts without changing names or permissions", async () => {
  const config = orchestraConfigSchema.parse({ orchestration: { exposeWorkers: true } })
  const loaded = await loadPrompts([
    "lead", "judge", "repo", "docs", "research", "tests", "critic", "security",
    "visual-reference", "visual-generate", "visual-review", "editor", "integrator", "merge",
  ])
  const agents = createAgentSet(config, loaded)

  assert.match(agents["orch-repo"]?.prompt ?? "", /Return exactly:/)
  assert.match(agents["orch-editor"]?.prompt ?? "", /Base revision and commit/)
  assert.match(agents["orch-integrator"]?.prompt ?? "", /ownership validation/)
  assert.match(agents["orch-merge"]?.prompt ?? "", /exactly once.*consensus/s)
  assert.equal(agents["orch-tests"]?.permission.bash, "allow")
  assert.equal(agents["orch-repo"]?.hidden, false)
})
