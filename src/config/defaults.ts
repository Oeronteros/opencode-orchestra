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
  // Zod's compatibility default is 1. Treat that value as implicit for the
  // preset modes, while leaving every other user supplied value untouched.
  // This keeps old configs valid and makes the mode useful without requiring
  // users to add a new field.
  // EBOBO retains its established orchestration preset of five premium
  // calls; the guard's standalone 12-call mode remains available to callers
  // that explicitly request it.
  const presetCalls = { eco: 0, balanced: 1, quality: 6, ebobo: 5 }[config.budget]
  const maxPremiumCallsPerTask = config.orchestration.maxPremiumCallsPerTask === 1
    ? presetCalls
    : config.orchestration.maxPremiumCallsPerTask
  if (config.budget !== "ebobo") {
    return maxPremiumCallsPerTask === config.orchestration.maxPremiumCallsPerTask
      ? config
      : { ...config, orchestration: { ...config.orchestration, maxPremiumCallsPerTask } }
  }
  return {
    ...config,
    orchestration: {
      ...config.orchestration,
      parallelWorkers: 8,
      maxWorkers: 12,
      premiumEscalation: true,
      maxPremiumCallsPerTask,
      confidenceThreshold: 0.95,
    },
  }
}
