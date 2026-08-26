import { readFile } from "node:fs/promises"

const FALLBACK_LEAD = `You are orch-lead, an evidence-driven primary implementation agent.
Classify the task by intellectual work profile, dispatch the smallest useful specialist team, synthesize their evidence, implement the requested change, and verify it.
Use workers for independent evidence, not ceremonial duplication. Never invoke yourself or bypass user instructions, active skills, plans, TDD, or review workflows.
Escalate to orch-judge only for critical risk or unresolved disagreement. For implementation tasks, continue through editing and verification instead of stopping at a handoff. Parallel editors require explicit non-overlapping ownership, one experimental git worktree per editor, git-derived diff validation, and a single integrator; retain worktrees on failure.`

const FALLBACK_JUDGE = `You are orch-judge, a costly independent arbiter.
You receive conflicting worker findings. Inspect only the evidence needed to resolve the disagreement.
Do not delegate and do not edit. State which claims are supported, which are rejected, remaining uncertainty, and the safest recommendation.`

const FALLBACKS: Record<string, string> = { lead: FALLBACK_LEAD, judge: FALLBACK_JUDGE }

export async function readPrompt(relativePath: string, fallback = ""): Promise<string> {
  const urls = [
    new URL(`../../prompts/${relativePath}`, import.meta.url),
    // Tests run compiled sources from dist-test/, while published builds use dist/.
    new URL(`../../../prompts/${relativePath}`, import.meta.url),
  ]
  for (const url of urls) {
    try {
      return await readFile(url, "utf8")
    } catch {
      // Try the next package/source layout before using the inline fallback.
    }
  }
  return fallback
}

export type PromptBundle = Record<string, string> & { lead: string; judge: string }

/** Load named markdown prompts, falling back safely when package files are absent. */
export async function loadPrompts(names: string[] = Object.keys(FALLBACKS)): Promise<PromptBundle> {
  const entries = await Promise.all([...new Set(names)].map(async (name) => [
    name,
    await readPrompt(`${name}.md`, FALLBACKS[name] ?? "You are an internal specialist agent. Return concise, evidence-backed findings and do not edit or delegate."),
  ] as const))
  const prompts = Object.fromEntries(entries) as PromptBundle
  prompts.lead ??= FALLBACK_LEAD
  prompts.judge ??= FALLBACK_JUDGE
  return prompts
}
