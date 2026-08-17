import type { CapabilityName, ModelCandidateInput, OrchestraConfig } from "../config/schema.js"

interface CatalogModel {
  id: string
  reasoning?: boolean
  tool_call?: boolean
  attachment?: boolean
  experimental?: boolean
  status?: "alpha" | "beta" | "deprecated" | "active"
  cost?: { input: number; output: number }
  limit?: { context: number; output: number }
  modalities?: { input: string[]; output: string[] }
}

interface CatalogProvider {
  id: string
  models: Record<string, CatalogModel>
}

interface ProviderCatalog {
  all: CatalogProvider[]
  connected: string[]
}

interface ProviderClientLike {
  provider?: {
    list?: () => Promise<{ data?: ProviderCatalog }>
  }
}

function contextClass(tokens: number | undefined): "small" | "medium" | "large" | "xlarge" | undefined {
  if (!tokens) return undefined
  if (tokens >= 500_000) return "xlarge"
  if (tokens >= 128_000) return "large"
  if (tokens >= 32_000) return "medium"
  return "small"
}

function capabilities(model: CatalogModel): CapabilityName[] {
  const result = new Set<CapabilityName>()
  if (model.tool_call !== false) {
    result.add("code")
    result.add("research")
  }
  if (model.reasoning) {
    result.add("reasoning")
    result.add("review")
    result.add("security")
    result.add("performance")
  }
  if (model.attachment || model.modalities?.input.includes("image")) result.add("vision")
  if (model.modalities?.output.includes("image")) result.add("image")
  if ((model.limit?.context ?? 0) >= 128_000) result.add("large-context")
  return [...result]
}

function candidate(providerID: string, model: CatalogModel): ModelCandidateInput {
  const paid = Boolean(model.cost && (model.cost.input > 0 || model.cost.output > 0))
  const caps = capabilities(model)
  const price = (model.cost?.input ?? 0) + (model.cost?.output ?? 0)
  const lifecyclePenalty = model.status === "deprecated" ? 45 : model.experimental || model.status === "alpha" ? 15 : 0
  const priority = Math.max(5, Math.min(95, 70 - Math.log10(1 + price) * 8 - lifecyclePenalty))
  const scores: Record<string, number> = {}
  for (const capability of caps) scores[capability] = model.reasoning && capability === "reasoning" ? 9 : 7

  return {
    id: providerID + "/" + model.id,
    cost: paid ? "paid" : "free",
    tier: model.reasoning ? ((model.limit?.context ?? 0) >= 200_000 ? "frontier" : "lead") : "worker",
    priority,
    capabilities: caps,
    scores,
    ...(contextClass(model.limit?.context) ? { context: contextClass(model.limit?.context) } : {}),
    ...(model.cost?.input !== undefined ? { priceInput: model.cost.input } : {}),
    ...(model.cost?.output !== undefined ? { priceOutput: model.cost.output } : {}),
  }
}

export async function discoverConnectedModels(client: unknown): Promise<ModelCandidateInput[]> {
  const provider = (client as ProviderClientLike).provider
  if (!provider?.list) return []
  try {
    const result = await provider.list()
    const catalog = result.data
    if (!catalog) return []
    const connected = new Set(catalog.connected)
    return catalog.all
      .filter((item) => connected.has(item.id))
      .flatMap((item) => Object.values(item.models).map((model) => candidate(item.id, model)))
  } catch {
    return []
  }
}

function hasCapability(input: ModelCandidateInput, capability: CapabilityName): boolean {
  return typeof input !== "string" && input.capabilities.includes(capability)
}

function best(inputs: ModelCandidateInput[], capability: CapabilityName): ModelCandidateInput[] {
  const matching = inputs.filter((input) => hasCapability(input, capability))
  return (matching.length > 0 ? matching : inputs).slice(0, 24)
}

export function applyDiscoveredModels(
  config: OrchestraConfig,
  discovered: ModelCandidateInput[],
): OrchestraConfig {
  if (config.models.strategy !== "auto" || discovered.length === 0) return config
  const fill = (current: ModelCandidateInput[], capability: CapabilityName) =>
    current.length > 0 ? current : best(discovered, capability)

  return {
    ...config,
    models: {
      ...config.models,
      lead: fill(config.models.lead, "reasoning"),
      worker: {
        code: fill(config.models.worker.code, "code"),
        reasoning: fill(config.models.worker.reasoning, "reasoning"),
        research: fill(config.models.worker.research, "research"),
        vision: fill(config.models.worker.vision, "vision"),
        image: fill(config.models.worker.image, "image"),
      },
      judge: fill(config.models.judge, "review"),
    },
  }
}
