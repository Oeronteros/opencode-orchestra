import assert from "node:assert/strict"
import test from "node:test"
import { buildConflictReport, normalizeOwnedPath, validateChangedFiles, validateOwnership } from "../src/orchestration/ownership.js"

test("normalizes safe ownership paths", () => {
  assert.equal(normalizeOwnedPath(String.raw`./src\api/`), "src/api")
})

test("rejects unsafe ownership paths", () => {
  for (const value of ["", "../src", "/src", "C:/src", "a\0b"]) {
    assert.throws(() => normalizeOwnedPath(value))
  }
})

test("detects overlaps on path boundaries", () => {
  assert.ok(validateOwnership([
    { id: "a", paths: ["src"] },
    { id: "b", paths: ["src/api"] },
  ]).length)
  assert.deepEqual(validateOwnership([
    { id: "a", paths: ["src/a"] },
    { id: "b", paths: ["src/ab"] },
  ]), [])
})

test("rejects changes outside exclusive ownership", () => {
  const partitions = [{ id: "a", paths: ["src/a"] }, { id: "b", paths: ["src/b"] }]
  assert.deepEqual(validateChangedFiles(partitions, { a: ["src/a/x.ts"], b: ["src/b/y.ts"] }), [])
  assert.ok(validateChangedFiles(partitions, { a: ["src/b/y.ts"] }).length)
})

test("buildConflictReport flags files changed by multiple editors", () => {
  const partitions = [{ id: "a", paths: ["src/a"] }, { id: "b", paths: ["src/b"] }]
  const report = buildConflictReport(partitions, [
    { id: "a", commit: "a1", changed: ["src/shared.ts"] },
    { id: "b", commit: "b1", changed: ["src/shared.ts"] },
  ])
  assert.deepEqual(report.conflictingPaths, ["src/shared.ts"])
  assert.equal(report.clean, false)
  assert.deepEqual(report.order, ["a", "b"])
})

test("buildConflictReport does not treat src/a and src/ab as overlapping", () => {
  const partitions = [{ id: "a", paths: ["src/a"] }, { id: "b", paths: ["src/ab"] }]
  const report = buildConflictReport(partitions, [
    { id: "a", commit: "a1", changed: ["src/a/x.ts"] },
    { id: "b", commit: "b1", changed: ["src/ab/y.ts"] },
  ])
  assert.deepEqual(report.conflictingPaths, [])
  assert.deepEqual(report.ownershipViolations, [])
  assert.equal(report.clean, true)
})

test("buildConflictReport surfaces ownership violations per editor", () => {
  const partitions = [{ id: "a", paths: ["src/a"] }, { id: "b", paths: ["src/b"] }]
  const report = buildConflictReport(partitions, [
    { id: "a", commit: "a1", changed: ["src/b/y.ts"] },
    { id: "b", commit: "b1", changed: ["src/b/z.ts"] },
  ])
  assert.ok(report.ownershipViolations.some((violation) => violation.includes("not exclusively owned by a")))
  const editorA = report.editors.find((editor) => editor.id === "a")!
  assert.ok(editorA.violations.some((violation) => violation.includes("not exclusively owned by a")))
  assert.equal(report.clean, false)
})

test("buildConflictReport produces sorted deterministic editor order", () => {
  const partitions = [
    { id: "z", paths: ["src/z"] },
    { id: "a", paths: ["src/a"] },
    { id: "m", paths: ["src/m"] },
  ]
  const report = buildConflictReport(partitions, [
    { id: "m", commit: "m1", changed: ["src/m/x.ts"] },
    { id: "z", commit: "z1", changed: ["src/z/x.ts"] },
    { id: "a", commit: "a1", changed: ["src/a/x.ts"] },
  ])
  assert.deepEqual(report.order, ["a", "m", "z"])
  assert.deepEqual(report.editors.map((editor) => editor.id), ["a", "m", "z"])
})

test("buildConflictReport marks disjoint clean partitions as clean", () => {
  const partitions = [{ id: "a", paths: ["src/a"] }, { id: "b", paths: ["src/b"] }]
  const report = buildConflictReport(partitions, [
    { id: "a", commit: "a1", changed: ["src/a/x.ts"] },
    { id: "b", commit: "b1", changed: ["src/b/y.ts"] },
  ])
  assert.equal(report.clean, true)
  assert.deepEqual(report.conflictingPaths, [])
  assert.deepEqual(report.ownershipViolations, [])
  assert.deepEqual(report.editors.flatMap((editor) => editor.violations), [])
})

test("buildConflictReport merges changed paths across multiple commits of one editor", () => {
  const partitions = [{ id: "a", paths: ["src/a"] }, { id: "b", paths: ["src/b"] }]
  const report = buildConflictReport(partitions, [
    { id: "a", commit: "a1", changed: ["src/shared.ts"] },
    { id: "a", commit: "a2", changed: ["src/a/own.ts"] },
    { id: "b", commit: "b1", changed: ["src/shared.ts"] },
  ])
  assert.deepEqual(report.conflictingPaths, ["src/shared.ts"])
  assert.equal(report.clean, false)
})
