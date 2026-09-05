export interface TokenUsageLike {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

export interface TokenBreakdown {
  /** Incoming tokens (input, without cache). */
  input: number
  /** Outgoing tokens (output + reasoning). */
  output: number
  cacheRead: number
  cacheWrite: number
  /** input + output (outgoing already includes reasoning, cache excluded). */
  total: number
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0
}

/**
 * Split a TokenUsage record into incoming / outgoing / cache parts.
 * Agreed breakdown: incoming = input, outgoing = output + reasoning,
 * cache = cache.read (+ cache.write when present).
 */
export function splitTokens(tokens?: TokenUsageLike): TokenBreakdown {
  const input = nonNegative(tokens?.input)
  const output = nonNegative(tokens?.output) + nonNegative(tokens?.reasoning)
  const cacheRead = nonNegative(tokens?.cache?.read)
  const cacheWrite = nonNegative(tokens?.cache?.write)
  return { input, output, cacheRead, cacheWrite, total: input + output }
}
