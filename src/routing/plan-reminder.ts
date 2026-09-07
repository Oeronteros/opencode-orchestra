/**
 * Plan-mode handoff reminder.
 *
 * OpenCode's built-in plan agent appends a persisted read-only
 * system-reminder ("Plan mode ACTIVE ... STRICTLY FORBIDDEN ... overrides ALL
 * other instructions") to the user message it answers. When the session later
 * switches agents, OpenCode only counter-injects the plan→build transition
 * reminder for the built-in "build" agent, so custom primary agents such as
 * orch-lead keep reading the stale read-only constraint from the transcript
 * and refuse to implement. This module mirrors OpenCode's own transition
 * reminder for orch-lead whenever the conversation contains plan-agent turns.
 */

export const PLAN_TRANSITION_REMINDER = `<system-reminder>
Your operational mode has changed from plan to build.
You are no longer in read-only mode.
You are permitted to make file changes, run shell commands, and utilize your arsenal of tools as needed.
Earlier plan-mode reminders in this conversation applied only to the plan agent and are no longer active.
</system-reminder>`

export interface ReminderMessage {
  info: { role: string; agent?: string; sessionID?: string }
  parts: Array<{ type?: string; text?: string; synthetic?: boolean }>
}

const TRANSITION_MARKER = "operational mode has changed"

/**
 * Injects the plan→build transition reminder into the last user message when
 * the current turn is handled by orch-lead and the conversation contains
 * assistant turns from OpenCode's built-in plan agent. Mutates `messages` in
 * place, mirroring OpenCode's own behavior for the build agent. Returns true
 * when a reminder was injected.
 */
export function releasePlanMode(messages: ReminderMessage[]): boolean {
  const lastUser = [...messages].reverse().find((message) => message.info.role === "user")
  if (!lastUser || lastUser.info.agent !== "orch-lead") return false
  if (!messages.some((message) => message.info.role === "assistant" && message.info.agent === "plan")) return false
  if (lastUser.parts.some((part) => part.type === "text" && (part.text ?? "").includes(TRANSITION_MARKER))) return false
  lastUser.parts.push({ type: "text", text: PLAN_TRANSITION_REMINDER, synthetic: true })
  return true
}
