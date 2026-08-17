import assert from "node:assert/strict"
import test from "node:test"
import { classifyTask } from "../src/routing/classifier.js"

test("classifies a mixed authentication incident as debug with security relevance", () => {
  const result = classifyTask("Авторизация иногда разлогинивает пользователей: проверь cookie и token")

  assert.equal(result.profile, "debug")
  assert.equal(result.securityRelevant, true)
  assert.ok(result.secondaryProfiles.includes("security"))
  assert.ok(result.confidence >= 0.7)
})

test("honors disabled profiles", () => {
  const result = classifyTask("Redesign the responsive dashboard UI", { ui: false })

  assert.notEqual(result.profile, "ui")
})

test("falls back to architecture for an unclassified build task", () => {
  const result = classifyTask("Make the requested feature")

  assert.equal(result.profile, "architecture")
  assert.equal(result.confidence, 0.45)
})
