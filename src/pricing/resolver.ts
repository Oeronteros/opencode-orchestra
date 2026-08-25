// Pricing Resolver: turns a raw model id (any spelling, any provider prefix)
// into a PricingResolution. Precedence, highest first:
//
//   1. config-declared cost class (free / subscription)
//   2. explicit configured price (priceInput/priceOutput)
//   3. ":free" variant suffix in the raw id
//   4. user-defined model aliases (they beat every external source)
//   5. built-in / operator-refreshed price snapshot (provider pricing)
//   6. OpenRouter fallback (opt-in; cached; async)
//   7. unknown — tokens still counted, cost null, never silently free
//
// Free models and subscription models are priced $0 with their status kept;
// "unknown" is a distinct state so callers can surface "no price" honestly.

import type { PriceSnapshot } from "../routing/pricing/prices.js"
import type { ModelCost } from "../config/schema.js"
import {
  matchModel,
  normalizeModelName,
  parseModelId,
  splitProviderId,
  type MatchMethod,
  type ModelEntry,
} from "./model-match.js"
import { toModelEntries, type OpenRouterModel } from "./openrouter.js"
import type { PricingResolution } from "./cost.js"

export interface ModelAliasEntry {
  /** Canonical model id the aliases point at, e.g. "gpt-5-6-sol". */
  canonical: string
  /** Raw names that map to the canonical id. */
  aliases: string[]
}

export interface OpenRouterSource {
  getModels(force?: boolean): Promise<OpenRouterModel[]>
}

export interface ResolverConfig {
  snapshot: PriceSnapshot
  aliases?: ModelAliasEntry[]
  openRouter?: OpenRouterSource
}

export interface ResolverInput {
  /** Raw id, optionally provider-prefixed ("CX/GPT-5.6 Sol"). */
  id?: string
  providerID?: string
  modelID?: string
  /** Config-declared cost class when known (routing pools, provider catalog). */
  declaredCost?: ModelCost
  /** Explicit configured USD/1M prices; beat every lookup source. */
  explicitPrice?: { input: number; output: number }
}

export interface ResolvedPricing extends PricingResolution {
  /** Canonical normalized model id ("gpt-5-6-sol"). */
  canonicalId?: string
  /** Where the price came from. */
  source?: "config" | "snapshot" | "openrouter"
  /** How the model identity was matched. */
  method?: MatchMethod
  familyAmbiguous?: boolean
  /** True when the async OpenRouter tier should still be tried. */
  needsFallback?: boolean
}

interface SnapshotCatalog {
  entries: ModelEntry[]
  keyByEntryId: Map<string, string>
}

function snapshotCatalog(snapshot: PriceSnapshot): SnapshotCatalog {
  const entries: ModelEntry[] = []
  const keyByEntryId = new Map<string, string>()
  for (const key of Object.keys(snapshot.prices)) {
    const { provider, rest } = splitProviderId(key)
    const entryId = normalizeModelName(rest)
    entries.push({
      id: entryId,
      ...(provider ? { provider: normalizeModelName(provider) } : {}),
    })
    keyByEntryId.set(entryId, key)
  }
  return { entries, keyByEntryId }
}

function rawIdOf(input: ResolverInput): string {
  if (input.id) return input.id
  if (input.providerID && input.modelID) return `${input.providerID}/${input.modelID}`
  return input.modelID ?? ""
}

function resolveFromSnapshot(
  entryId: string,
  method: MatchMethod,
  catalog: SnapshotCatalog,
  snapshot: PriceSnapshot,
): ResolvedPricing {
  const key = catalog.keyByEntryId.get(entryId)
  const price = key ? snapshot.prices[key] : undefined
  if (!key || !price) {
    return { status: "unknown", canonicalId: entryId, method, needsFallback: true }
  }
  if (price.input === 0 && price.output === 0) {
    return { status: "free", canonicalId: entryId, source: "snapshot", method }
  }
  return {
    status: "paid",
    input: price.input,
    output: price.output,
    canonicalId: entryId,
    source: "snapshot",
    method,
  }
}

