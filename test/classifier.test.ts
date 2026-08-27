import assert from "node:assert/strict"
import test from "node:test"
import { classifyTask } from "../src/routing/classifier.js"
import type { ProfileName } from "../src/config/schema.js"

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

interface GoldenCase {
  name: string
  task: string
  profile: ProfileName
}

const goldenCases: GoldenCase[] = [
  { name: "architecture", task: "Design the architecture for module boundaries and API integration", profile: "architecture" },
  { name: "debug", task: "Debug the bug that causes a crash and exception", profile: "debug" },
  { name: "ui", task: "Improve the dashboard UI layout with responsive components and animations", profile: "ui" },
  { name: "research", task: "Research and compare libraries, investigate and find examples in the documentation", profile: "research" },
  { name: "review", task: "Review the pull request diff for code quality", profile: "review" },
  { name: "security", task: "Fix the security vulnerability with XSS injection in the auth token", profile: "security" },
  { name: "performance", task: "Optimize performance to reduce latency, memory and CPU throughput", profile: "performance" },
  { name: "migration", task: "Migrate and upgrade the service and port it to the new version", profile: "migration" },
  { name: "ops", task: "Deploy the docker container to kubernetes via the CI/CD pipeline", profile: "ops" },
]

for (const golden of goldenCases) {
  test(`golden: ${golden.name} task routes to ${golden.profile}`, () => {
    const result = classifyTask(golden.task)

    assert.equal(
      result.profile,
      golden.profile,
      `task "${golden.task}" -> expected ${golden.profile}, got ${result.profile}`,
    )
    assert.equal(result.fallback, false, `task "${golden.task}" should not fall back to a default profile`)
  })
}

interface ConfusionCase {
  name: string
  task: string
  profile: ProfileName
  notProfile: ProfileName
}

const confusionCases: ConfusionCase[] = [
  { name: "debug vs architecture", task: "Debug the 502 error from the database API", profile: "debug", notProfile: "architecture" },
  { name: "security vs generic review", task: "Security review of the pull request diff", profile: "security", notProfile: "review" },
  { name: "ui vs research", task: "Compare dashboard UI layouts and find examples for the interface", profile: "ui", notProfile: "research" },
  { name: "migration vs ops", task: "Migrate the docker deployment to the new version", profile: "migration", notProfile: "ops" },
]

for (const confusion of confusionCases) {
  test(`confusion: ${confusion.name} routes to ${confusion.profile}, not ${confusion.notProfile}`, () => {
    const result = classifyTask(confusion.task)

    assert.equal(
      result.profile,
      confusion.profile,
      `task "${confusion.task}" -> expected ${confusion.profile}, got ${result.profile}`,
    )
    assert.notEqual(
      result.profile,
      confusion.notProfile,
      `task "${confusion.task}" must not be classified as ${confusion.notProfile}`,
    )
  })
}
