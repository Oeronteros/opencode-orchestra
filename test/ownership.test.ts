import assert from "node:assert/strict"
import test from "node:test"
import { normalizeOwnedPath, validateChangedFiles, validateOwnership } from "../src/orchestration/ownership.js"

test("normalizes safe ownership paths", () => { assert.equal(normalizeOwnedPath("./src\api/"), "src/api") })
test("rejects unsafe ownership paths", () => { for (const path of ["", "../src", "/src", "C:/src", "a\0b"]) assert.throws(() => normalizeOwnedPath(path)) })
test("detects overlaps on path boundaries", () => { assert.ok(validateOwnership([{ id:"a", paths:["src"] },{ id:"b", paths:["src/api"] }]).length); assert.deepEqual(validateOwnership([{ id:"a", paths:["src/a"] },{ id:"b", paths:["src/ab"] }]), []) })
test("rejects changes outside exclusive ownership", () => { const partitions=[{id:"a",paths:["src/a"]},{id:"b",paths:["src/b"]}]; assert.deepEqual(validateChangedFiles(partitions,{a:["src/a/x.ts"],b:["src/b/y.ts"]}),[]); assert.ok(validateChangedFiles(partitions,{a:["src/b/y.ts"]}).length) })