/** Sync tier: config declarations + user aliases + the price snapshot. */
export function resolvePricingSync(input: ResolverInput, config: ResolverConfig): ResolvedPricing {
  const raw = rawIdOf(input)
  const parsed = parseModelId(raw)

  if (input.declaredCost === "subscription") return { status: "subscription", canonicalId: parsed.model }
  if (input.declaredCost === "free") return { status: "free", canonicalId: parsed.model }

  const explicit = input.explicitPrice
  if (explicit && explicit.input >= 0 && explicit.output >= 0) {
    if (explicit.input === 0 && explicit.output === 0) {
      return { status: "free", canonicalId: parsed.model, source: "config" }
    }
    return {
      status: "paid",
      input: explicit.input,
      output: explicit.output,
      canonicalId: parsed.model,
      source: "config",
    }
  }

  if (parsed.variant === "free") return { status: "free", canonicalId: parsed.model }

  const catalog = snapshotCatalog(config.snapshot)
  for (const aliasEntry of config.aliases ?? []) {
    const hit = (aliasEntry.aliases ?? []).some((alias) => normalizeModelName(alias) === parsed.model)
    if (hit) return resolveFromSnapshot(aliasEntry.canonical, "alias", catalog, config.snapshot)
  }

  const match = matchModel(raw, catalog.entries)
  if (match.method !== "none") {
    return resolveFromSnapshot(match.canonical, match.method, catalog, config.snapshot)
  }

  return {
    status: "unknown",
    canonicalId: match.canonical,
    ...(match.familyAmbiguous ? { familyAmbiguous: true } : {}),
    needsFallback: true,
  }
}

function classifyOpenRouter(model: OpenRouterModel, match: { canonical: string; method: MatchMethod }): ResolvedPricing {
  const pricing = model.pricing
  if (model.isFreeVariant) {
    return { status: "free", canonicalId: match.canonical, source: "openrouter", method: match.method }
  }
  const hasMediaPrice = (pricing.request ?? 0) > 0 || (pricing.image ?? 0) > 0 || (pricing.audio ?? 0) > 0
  if (pricing.input !== undefined && pricing.output !== undefined) {
    if (pricing.input === 0 && pricing.output === 0) {
      // Zero token prices alone do not prove a model is free: media models
      // bill per request/image instead. Keep those unknown, never silent $0.
      if (hasMediaPrice) {
        return { status: "unknown", canonicalId: match.canonical, source: "openrouter", method: match.method }
      }
      return { status: "free", canonicalId: match.canonical, source: "openrouter", method: match.method }
    }
    return {
      status: "paid",
      input: pricing.input,
      output: pricing.output,
      ...(pricing.cacheRead !== undefined ? { cacheRead: pricing.cacheRead } : {}),
      ...(pricing.reasoning !== undefined ? { reasoning: pricing.reasoning } : {}),
      canonicalId: match.canonical,
      source: "openrouter",
      method: match.method,
    }
  }
  return { status: "unknown", canonicalId: match.canonical, source: "openrouter", method: match.method }
}

/**
 * Full resolution: sync tier first, then the cached OpenRouter catalog when
 * the price is still unknown. Never fetches when OpenRouter is disabled.
 */
export async function resolvePricing(input: ResolverInput, config: ResolverConfig): Promise<ResolvedPricing> {
  const sync = resolvePricingSync(input, config)
  if (sync.status !== "unknown" || !sync.needsFallback || !config.openRouter) return sync

  const models = await config.openRouter.getModels(false)
  const entries = toModelEntries(models)
  const match = matchModel(rawIdOf(input), entries)
  if (match.method === "none") return sync

  const modelByEntryId = new Map<string, OpenRouterModel>()
  for (const model of models) {
    modelByEntryId.set(normalizeModelName(splitProviderId(model.id).rest), model)
  }
  const model = modelByEntryId.get(match.canonical)
  if (!model) return sync
  return classifyOpenRouter(model, { canonical: match.canonical, method: match.method })
}
