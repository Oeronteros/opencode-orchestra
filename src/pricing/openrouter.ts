// OpenRouter pricing source. The models list is a public, keyless endpoint;
// prices arrive as decimal strings in USD per single token and are converted
// here to USD per 1M tokens, matching the plugin's internal unit everywhere
// else. Per-request prices (request/image/audio) stay in their own units and
// are never multiplied by token counts. Fetching is cached with a TTL and
// single-flight; failures keep the previous snapshot so offline estimation
// keeps working.

import { normalizeModelName, splitProviderId, type ModelEntry } from "./model-match.js"

export interface OpenRouterPricing {
  /** USD per 1M input tokens. */
  input?: number
  /** USD per 1M output tokens. */
  output?: number
  /** USD per 1M cached-input read tokens. */
  cacheRead?: number
  /** USD per 1M internal reasoning tokens. */
  reasoning?: number
  /** USD per request (per-request billing, not token billing). */
  request?: number
  /** USD per image (per-unit billing, not token billing). */
  image?: number
  /** USD per audio unit (per-unit billing, not token billing). */
  audio?: number
}

export interface OpenRouterModel {
  /** Lowercase raw model id without the variant suffix, e.g. "openai/gpt-4o-mini". */
  id: string
  /** OpenRouter variant suffix ("free", "thinking", "nitro", ...), when present. */
  variant?: string
  /** Display name as reported by OpenRouter. */
  name?: string
  /** Provider-stripped canonical slug (a dated alias of the same model). */
  canonicalSlug?: string
  contextLength?: number | null
  /** True when the id carried a ":free" suffix. */
  isFreeVariant: boolean
  pricing: OpenRouterPricing
}

function toPrice(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

/** Convert a per-token string price to USD per 1M, rounded to micro-dollars. */
function toPerMillion(value: unknown): number | undefined {
  const parsed = toPrice(value)
  if (parsed === undefined) return undefined
  return Math.round(parsed * 1_000_000 * 1_000_000) / 1_000_000
}

function splitVariant(id: string): { base: string; variant?: string } {
  const idx = id.lastIndexOf(":")
  if (idx === -1) return { base: id }
  return { base: id.slice(0, idx), variant: id.slice(idx + 1) }
}

/**
 * Parse an OpenRouter `/api/v1/models` response into normalized models.
 * Missing or invalid price fields become undefined (never 0, never throws).
 */
export function parseOpenRouterModels(text: string): OpenRouterModel[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (typeof parsed !== "object" || parsed === null) return []
  const data = (parsed as { data?: unknown }).data
  if (!Array.isArray(data)) return []

  const models: OpenRouterModel[] = []
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue
    const raw = item as Record<string, unknown>
    if (typeof raw.id !== "string" || !raw.id) continue
    const { base, variant } = splitVariant(raw.id)
    const pricingRaw = (typeof raw.pricing === "object" && raw.pricing !== null ? raw.pricing : {}) as Record<string, unknown>
    const input = toPerMillion(pricingRaw.prompt)
    const output = toPerMillion(pricingRaw.completion)
    const cacheRead = toPerMillion(pricingRaw.input_cache_read)
    const reasoning = toPerMillion(pricingRaw.internal_reasoning)
    const request = toPrice(pricingRaw.request)
    const image = toPrice(pricingRaw.image)
    const audio = toPrice(pricingRaw.audio)
    models.push({
      id: base.toLowerCase(),
      ...(variant ? { variant } : {}),
      ...(typeof raw.name === "string" && raw.name ? { name: raw.name } : {}),
      ...(typeof raw.canonical_slug === "string" && raw.canonical_slug
        ? { canonicalSlug: splitProviderId(raw.canonical_slug).rest }
        : {}),
      ...(typeof raw.context_length === "number" ? { contextLength: raw.context_length } : {}),
      isFreeVariant: variant === "free",
      pricing: {
        ...(input !== undefined ? { input } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(cacheRead !== undefined ? { cacheRead } : {}),
        ...(reasoning !== undefined ? { reasoning } : {}),
        ...(request !== undefined ? { request } : {}),
        ...(image !== undefined ? { image } : {}),
        ...(audio !== undefined ? { audio } : {}),
      },
    })
  }
  return models
}

/** Build matchModel catalog entries from a parsed OpenRouter list. */
export function toModelEntries(models: OpenRouterModel[]): ModelEntry[] {
  const entries: ModelEntry[] = []
  for (const model of models) {
    const { provider, rest } = splitProviderId(model.id)
    const aliases: string[] = []
    if (model.name) aliases.push(model.name)
    if (model.canonicalSlug) aliases.push(model.canonicalSlug)
    entries.push({
      id: normalizeModelName(rest),
      ...(provider ? { provider } : {}),
      ...(aliases.length ? { aliases } : {}),
    })
  }
  return entries
}

export interface OpenRouterCacheOptions {
  /** Cache lifetime in milliseconds. */
  ttlMs: number
  /** Endpoint override (tests / self-hosted mirrors). */
  endpoint?: string
  fetchImpl?: typeof fetch
  now?: () => number
}

export interface OpenRouterCache {
  /** Models from cache, refetching lazily when cold/stale or when forced. */
  getModels(force?: boolean): Promise<OpenRouterModel[]>
  /** In-memory catalog from the last successful fetch; undefined while cold. */
  readonly cachedModels: OpenRouterModel[] | undefined
  /** Epoch ms of the last successful fetch. */
  readonly fetchedAt: number | undefined
  /** Last fetch error message, when any. */
  readonly lastError: string | undefined
}

export const DEFAULT_OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/models"

/**
 * TTL-on-data cache over the OpenRouter models list. Concurrent callers
 * share one in-flight fetch; a failed refresh keeps the previous snapshot.
 */
export function createOpenRouterCache(options: OpenRouterCacheOptions): OpenRouterCache {
  const endpoint = options.endpoint ?? DEFAULT_OPENROUTER_ENDPOINT
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  let models: OpenRouterModel[] | undefined
  let fetchedAt: number | undefined
  let lastError: string | undefined
  let inFlight: Promise<OpenRouterModel[]> | undefined

  const refresh = (): Promise<OpenRouterModel[]> => {
    inFlight = (async () => {
      try {
        const response = await fetchImpl(endpoint)
        if (!response.ok) throw new Error(`openrouter ${response.status}`)
        models = parseOpenRouterModels(await response.text())
        fetchedAt = now()
        lastError = undefined
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
      return models ?? []
    })().finally(() => {
      inFlight = undefined
    })
    return inFlight
  }

  const getModels = (force = false): Promise<OpenRouterModel[]> => {
    if (inFlight) return inFlight
    if (force || models === undefined || now() - (fetchedAt ?? 0) >= options.ttlMs) return refresh()
    return Promise.resolve(models)
  }

  return {
    getModels,
    get cachedModels() {
      return models
    },
    get fetchedAt() {
      return fetchedAt
    },
    get lastError() {
      return lastError
    },
  }
}
