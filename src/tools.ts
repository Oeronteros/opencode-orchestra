import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { OrchestraConfig, ProfileName } from "./config/schema.js"
import { profileNameSchema } from "./config/schema.js"
import { PROFILE_CATALOG } from "./profiles/catalog.js"
import { classifyTask } from "./routing/classifier.js"
import { decideEscalation } from "./routing/escalation.js"
import type { Ledger } from "./telemetry/ledger.js"

interface ToolContextLike {
  sessionID?: string
}

export function createOrchestraTools(config: OrchestraConfig, ledger: Ledger): Record<string, ToolDefinition> {
  return {
    orchestra_route: tool({
      description: "Classify a complex task and return the recommended OpenCode Orchestra worker team for the active budget mode. This does not execute the team.",
      args: {
        task: tool.schema.string().min(1),
        profile: tool.schema.string().optional(),
      },
      async execute(args, context) {
        const requested = args.profile ? profileNameSchema.safeParse(args.profile) : undefined
        const automatic = classifyTask(args.task, config.orchestration.profiles)
        const profile: ProfileName = requested?.success ? requested.data : automatic.profile
        const classification = requested?.success
          ? { ...automatic, profile, confidence: 1, matchedSignals: ["explicit profile"] }
          : automatic
        const definition = PROFILE_CATALOG[profile]
        const enabledWorkers = Object.values(PROFILE_CATALOG)
          .filter((candidate) => config.orchestration.profiles[candidate.name] !== false)
          .flatMap((candidate) => candidate.workers)
        const workerPool = config.budget === "ebobo"
          ? Array.from(new Set(enabledWorkers))
          : definition.workers
        const workers = workerPool.slice(0, config.orchestration.maxWorkers)
        const escalation = decideEscalation(config, { classification })
        const sessionID = (context as ToolContextLike).sessionID
        if (sessionID) await ledger.setProfile(sessionID, profile)

        return JSON.stringify(
          {
            profile,
            secondaryProfiles: classification.secondaryProfiles,
            confidence: classification.confidence,
            critical: classification.critical,
            workers,
            parallelWorkers: Math.min(config.orchestration.parallelWorkers, workers.length),
            escalation,
            next: `Delegate the full task once to orch-lead with profile=${profile}. Let orch-lead dispatch workers.`,
          },
          null,
          2,
        )
      },
    }),
    orchestra_status: tool({
      description: "Show model, worker, escalation, cost, and consensus statistics for the current Orchestra session.",
      args: {},
      async execute(_args, context) {
        const sessionID = (context as ToolContextLike).sessionID
        if (!sessionID) return "Orchestra status is unavailable because the current session ID was not provided."
        return ledger.formatStatus(sessionID)
      },
    }),
  }
}
