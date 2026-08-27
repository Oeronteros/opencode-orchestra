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

export interface EditorCommit { id: string; commit: string; changed: string[] }
export interface ConflictReportEditor { id: string; commit: string; changed: string[]; violations: string[] }
export interface ConflictReport { editors: ConflictReportEditor[]; conflictingPaths: string[]; ownershipViolations: string[]; order: string[]; clean: boolean }

export function buildConflictReport(partitions: OwnershipPartition[], commits: EditorCommit[]): ConflictReport {
  const normalizedByEditor: Record<string, string[]> = {}
  for (const commit of commits) {
    const normalized: string[] = []
    for (const raw of commit.changed) { try { normalized.push(normalizeOwnedPath(raw)) } catch { /* normalization errors are collected by validateChangedFiles below */ } }
    normalizedByEditor[commit.id] = [...new Set(normalized)].sort()
  }
  const editors: ConflictReportEditor[] = commits
    .map((commit) => ({ id: commit.id, commit: commit.commit, changed: normalizedByEditor[commit.id] ?? [], violations: validateChangedFiles(partitions, { [commit.id]: commit.changed }) }))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const ownershipViolations = [...new Set(editors.flatMap((editor) => editor.violations))].sort()
  const claims = new Map<string, number>()
  for (const paths of Object.values(normalizedByEditor)) for (const path of new Set(paths)) claims.set(path, (claims.get(path) ?? 0) + 1)
  const conflictingPaths = [...claims].filter(([, count]) => count > 1).map(([path]) => path).sort()
  const order = [...new Set(commits.map((commit) => commit.id))].sort()
  return { editors, conflictingPaths, ownershipViolations, order, clean: conflictingPaths.length === 0 && ownershipViolations.length === 0 }
}
