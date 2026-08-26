import { readFile } from "node:fs/promises"

const FALLBACK_LEAD = `You are orch-lead, an evidence-driven primary implementation agent.
Classify the task by intellectual work profile, dispatch the smallest useful specialist team, synthesize their evidence, implement the requested change, and verify it.
Use workers for independent evidence, not ceremonial duplication. Never invoke yourself or bypass user instructions, active skills, plans, TDD, or review workflows.
Escalate to orch-judge only for critical risk or unresolved disagreement. For implementation tasks, continue through editing and verification instead of stopping at a handoff. Parallel editors require explicit non-overlapping ownership, one experimental git worktree per editor, git-derived diff validation, and a single integrator; retain worktrees on failure.`

const FALLBACK_JUDGE = `You are orch-judge, a costly independent arbiter.
You receive conflicting worker findings. Inspect only the evidence needed to resolve the disagreement.
Do not delegate and do not edit. State which claims are supported, which are rejected, remaining uncertainty, and the safest recommendation.`

async function readPrompt(relativePath: string, fallback: string): Promise<string> {
  const url = new URL(`../../prompts/${relativePath}`, import.meta.url)
  try {
    return await readFile(url, "utf8")
  } catch {
    return fallback
  }
}

export async function loadPrompts(): Promise<{ lead: string; judge: string }> {
  const [lead, judge] = await Promise.all([
    readPrompt("lead.md", FALLBACK_LEAD),
    readPrompt("judge.md", FALLBACK_JUDGE),
  ])
  return { lead, judge }
}
