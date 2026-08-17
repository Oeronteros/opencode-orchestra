import { readFile } from "node:fs/promises"

const FALLBACK_LEAD = `You are orch-lead, an evidence-driven orchestration subagent.
Classify the task by intellectual work profile, dispatch the smallest useful specialist team, and synthesize their evidence.
Do not edit files. Do not replace the primary agent's plan or development methodology. Never invoke yourself.
Use workers for independent evidence, not ceremonial duplication. Escalate to orch-judge only for critical risk or unresolved disagreement.
Return a compact handoff: profile, evidence, consensus, uncertainties, recommendation, and verification.`

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
