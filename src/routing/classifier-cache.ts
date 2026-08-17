import type { Classification } from "./classifier.js"

/**
 * Memoized classification cache: near-duplicate tasks reuse a previous
 * classification instead of re-running the (judge-token-burning) classifier.
 * Content-addressed by a normalized fingerprint and LRU-bounded in process.
 */

export interface CacheEntry {
  key: string
  classification: Classification
  createdAt: number
  hits: number
  lastHit: number
}

export interface ClassifierCacheOptions {
  maxEntries?: number
}

/** Normalize a task into a stable fingerprint (case/punct/whitespace folding). */
export function fingerprint(task: string): string {
  return task
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function createClassifierCache(options: ClassifierCacheOptions = {}) {
  const maxEntries = options.maxEntries ?? 256
  const map = new Map<string, CacheEntry>()

  function touch(entry: CacheEntry): void {
    map.delete(entry.key)
    map.set(entry.key, entry)
  }

  return {
    get(task: string): Classification | undefined {
      const key = fingerprint(task)
      const entry = map.get(key)
      if (!entry) return undefined
      entry.hits += 1
      entry.lastHit = Date.now()
      touch(entry)
      return entry.classification
    },
    set(task: string, classification: Classification): void {
      const key = fingerprint(task)
      const now = Date.now()
      const entry: CacheEntry = { key, classification, createdAt: now, hits: 0, lastHit: now }
      map.set(key, entry)
      while (map.size > maxEntries) {
        const oldest = map.keys().next().value
        if (oldest === undefined) break
        map.delete(oldest)
      }
    },
    clear(): void {
      map.clear()
    },
    size: () => map.size,
  }
}

export type ClassifierCache = ReturnType<typeof createClassifierCache>
