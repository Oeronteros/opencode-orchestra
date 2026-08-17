import type { OrchestraConfig, ProfileName } from "./schema.js"
import { PROFILE_NAMES, orchestraConfigSchema } from "./schema.js"

const enabledProfiles = Object.fromEntries(
  PROFILE_NAMES.map((profile) => [profile, true]),
) as Record<ProfileName, boolean>

export const DEFAULT_CONFIG: OrchestraConfig = orchestraConfigSchema.parse({
  orchestration: {
    profiles: enabledProfiles,
  },
})

export function withDefaults(input: unknown): OrchestraConfig {
  return orchestraConfigSchema.parse(input)
}

export function applyBudgetPreset(config: OrchestraConfig): OrchestraConfig {
  if (config.budget !== "ebobo") return config
  return {
    ...config,
    orchestration: {
      ...config.orchestration,
      parallelWorkers: 8,
      maxWorkers: 12,
      premiumEscalation: true,
      maxPremiumCallsPerTask: 5,
      confidenceThreshold: 0.95,
    },
  }
}
