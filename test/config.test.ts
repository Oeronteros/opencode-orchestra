import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { loadConfig } from "../src/config/load.js"

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
