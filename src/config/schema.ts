import { z } from "zod"

export const PROFILE_NAMES = [
  "architecture",
  "debug",
  "ui",
  "research",
  "review",
  "security",
  "performance",
  "migration",
  "ops",
] as const

export const CAPABILITY_NAMES = [
  "code",
  "reasoning",
  "research",
  "vision",
  "image",
  "review",
  "security",
  "performance",
  "large-context",
] as const

export const profileNameSchema = z.enum(PROFILE_NAMES)
export const budgetModeSchema = z.enum(["eco", "balanced", "quality", "ebobo"])
export const modelCostSchema = z.enum(["free", "subscription", "paid"])
export const modelTierSchema = z.enum(["worker", "lead", "frontier"])

const modelIdSchema = z
  .string()
  .min(3)
  .refine((value) => value.includes("/"), "Model ID must use provider/model format")

export const modelCandidateSchema = z.union([
  modelIdSchema,
  z.object({
    id: modelIdSchema,
    cost: modelCostSchema.default("free"),
    tier: modelTierSchema.default("worker"),
    priority: z.number().min(0).max(100).default(50),
    capabilities: z.array(z.enum(CAPABILITY_NAMES)).default([]),
    scores: z.record(z.string(), z.number().min(0).max(10)).default({}),
    context: z.enum(["small", "medium", "large", "xlarge"]).optional(),
    /** Explicit USD price per 1M input tokens (overrides the built-in snapshot). */
    priceInput: z.number().min(0).optional(),
    /** Explicit USD price per 1M output tokens (overrides the built-in snapshot). */
    priceOutput: z.number().min(0).optional(),
  }),
])

const poolSchema = z.array(modelCandidateSchema).default([])

export const orchestraConfigSchema = z.object({
  $schema: z.string().optional(),
  budget: budgetModeSchema.default("balanced"),
  models: z
    .object({
      strategy: z.enum(["auto", "manual"]).default("auto"),
      agents: z.record(z.string(), modelIdSchema).default({}),
      lead: poolSchema,
      worker: z
        .object({
          code: poolSchema,
          reasoning: poolSchema,
          research: poolSchema,
          vision: poolSchema,
          image: poolSchema,
        })
        .default({ code: [], reasoning: [], research: [], vision: [], image: [] }),
      judge: poolSchema,
      /** Automatic model fallback when the resolved model fails at call time. */
      fallback: z
        .object({
          /** Switch to the next similar-cost available model after a provider error. */
          enabled: z.boolean().default(true),
          /** Maximum model switches per single request. */
          maxRetries: z.number().int().min(0).max(5).default(2),
        })
        .default({ enabled: true, maxRetries: 2 }),
    })
    .default({
      strategy: "auto",
      agents: {},
      lead: [],
      worker: { code: [], reasoning: [], research: [], vision: [], image: [] },
      judge: [],
      fallback: { enabled: true, maxRetries: 2 },
    }),
  orchestration: z
    .object({
      parallelWorkers: z.number().int().min(1).max(8).default(3),
      /** Maximum isolated editor workers; 0 disables editor execution. */
      parallelEditors: z.number().int().min(0).max(8).default(0),
      /** Repository-relative or absolute root for experimental git worktrees. */
      worktreeRoot: z.string().min(1).optional(),
      maxWorkers: z.number().int().min(1).max(12).default(5),
      premiumEscalation: z.boolean().default(true),
      maxPremiumCallsPerTask: z.number().int().min(0).max(24).default(1),
      confidenceThreshold: z.number().min(0).max(1).default(0.72),
      exposeWorkers: z.boolean().default(false),
      profiles: z.partialRecord(profileNameSchema, z.boolean()).default({}),
    })
    .default({
      parallelWorkers: 3,
      parallelEditors: 0,
      worktreeRoot: undefined,
      maxWorkers: 5,
      premiumEscalation: true,
      maxPremiumCallsPerTask: 1,
      confidenceThreshold: 0.72,
      exposeWorkers: false,
      profiles: {},
    }),
  superpowers: z
    .object({
      compatibility: z.boolean().default(true),
      injectPrimaryHint: z.boolean().default(false),
    })
    .default({ compatibility: true, injectPrimaryHint: false }),
  telemetry: z
    .object({
      enabled: z.boolean().default(true),
      directory: z.string().min(1).default(".orchestra"),
      storeTexts: z.boolean().default(false),
      /** Standard deviations from the daily-cost mean that count as an anomaly. */
      anomalySigma: z.number().min(0.5).max(6).default(2),
    })
    .default({ enabled: true, directory: ".orchestra", storeTexts: false, anomalySigma: 2 }),
  pricing: z
    .object({
      /** Self-hosted price-list endpoint that overrides the built-in snapshot. */
      endpoint: z.string().min(1).optional(),
      /** Polling interval in hours; 0 disables periodic refresh. */
      refreshIntervalHours: z.number().int().min(0).max(24 * 90).default(0),
      /** Enable pre-run cost estimates surfaced in orchestra_route. */
      estimate: z.boolean().default(true),
      /** Dollar threshold above which orchestra_route emits a pre-run warning. */
      warnThresholdUSD: z.number().min(0).default(0.5),
      /** OpenRouter pricing fallback for models without provider pricing. */
      openrouter: z
        .object({
          /** Fetch the public OpenRouter model list when a price is unknown. */
          enabled: z.boolean().default(false),
          /** Cache lifetime in hours for the fetched OpenRouter model list. */
          ttlHours: z.number().int().min(1).max(24 * 30).default(12),
        })
        .default({ enabled: false, ttlHours: 12 }),
      /** User-defined model aliases: raw names that map to a canonical model id. */
      aliases: z
        .array(
          z.object({
            canonical: z.string().min(1),
            aliases: z.array(z.string().min(1)).min(1),
          }),
        )
        .default([]),
    })
    .default({
      endpoint: undefined,
      refreshIntervalHours: 0,
      estimate: true,
      warnThresholdUSD: 0.5,
      openrouter: { enabled: false, ttlHours: 12 },
      aliases: [],
    }),
})

export type OrchestraConfig = z.infer<typeof orchestraConfigSchema>
export type ModelCandidateInput = z.infer<typeof modelCandidateSchema>
export type ProfileName = z.infer<typeof profileNameSchema>
export type BudgetMode = z.infer<typeof budgetModeSchema>
export type ModelCost = z.infer<typeof modelCostSchema>
export type ModelTier = z.infer<typeof modelTierSchema>
export type CapabilityName = (typeof CAPABILITY_NAMES)[number]

export type OrchestraPluginOptions = Partial<OrchestraConfig> & {
  configFile?: string
}
