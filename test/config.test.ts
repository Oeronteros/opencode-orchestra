import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { loadConfig } from "../src/config/load.js"
import { orchestraConfigSchema } from "../src/config/schema.js"

test("config discovery layers global, preferred project JSONC, and options", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-config-"))
  const global = path.join(root, "global")
  const project = path.join(root, "project")
  await mkdir(path.join(global, "opencode"), { recursive: true })
  await mkdir(path.join(project, ".opencode"), { recursive: true })
  await writeFile(path.join(global, "opencode", "orchestra.jsonc"), '{"budget":"eco","orchestration":{"maxWorkers":2}}')
  await writeFile(path.join(project, ".opencode", "orchestra.json"), '{"budget":"quality"}')
  await writeFile(path.join(project, ".opencode", "orchestra.jsonc"), '{"budget":"balanced","orchestration":{"parallelWorkers":4}}')
  const previous = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = global
  try {
    const loaded = await loadConfig(project, { budget: "ebobo" })
    assert.equal(loaded.config.budget, "ebobo")
    assert.equal(loaded.config.orchestration.maxWorkers, 2)
    assert.equal(loaded.config.orchestration.parallelWorkers, 4)
    assert.ok(loaded.source?.includes("orchestra.jsonc"))
    assert.equal(loaded.source?.includes("orchestra.json ->"), false)
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
  }
})

test("explicit config path is resolved from project", async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), "orchestra-explicit-"))
  await writeFile(path.join(project, "custom.jsonc"), '{// comment\n"budget":"quality",}')
  const loaded = await loadConfig(project, { configFile: "custom.jsonc" })
  assert.equal(loaded.config.budget, "quality")
  assert.equal(loaded.source, path.join(project, "custom.jsonc"))
})

test("orchestration agent limits have shared defaults and strict bounds", () => {
  for (const input of [{}, { orchestration: {} }]) {
    const orchestration = orchestraConfigSchema.parse(input).orchestration
    assert.equal(orchestration.parallelWorkers, 8)
    assert.equal(orchestration.maxWorkers, 8)
    assert.equal(orchestration.parallelEditors, 0)
    assert.equal(orchestration.maxDelegationDepth, 2)
  }

  const configured = orchestraConfigSchema.parse({
    orchestration: { parallelWorkers: 1, parallelEditors: 8, maxWorkers: 1, maxDelegationDepth: 4, worktreeRoot: ".tmp/worktrees" },
  }).orchestration
  assert.equal(configured.parallelWorkers, 1)
  assert.equal(configured.parallelEditors, 8)
  assert.equal(configured.maxWorkers, 1)
  assert.equal(configured.maxDelegationDepth, 4)
  assert.equal(configured.worktreeRoot, ".tmp/worktrees")

  assert.throws(() => orchestraConfigSchema.parse({ orchestration: { parallelWorkers: 0 } }))
  assert.throws(() => orchestraConfigSchema.parse({ orchestration: { parallelWorkers: 9 } }))
  assert.throws(() => orchestraConfigSchema.parse({ orchestration: { parallelEditors: 9 } }))
  assert.throws(() => orchestraConfigSchema.parse({ orchestration: { parallelEditors: -1 } }))
  assert.throws(() => orchestraConfigSchema.parse({ orchestration: { maxWorkers: 0 } }))
  assert.throws(() => orchestraConfigSchema.parse({ orchestration: { maxWorkers: 9 } }))
  assert.throws(() => orchestraConfigSchema.parse({ orchestration: { maxDelegationDepth: 0 } }))
  assert.throws(() => orchestraConfigSchema.parse({ orchestration: { maxDelegationDepth: 5 } }))
  assert.throws(() => orchestraConfigSchema.parse({ orchestration: { maxDelegationDepth: 2.5 } }))
})

test("published JSON schema mirrors orchestration defaults and bounds", async () => {
  type NumericSchema = { type: "integer"; minimum: number; maximum: number; default: number }
  const published = JSON.parse(
    await readFile(path.resolve("schema/opencode-orchestra.schema.json"), "utf8"),
  ) as { properties: { orchestration: { properties: Record<string, NumericSchema> } } }
  const properties = published.properties.orchestration.properties

  assert.deepEqual(properties.parallelWorkers, { type: "integer", minimum: 1, maximum: 8, default: 8 })
  assert.deepEqual(properties.parallelEditors, { type: "integer", minimum: 0, maximum: 8, default: 0 })
  assert.deepEqual(properties.maxWorkers, { type: "integer", minimum: 1, maximum: 8, default: 8 })
  assert.deepEqual(properties.maxDelegationDepth, { type: "integer", minimum: 1, maximum: 4, default: 2 })
})

test("automatic permission acceptance is explicit and disabled by default", () => {
  assert.equal(orchestraConfigSchema.parse({}).permissions.autoAcceptAll, false)
  assert.equal(orchestraConfigSchema.parse({ permissions: { autoAcceptAll: true } }).permissions.autoAcceptAll, true)
  assert.throws(() => orchestraConfigSchema.parse({ permissions: { autoAcceptAll: "yes" } }))
})

test("per-agent fallback chains are ordered, bounded, and backward compatible", () => {
  const defaults = orchestraConfigSchema.parse({})
  assert.deepEqual(defaults.models.fallback, { enabled: true, maxRetries: 2, agents: {} })

  const configured = orchestraConfigSchema.parse({
    models: {
      fallback: {
        enabled: true,
        maxRetries: 2,
        agents: { "orch-repo": ["openai/gpt-5", "google/gemini-pro"] },
      },
    },
  })
  assert.deepEqual(configured.models.fallback.agents["orch-repo"], ["openai/gpt-5", "google/gemini-pro"])
  assert.throws(() => orchestraConfigSchema.parse({ models: { fallback: { agents: { "orch-repo": ["openai/gpt-5", "openai/gpt-5"] } } } }))
  assert.throws(() => orchestraConfigSchema.parse({ models: { fallback: { agents: { "orch-repo": Array.from({ length: 6 }, (_, index) => `vendor/model-${index}`) } } } }))
})
