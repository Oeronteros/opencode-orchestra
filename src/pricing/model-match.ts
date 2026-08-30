// Pure model-identity normalization and matching. Zero I/O: these helpers turn
// an arbitrary raw model id ("CX/GPT-5.6 Sol") into a canonical normalized
// form ("gpt-5-6-sol") that pricing lookups key on, without collapsing
// genuinely different models into one another.

export interface ModelEntry {
  /** Canonical normalized model id, e.g. "gpt-5-6-sol" (no provider prefix). */
  id: string
  /** Optional provider hint, normalized (e.g. "openai"). */
  provider?: string
  /** Raw display names that map to this entry, e.g. "GPT-5.6 Sol". */
  aliases?: string[]
}

export type MatchMethod = "exact" | "alias" | "keyword" | "fuzzy" | "none"

export interface ModelMatch {
  /** Canonical normalized model id (best effort when method is "none"). */
  canonical: string
  /** How the match was established. */
  method: MatchMethod
  /** Fuzzy tier only: score gap to the runner-up candidate. */
  margin?: number
  /** True when several catalog entries could match and the raw id lacks a discriminator. */
  familyAmbiguous?: boolean
}

export interface ParsedModelId {
  /** Normalized provider prefix ("cx"), empty when the raw id had no "/". */
  provider: string
  /** Normalized base model name ("gpt-5-6-sol"). */
  model: string
  /** Optional pricing variant suffix (":free", ":thinking", ...). */
  variant?: string
  /** The raw id as passed in. */
  raw: string
}

/** Lowercase and fold all non-alphanumeric separators into "-". */
export function normalizeModelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/** Split a raw id at the FIRST slash only; later slashes belong to the model part. */
export function splitProviderId(raw: string): { provider: string; rest: string } {
  const idx = raw.indexOf("/")
  if (idx === -1) return { provider: "", rest: raw }
  return { provider: raw.slice(0, idx).trim(), rest: raw.slice(idx + 1) }
}

/**
 * Parse a raw model id into a normalized provider / model / variant triple.
 * Variants are OpenRouter-style ":suffix" segments that change pricing
 * ("x:free") and must not block matching the base model.
 */
export function parseModelId(raw: string): ParsedModelId {
  const { provider, rest } = splitProviderId(raw)
  const variantIdx = rest.lastIndexOf(":")
  const base = variantIdx === -1 ? rest : rest.slice(0, variantIdx)
  const variant = variantIdx === -1 ? undefined : rest.slice(variantIdx + 1).trim()
  return {
    provider: provider.toLowerCase(),
    model: normalizeModelName(base),
    ...(variant ? { variant } : {}),
    raw,
  }
}

function tokensOf(normalized: string): string[] {
  return normalized.split("-").filter(Boolean)
}

function hasAllTokens(entryTokens: Set<string>, candidateTokens: string[]): boolean {
  return candidateTokens.every((token) => entryTokens.has(token))
}

function entryTokenSet(entry: ModelEntry): Set<string> {
  const set = new Set(tokensOf(entry.id))
  for (const alias of entry.aliases ?? []) {
    for (const token of tokensOf(normalizeModelName(alias))) set.add(token)
  }
  return set
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  return out
}

function bigramDice(a: string, b: string): number {
  if (a === b) return 1
  const A = bigrams(a)
  const B = bigrams(b)
  if (A.size === 0 || B.size === 0) return 0
  let shared = 0
  for (const gram of A) if (B.has(gram)) shared += 1
  return (2 * shared) / (A.size + B.size)
}

export interface MatchOptions {
  /** Minimum bigram-Dice similarity for the fuzzy tier. */
  fuzzyThreshold?: number
  /** Minimum score gap over the runner-up for the fuzzy tier. */
  fuzzyMargin?: number
}

const DEFAULT_FUZZY_THRESHOLD = 0.85
const DEFAULT_FUZZY_MARGIN = 0.1

/**
 * Resolve a raw model id against a catalog of known models.
 *
 * Ladder: exact normalized id -> normalized alias -> keyword (all raw tokens
 * present in exactly one entry) -> gated fuzzy similarity. The keyword tier
 * short-circuits with `familyAmbiguous` when several entries could fit, so
 * "gpt-5.6" never silently becomes "gpt-5.6-sol" when family members exist.
 * A raw id with an extra wrapper namespace ("provider/custom-prefix/X") is
 * retried with the final path segment as the base model.
 */
export function matchModel(rawId: string, entries: ModelEntry[], opts?: MatchOptions): ModelMatch {
  const threshold = opts?.fuzzyThreshold ?? DEFAULT_FUZZY_THRESHOLD
  const margin = opts?.fuzzyMargin ?? DEFAULT_FUZZY_MARGIN
  const { provider, rest } = splitProviderId(rawId)
  const variantIdx = rest.lastIndexOf(":")
  const baseRest = variantIdx === -1 ? rest : rest.slice(0, variantIdx)

  const tries = [baseRest]
  if (baseRest.includes("/")) {
    const last = baseRest.slice(baseRest.lastIndexOf("/") + 1)
    if (last !== baseRest) tries.push(last)
  }

  const seen = new Set<string>()
  const norms: string[] = []
  for (const attempt of tries) {
    const norm = normalizeModelName(attempt)
    if (seen.has(norm)) continue
    seen.add(norm)
    norms.push(norm)
  }

  // Exact/alias across every stripped form first so a wrapper prefix cannot
  // win a fuzzy match before the base model id is tried.
  for (const norm of norms) {
    const exact = entries.find((entry) => entry.id === norm)
    if (exact) return { canonical: exact.id, method: "exact" }

    const alias = entries.find((entry) => (entry.aliases ?? []).some((a) => normalizeModelName(a) === norm))
    if (alias) return { canonical: alias.id, method: "alias" }
  }

  for (const norm of norms) {
    const candidateTokens = tokensOf(norm)
    if (candidateTokens.length === 0) continue
    const keywordHits = entries.filter((entry) => hasAllTokens(entryTokenSet(entry), candidateTokens))
    if (keywordHits.length === 1) {
      return { canonical: keywordHits[0]!.id, method: "keyword" }
    }
    if (keywordHits.length > 1) {
      return { canonical: norm, method: "none", familyAmbiguous: true }
    }

    const scored = entries
      .map((entry) => {
        if (provider && entry.provider && entry.provider !== provider) return undefined
        const score = Math.max(bigramDice(norm, entry.id), ...(entry.aliases ?? []).map((a) => bigramDice(norm, normalizeModelName(a))))
        return { entry, score }
      })
      .filter((item): item is { entry: ModelEntry; score: number } => item !== undefined && item.score >= threshold)
      .sort((a, b) => b.score - a.score)

    if (scored.length === 0) continue
    const top = scored[0]!
    const runnerUp = scored[1]?.score ?? 0
    const gap = top.score - runnerUp
    if (gap >= margin) {
      return { canonical: top.entry.id, method: "fuzzy", margin: gap }
    }
    return { canonical: norm, method: "none", familyAmbiguous: scored.length > 1 }
  }

  return { canonical: normalizeModelName(baseRest), method: "none" }
}
