import path from "node:path"

export function classifyLoopReply(text: string): { kind: "done" | "more" | "unknown"; detail: string } {
  const lines = text.trim().split(/\r?\n/)
  let fenced = false
  for (const line of lines.slice(0, -1)) if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
  const match = fenced ? null : lines.at(-1)?.match(/^(DONE|MORE): ([^\r\n]+)$/)
  if (!match?.[2]?.trim()) return { kind: "unknown", detail: text.trim() }
  return { kind: match[1] === "DONE" ? "done" : "more", detail: match[2].trim() }
}

export function resolveLoopGoal(value: string): string {
  const goal = value.trim()
  if (!goal) throw new Error("Usage: /loop <goal> or /loop --file <workspace-relative.md>; /loop stop; /loop status")
  if (!goal.startsWith("--file ")) return goal
  const file = goal.slice(7).trim()
  if (!file.endsWith(".md") || path.isAbsolute(file) || /^[A-Za-z]:/.test(file) || file.includes("\\") || file.split("/").includes("..")) {
    throw new Error("Loop plan must be a workspace-relative .md path without parent traversal.")
  }
  return `Read the workspace-relative Markdown plan ${JSON.stringify(file)} using OpenCode's permissioned read tool. Do not read outside the workspace, including symlink targets. If reading fails or permission is required, stop and explain; do not guess the contents. Execute that plan.`
}

export function normalizeLoopReason(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
}

export function loopPrompt(goal: string): string {
  return `Execute one bounded iteration using orch-lead. Goal:\n${goal}\n\nRun appropriate verification through normal permissioned tools and report its actual results. Never claim verification solely from this protocol. If complete, end with the unquoted final line DONE: <summary>. If safe autonomous work remains, end with MORE: <remaining work>. If blocked, asking a question, or waiting for permission, do not use either marker.`
}
