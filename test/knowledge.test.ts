import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { VerifiedKnowledgeStore } from "../src/knowledge/store.js"
import type { GitRunner } from "../src/orchestration/worktrees.js"

test("verified knowledge keeps provenance and becomes stale when referenced paths change", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-knowledge-"))
  let revision = "aaaaaaaa"
  const git: GitRunner = { async run(args) {
    if (args[0] === "rev-parse") return { stdout: `${revision}\n`, stderr: "", exitCode: 0 }
    if (args[0] === "status" || args[0] === "diff") return { stdout: "", stderr: "", exitCode: 0 }
    return { stdout: "", stderr: "unknown", exitCode: 1 }
  } }
  try {
    await mkdir(path.join(directory, "src"), { recursive: true })
    await writeFile(path.join(directory, "src", "cache.ts"), "export const cache = true\n")
    const store = new VerifiedKnowledgeStore(directory, ".orchestra/knowledge", true, 8, git)
    const entry = await store.record({
      kind: "test-command", value: "npm test -- cache", evidence: ["12 cache tests passed"], paths: ["src/cache.ts"],
      sourceRun: "run-1", sourcePlanVersion: 2,
    })
    assert.equal(entry.revision, "aaaaaaaa")
    assert.equal((await store.query("cache", ["src/cache.ts"]))[0]?.status, "valid")
    revision = "bbbbbbbb"
    assert.equal((await store.query("cache"))[0]?.status, "valid")
    await writeFile(path.join(directory, "src", "cache.ts"), "export const cache = false\n")
    assert.equal((await store.query("cache"))[0]?.staleReason, "referenced path content changed after verification")
    await assert.rejects(store.record({ kind: "decision", value: "bad", evidence: ["x"], paths: ["../outside"], sourceRun: "run", sourcePlanVersion: 1 }), /inside the repository/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
