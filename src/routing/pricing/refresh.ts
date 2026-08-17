import type { PriceSnapshot } from "./prices.js"
import { emptyPriceSnapshot } from "./prices.js"

export interface RefreshSource {
  /** Self-hosted price endpoint URL, e.g. "https://internal/prices.json". */
  endpoint: string
  /** Polling interval in hours. 0 disables periodic refresh. */
  refreshIntervalHours: number
}

export interface RefreshState {
  snapshot: PriceSnapshot
  /** Last successful refresh (epoch ms), undefined if never refreshed. */
  lastRefreshedAt?: number
  /** Last refresh error, undefined if none. */
  lastError?: string
  source?: RefreshSource
}

interface RemotePayload {
  updatedAt?: string
  prices?: Record<string, { input: number; output: number }>
}

function isValidPrice(value: unknown): value is { input: number; output: number } {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as { input?: unknown; output?: unknown }
  return (
    typeof candidate.input === "number" &&
    Number.isFinite(candidate.input) &&
    candidate.input >= 0 &&
    typeof candidate.output === "number" &&
    Number.isFinite(candidate.output) &&
    candidate.output >= 0
  )
}

function parseRemote(text: string): PriceSnapshot | undefined {
  const payload = JSON.parse(text) as RemotePayload
  if (!payload || typeof payload.prices !== "object" || payload.prices === null) return undefined
  const prices: Record<string, { input: number; output: number }> = {}
  for (const [key, value] of Object.entries(payload.prices)) {
    if (!isValidPrice(value)) continue
    prices[key.toLowerCase()] = { input: value.input, output: value.output }
  }
  if (Object.keys(prices).length === 0) return undefined
  return { updatedAt: payload.updatedAt ?? new Date().toISOString(), prices }
}

/**
 * Fetch a price list from a self-hosted endpoint and reconcile it over the
 * built-in snapshot. Unknown models are added; known ones are overridden if
 * the remote supplies a value. Failures leave the snapshot untouched, so
 * estimates keep working offline.
 */
export async function refreshPrices(
  snapshot: PriceSnapshot,
  source: RefreshSource,
  fetchImpl: typeof fetch = fetch,
): Promise<RefreshState> {
  const startedAt = Date.now()
  if (!source?.endpoint || source.refreshIntervalHours <= 0) {
    return { snapshot: { ...snapshot }, source }
  }
  try {
    const response = await fetchImpl(source.endpoint)
    if (!response.ok) throw new Error(`price endpoint ${response.status}`)
    const text = await response.text()
    const remote = parseRemote(text)
    if (!remote) throw new Error("price endpoint returned no valid prices")
    const merged = { ...snapshot.prices, ...remote.prices }
    return {
      snapshot: { updatedAt: remote.updatedAt, prices: merged },
      lastRefreshedAt: startedAt,
      source,
    }
  } catch (error) {
    return {
      snapshot: { ...snapshot },
      lastError: error instanceof Error ? error.message : String(error),
      source,
    }
  }
}

export function createPriceRefresher(
  initial: PriceSnapshot = emptyPriceSnapshot(),
  source?: RefreshSource,
) {
  let state: RefreshState = { snapshot: initial, ...(source ? { source } : {}) }
  let timer: ReturnType<typeof setInterval> | undefined
  let inFlight: Promise<void> | undefined

  const sync = (): Promise<void> => {
    if (!source?.endpoint || source.refreshIntervalHours <= 0) return Promise.resolve()
    if (inFlight) return inFlight
    inFlight = refreshPrices(state.snapshot, source)
      .then((next) => { state = next })
      .finally(() => { inFlight = undefined })
    return inFlight
  }

  const start = (): void => {
    if (!source?.endpoint || source.refreshIntervalHours <= 0) return
    if (timer) return
    void sync()
    timer = setInterval(() => void sync(), source.refreshIntervalHours * 3_600_000)
    // Do not keep the event loop alive solely for price polling.
    timer.unref?.()
  }

  const stop = (): void => {
    if (timer) clearInterval(timer)
    timer = undefined
  }

  return {
    start,
    stop,
    sync,
    get snapshot(): PriceSnapshot {
      return state.snapshot
    },
    get lastRefreshedAt(): number | undefined {
      return state.lastRefreshedAt
    },
    get lastError(): string | undefined {
      return state.lastError
    },
  }
}
