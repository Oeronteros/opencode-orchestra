import type { OrchestraConfig } from "../config/schema.js"
import { createJudgeAgent } from "./judge.js"
import { createMergeAgent } from "./merge.js"
import { createLeadAgent } from "./lead.js"
import type { AgentSet } from "./types.js"
import { createWorkerAgents } from "./workers.js"

export interface PromptBundle {
  lead: string
  judge: string
}

export function createAgentSet(config: OrchestraConfig, prompts: PromptBundle): AgentSet {
  const agents: AgentSet = {
    "orch-lead": createLeadAgent(config, prompts.lead),
    ...createWorkerAgents(config),
    "orch-merge": createMergeAgent(config),
    "orch-judge": createJudgeAgent(config, prompts.judge),
  }
  for (const [name, model] of Object.entries(config.models.agents)) {
    if (agents[name]) agents[name].model = model
  }
  return agents
}
