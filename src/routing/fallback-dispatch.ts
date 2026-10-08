import { classifyError, isRetryable, type ErrorKind } from "./fallback.js"
import { abortableDelay } from "./retry.js"

export interface DispatchPolicy {
  signal?: AbortSignal
  /** Shared across workers of one plugin instance, keyed by provider ID. */
  cooldowns?: Map<string, number>
  baseDelayMs?: number
  maxWaitMs?: number
  now?: () => number
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** Retry-After may be seconds or an HTTP date; never shorten a server deadline. */
export function retryAfterMs(error: unknown, now: number): number | undefined {
  if (!error || typeof error !== "object") return undefined
  const value = error as { headers?: unknown; responseHeaders?: unknown; response?: { headers?: unknown } }
  const headers = value.response?.headers ?? value.responseHeaders ?? value.headers
  let raw: unknown
  if (headers instanceof Headers) raw = headers.get("retry-after")
  else if (headers && typeof headers === "object") {
    raw = Object.entries(headers).find(([key]) => key.toLowerCase() === "retry-after")?.[1]
  }
  if (typeof raw !== "string" && typeof raw !== "number") return undefined
  const seconds = Number(raw)
  if (String(raw).trim() && Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(String(raw))
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined
}

export interface DispatchAttempt {
  attempt: number
  model: string
  outcome: "failed" | "succeeded"
  errorKind?: ErrorKind
}

export type DispatchEvent =
  | DispatchAttempt
  | { attempt: number; model: string; outcome: "retried"; nextModel: string }

export type DispatchResult<T> =
  | { ok: true; model: string; value: T; attempts: DispatchAttempt[] }
  | { ok: false; errorKind: ErrorKind; attempts: DispatchAttempt[]; retryAfterMs?: number }

/** Execute a bounded model chain and fail over only for explicitly retryable errors. */
export async function dispatchWithFallback<T>(
  models: string[],
  execute: (model: string, attempt: number) => Promise<T>,
  onEvent?: (event: DispatchEvent) => void | Promise<void>,
  policy: DispatchPolicy = {},
): Promise<DispatchResult<T>> {
  const ordered = [...new Set(models)]
  const attempts: DispatchAttempt[] = []
  let lastKind: ErrorKind = "other"
  const cooldowns = policy.cooldowns ?? new Map<string, number>()
  const now = policy.now ?? Date.now
  const wait = policy.wait ?? abortableDelay
  const baseDelay = policy.baseDelayMs ?? 500
  const maxWait = policy.maxWaitMs ?? 5_000
  let waited = 0
  let nextAttemptAt = 0
  let deferredUntil = Infinity

  for (let index = 0; index < ordered.length; index += 1) {
    const model = ordered[index]!
    const provider = model.split("/")[0]!
    policy.signal?.throwIfAborted()
    // Recheck after waking: another concurrent worker may extend the deadline.
    let skip = false
    while (true) {
      const delay = Math.max(0, nextAttemptAt - now(), (cooldowns.get(provider) ?? 0) - now())
      if (!delay) break
      if (waited + delay > maxWait) { deferredUntil = Math.min(deferredUntil, now() + delay); skip = true; break }
      await wait(delay, policy.signal)
      waited += delay
    }
    if (skip) continue
    const attempt = attempts.length + 1
    if (attempt > 1) await onEvent?.({ attempt, model, outcome: "retried", nextModel: model })
    policy.signal?.throwIfAborted()
    let value: T
    try {
      value = await execute(model, attempt)
    } catch (error) {
      policy.signal?.throwIfAborted()
      if (error instanceof Error && error.name === "AbortError") throw error
      lastKind = classifyError(error).kind
      const event: DispatchAttempt = { attempt, model, outcome: "failed", errorKind: lastKind }
      attempts.push(event)
      if (isRetryable(lastKind)) {
        const backoff = Math.min(maxWait, baseDelay * 2 ** (attempt - 1))
        nextAttemptAt = now() + backoff
        const deadline = now() + Math.max(backoff, retryAfterMs(error, now()) ?? 0)
        cooldowns.set(provider, Math.max(cooldowns.get(provider) ?? 0, deadline))
        for (const [key, until] of cooldowns) if (until <= now()) cooldowns.delete(key)
      }
      await onEvent?.(event)
      if (!isRetryable(lastKind)) break
      continue
    }
    const event: DispatchAttempt = { attempt, model, outcome: "succeeded" }
    attempts.push(event)
    await onEvent?.(event)
    return { ok: true, model, value, attempts }
  }

  return { ok: false, errorKind: lastKind, attempts,
    ...(Number.isFinite(deferredUntil) ? { retryAfterMs: Math.max(0, deferredUntil - now()) } : {}) }
}
