// Built-in model price snapshot (USD per 1M tokens, input/output).
// Prices are a *ranking signal* and the basis for pre-run cost estimates.
// They can be refreshed from a self-hosted endpoint (see refresh.ts); this
// snapshot is the offline fallback so estimates never depend on network.

export interface ModelPrice {
  input: number
  output: number
}

export interface PriceSnapshot {
  /** ISO timestamp the snapshot represents (bumped by refresh). */
  updatedAt: string
  /** Price per provider/model id (e.g. "anthropic/claude-sonnet-4-5"). */
  prices: Record<string, ModelPrice>
}

export const SNAPSHOT_VERSION = "2026-01"

// Rough public list prices at time of snapshot. Values are per-million-token
// USD, input/output. They are deliberately approximate: they drive ordering,
// not accounting — the ledger remains the source of truth for actual spend.
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  // OpenAI
  "openai/gpt-5.3": { input: 1.25, output: 10 },
  "openai/gpt-5.2": { input: 1.25, output: 10 },
  "openai/gpt-5": { input: 1.25, output: 10 },
  "openai/gpt-5-mini": { input: 0.25, output: 2 },
  "openai/gpt-5-nano": { input: 0.05, output: 0.4 },
  "openai/gpt-4.1": { input: 2, output: 8 },
  "openai/gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "openai/o3": { input: 2, output: 8 },
  "openai/o4-mini": { input: 1.1, output: 4.4 },
  // Anthropic
  "anthropic/claude-sonnet-4-5": { input: 3, output: 15 },
  "anthropic/claude-sonnet-4": { input: 3, output: 15 },
  "anthropic/claude-opus-4": { input: 15, output: 75 },
  "anthropic/claude-opus-4-5": { input: 15, output: 75 },
  "anthropic/claude-haiku-4-5": { input: 1, output: 5 },
  "anthropic/claude-haiku-4": { input: 0.8, output: 4 },
  // Google
  "google/gemini-3-pro": { input: 2, output: 12 },
  "google/gemini-3-flash": { input: 0.1, output: 0.4 },
  "google/gemini-2.5-pro": { input: 1.25, output: 10 },
  "google/gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "google/gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  // DeepSeek
  "deepseek/deepseek-chat": { input: 0.27, output: 1.1 },
  "deepseek/deepseek-reasoner": { input: 0.55, output: 2.19 },
  // Meta / Llama (hosted)
  "meta-llama/llama-4-maverick": { input: 0.2, output: 0.6 },
  "meta-llama/llama-4-scout": { input: 0.1, output: 0.35 },
  "meta-llama/llama-3.3-70b": { input: 0.12, output: 0.3 },
  // Mistral
  "mistral/mistral-large": { input: 2, output: 6 },
  "mistral/mistral-medium": { input: 0.9, output: 2.7 },
  "mistral/mistral-small": { input: 0.2, output: 0.6 },
  // xAI
  "x-ai/grok-4": { input: 3, output: 15 },
  "x-ai/grok-3": { input: 3, output: 15 },
  "x-ai/grok-3-mini": { input: 0.3, output: 0.5 },
}

export function emptyPriceSnapshot(): PriceSnapshot {
  return { updatedAt: SNAPSHOT_VERSION, prices: { ...DEFAULT_PRICES } }
}

/** Normalize an arbitrary provider/model id (case, optional provider) for lookup. */
export function modelPriceKey(providerID: string, modelID: string): string {
  return `${providerID.toLowerCase()}/${modelID.toLowerCase()}`
}

/** Look up a price, tolerating provider/ and bare model ids and case. */
export function lookupPrice(
  snapshot: PriceSnapshot,
  id: string,
): ModelPrice | undefined {
  const normalized = id.toLowerCase()
  const direct = snapshot.prices[normalized]
  if (direct) return direct
  // Fall through bare-model form: map the final path segment across providers.
  const bare = normalized.split("/").pop()
  if (!bare) return undefined
  const entries = Object.entries(snapshot.prices)
  const exact = entries.find(([key]) => key.endsWith(`/${bare}`))
  return exact?.[1]
}

/** Combined input+output price per 1M tokens, for ordering heuristics. */
export function combinedPrice(price: ModelPrice | undefined): number {
  return price ? price.input + price.output : 0
}
