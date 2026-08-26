import type { OrchestraConfig } from "../config/schema.js"
import { createJudgeAgent } from "./judge.js"
import { createMergeAgent } from "./merge.js"
import { createLeadAgent } from "./lead.js"
import type { AgentSet } from "./types.js"
import { createWorkerAgents } from "./workers.js"
import { createEditorAgent } from "./editor.js"
import { createIntegratorAgent } from "./integrator.js"

export interface PromptBundle {
  lead: string
  judge: string
  [name: string]: string
}

export function createAgentSet(config: OrchestraConfig, prompts: PromptBundle): AgentSet {
  const agents: AgentSet = {
    "orch-lead": createLeadAgent(config, prompts.lead),
    ...createWorkerAgents(config, prompts),
    "orch-editor": createEditorAgent(config, prompts.editor),
    "orch-integrator": createIntegratorAgent(config, prompts.integrator),
    "orch-merge": createMergeAgent(config, prompts.merge),
    "orch-judge": createJudgeAgent(config, prompts.judge),
  }
  for (const [name, model] of Object.entries(config.models.agents)) {
    if (agents[name]) agents[name].model = model
  }
  return agents
}
