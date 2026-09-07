export interface RankedModel {
  id: string
  provider: string
  name: string
  score: number
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[_./:-]+/g, " ").replace(/\s+/g, " ")
}

function modelParts(id: string): { provider: string; name: string } {
  const separator = id.indexOf("/")
  return separator < 0
    ? { provider: "", name: id }
    : { provider: id.slice(0, separator), name: id.slice(separator + 1) }
}

function scoreModel(id: string, query: string): number | undefined {
  const normalizedQuery = normalize(query)
  if (!normalizedQuery) return 100

  const { provider, name } = modelParts(id)
  const full = normalize(id)
  const model = normalize(name)
  const providerName = normalize(provider)
  const tokens = normalizedQuery.split(" ")

  if (full === normalizedQuery) return 0
  if (model === normalizedQuery) return 1
  if (model.startsWith(normalizedQuery)) return 2
  if (full.startsWith(normalizedQuery)) return 3
  if (providerName === normalizedQuery) return 4
  if (tokens.every((token) => full.includes(token))) {
    return 10 + tokens.reduce((sum, token) => sum + full.indexOf(token), 0) / 1_000
  }
  if (model.includes(normalizedQuery)) return 20 + model.indexOf(normalizedQuery) / 1_000
  if (full.includes(normalizedQuery)) return 30 + full.indexOf(normalizedQuery) / 1_000
  return undefined
}

/** Deterministic, case-insensitive ranking for provider/model identifiers. */
export function rankModels(models: string[], query: string): RankedModel[] {
  return [...new Set(models)].flatMap((id) => {
    const score = scoreModel(id, query)
    if (score === undefined) return []
    const { provider, name } = modelParts(id)
    return [{ id, provider, name, score }]
  }).sort((a, b) => a.score - b.score || a.id.localeCompare(b.id))
}
