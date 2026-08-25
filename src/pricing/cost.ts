// Pure cost calculation. Usage (tokens) and pricing (USD per 1M tokens) are
// separate concerns: tokens are always counted, while cost may be 0 (free /
// subscription) or null (unknown pricing). Unknown must never be silently
// treated as free.

export type PricingStatus = "paid" | "free" | "subscription" | "unknown"

export interface PricingResolution {
  status: PricingStatus
  /** USD per 1M input tokens (paid only). */
  input?: number
  /** USD per 1M output tokens (paid only). */
  output?: number
  /** USD per 1M reasoning tokens, when priced separately (paid only). */
  reasoning?: number
  /** USD per 1M cached-input read tokens, when priced separately (paid only). */
  cacheRead?: number
}

export interface UsageTokens {
  input: number
  output: number
  reasoning?: number
  cacheRead?: number
}

export interface UsageCost {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  totalTokens: number
  /** USD; null exactly when pricing is unknown. Free/subscription cost 0. */
  cost: number | null
  pricingStatus: PricingStatus
}

export function calcCost(resolution: PricingResolution, usage: UsageTokens): UsageCost {
  const input = Math.max(0, usage.input ?? 0)
  const output = Math.max(0, usage.output ?? 0)
  const reasoning = Math.max(0, usage.reasoning ?? 0)
  const cacheRead = Math.max(0, usage.cacheRead ?? 0)
  const totalTokens = input + output + reasoning + cacheRead

  if (resolution.status === "paid") {
    const cost = (input * (resolution.input ?? 0)
      + output * (resolution.output ?? 0)
      + reasoning * (resolution.reasoning ?? 0)
      + cacheRead * (resolution.cacheRead ?? 0)) / 1_000_000
    return {
      inputTokens: input,
      outputTokens: output,
      reasoningTokens: reasoning,
      cacheReadTokens: cacheRead,
      totalTokens,
      cost,
      pricingStatus: "paid",
    }
  }

  if (resolution.status === "free" || resolution.status === "subscription") {
    return {
      inputTokens: input,
      outputTokens: output,
      reasoningTokens: reasoning,
      cacheReadTokens: cacheRead,
      totalTokens,
      cost: 0,
      pricingStatus: resolution.status,
    }
  }

  return {
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: reasoning,
    cacheReadTokens: cacheRead,
    totalTokens,
    cost: null,
    pricingStatus: "unknown",
  }
}
