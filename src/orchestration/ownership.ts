export interface OwnershipPartition { id: string; paths: string[] }

export function normalizeOwnedPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "")
  if (!normalized || normalized.includes("\0") || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) throw new Error("ownership path must be repository-relative: " + path)
  return normalized
}
function overlaps(a: string, b: string): boolean { return a === b || a.startsWith(b + "/") || b.startsWith(a + "/") }
export function validateOwnership(partitions: OwnershipPartition[]): string[] {
  const errors: string[] = []
  const normalized = partitions.map((p) => ({ id: p.id, paths: p.paths.map((path) => { try { return normalizeOwnedPath(path) } catch (e) { errors.push((e as Error).message); return "" } }).filter(Boolean) }))
  for (let i = 0; i < normalized.length; i++) for (let j = i + 1; j < normalized.length; j++) for (const a of normalized[i]!.paths) for (const b of normalized[j]!.paths) if (overlaps(a, b)) errors.push("ownership overlap: " + normalized[i]!.id + ":" + a + " and " + normalized[j]!.id + ":" + b)
  return [...new Set(errors)].sort()
}
export function validateChangedFiles(partitions: OwnershipPartition[], changed: Record<string, string[]>): string[] {
  const errors = validateOwnership(partitions)
  const byId = new Map(partitions.map((p) => [p.id, p.paths.map(normalizeOwnedPath)]))
  for (const [id, files] of Object.entries(changed)) for (const raw of files) { let file: string; try { file = normalizeOwnedPath(raw) } catch (e) { errors.push((e as Error).message); continue }; const owners = [...byId].filter(([, paths]) => paths.some((p) => file === p || file.startsWith(p + "/"))).map(([owner]) => owner); if (owners.length !== 1 || owners[0] !== id) errors.push("changed file " + file + " is not exclusively owned by " + id) }
  return [...new Set(errors)].sort()
}
