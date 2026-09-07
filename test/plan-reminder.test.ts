import assert from "node:assert/strict"
import test from "node:test"
import { PLAN_TRANSITION_REMINDER, releasePlanMode, type ReminderMessage } from "../src/routing/plan-reminder.js"

function messages(lastAgent = "orch-lead"): ReminderMessage[] {
  return [
    { info: { role: "user", agent: "plan", sessionID: "ses_1" }, parts: [{ type: "text", text: "Plan this work." }] },
    { info: { role: "assistant", agent: "plan", sessionID: "ses_1" }, parts: [{ type: "text", text: "Here is the plan." }] },
    { info: { role: "user", agent: lastAgent, sessionID: "ses_1" }, parts: [{ type: "text", text: "Now implement it." }] },
  ]
}

test("releasePlanMode injects the transition reminder for orch-lead after a plan turn", () => {
  const conversation = messages()
  assert.equal(releasePlanMode(conversation), true)
  const lastUser = conversation.at(-1)!
  assert.equal(lastUser.parts.at(-1)?.text, PLAN_TRANSITION_REMINDER)
})

test("releasePlanMode leaves non-lead agents untouched", () => {
  const conversation = messages("build")
  assert.equal(releasePlanMode(conversation), false)
  assert.equal(conversation.at(-1)!.parts.length, 1)
})

test("releasePlanMode does nothing without plan-agent history", () => {
  const conversation = [
    { info: { role: "user", agent: "orch-lead", sessionID: "ses_1" }, parts: [{ type: "text", text: "Fix it." }] },
    { info: { role: "assistant", agent: "orch-lead", sessionID: "ses_1" }, parts: [{ type: "text", text: "Done." }] },
    { info: { role: "user", agent: "orch-lead", sessionID: "ses_1" }, parts: [{ type: "text", text: "Now adjust it." }] },
  ]
  assert.equal(releasePlanMode(conversation), false)
  assert.equal(conversation.at(-1)!.parts.length, 1)
})

test("releasePlanMode skips when a transition reminder is already present", () => {
  const conversation = messages()
  conversation.at(-1)!.parts.push({ type: "text", text: "Your operational mode has changed from plan to build." })
  assert.equal(releasePlanMode(conversation), false)
  assert.equal(conversation.at(-1)!.parts.length, 2)
})

test("releasePlanMode is a no-op without a user message", () => {
  assert.equal(releasePlanMode([]), false)
  assert.equal(releasePlanMode([{ info: { role: "assistant", agent: "plan" }, parts: [] }]), false)
})
