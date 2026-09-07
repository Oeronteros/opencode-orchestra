import { classifyError, isRetryable, type ErrorKind } from "./fallback.js"

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
  | { ok: false; errorKind: ErrorKind; attempts: DispatchAttempt[] }

/** Execute a bounded model chain and fail over only for explicitly retryable errors. */
export async function dispatchWithFallback<T>(
  models: string[],
  execute: (model: string, attempt: number) => Promise<T>,
  onEvent?: (event: DispatchEvent) => void | Promise<void>,
): Promise<DispatchResult<T>> {
  const ordered = [...new Set(models)]
  const attempts: DispatchAttempt[] = []
  let lastKind: ErrorKind = "other"

  for (let index = 0; index < ordered.length; index += 1) {
    const model = ordered[index]!
    const attempt = index + 1
    if (index > 0) await onEvent?.({ attempt, model, outcome: "retried", nextModel: model })
    try {
      const value = await execute(model, attempt)
      const event: DispatchAttempt = { attempt, model, outcome: "succeeded" }
      attempts.push(event)
      await onEvent?.(event)
      return { ok: true, model, value, attempts }
    } catch (error) {
      lastKind = classifyError(error).kind
      const event: DispatchAttempt = { attempt, model, outcome: "failed", errorKind: lastKind }
      attempts.push(event)
      await onEvent?.(event)
      if (!isRetryable(lastKind)) break
    }
  }

  return { ok: false, errorKind: lastKind, attempts }
}
