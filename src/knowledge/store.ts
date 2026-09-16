import { createHash } from "node:crypto"
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { systemGit, type GitRunner } from "../orchestration/worktrees.js"

export type KnowledgeKind = "decision" | "test-command" | "constraint"

export interface KnowledgeEntry {
  id: string
  kind: KnowledgeKind
  value: string
  evidence: string[]
  paths: string[]
  sourceRun: string
  sourcePlanVersion: number
  revision: string
  pathFingerprints?: Record<string, string>
  createdAt: number
  expiresAt?: number
}

export interface KnowledgeMatch extends KnowledgeEntry {
  status: "valid" | "stale"
  staleReason?: string
}

interface KnowledgeFile {
  version: 1
  updatedAt: number
  entries: KnowledgeEntry[]
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").trim()
  if (!normalized || normalized === ".." || normalized.startsWith("../") || path.isAbsolute(normalized)) {
    throw new Error(`Knowledge path must stay inside the repository: ${value}`)
  }
  return normalized
}

export class VerifiedKnowledgeStore {
  private readonly file: string
  private loaded?: KnowledgeFile
  private writes: Promise<void> = Promise.resolve()

  constructor(
    private readonly projectDirectory: string,
    directory = ".orchestra/knowledge",
    private readonly enabled = true,
    private readonly maxEntries = 256,
    private readonly git: GitRunner = systemGit,
  ) {
    this.file = path.join(path.resolve(projectDirectory, directory), "verified.json")
  }

  async record(input: {
    kind: KnowledgeKind
    value: string
    evidence: string[]
    paths: string[]
    sourceRun: string
    sourcePlanVersion: number
    ttlDays?: number
  }): Promise<KnowledgeEntry> {
    if (!this.enabled) throw new Error("Verified knowledge is disabled.")
    const value = input.value.replace(/\s+/g, " ").trim()
    if (!value) throw new Error("Knowledge value is empty.")
    const evidence = input.evidence.map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean)
    if (evidence.length === 0) throw new Error("Verified knowledge requires evidence.")
    const paths = [...new Set(input.paths.map(normalizePath))].sort()
    if (paths.length === 0) throw new Error("Verified knowledge requires at least one repository path.")
    const revision = await this.revision()
    const pathFingerprints = Object.fromEntries(await Promise.all(paths.map(async (item) => [item, await this.fingerprint(item)] as const)))
    const createdAt = Date.now()
    const id = createHash("sha256").update(`${input.kind}\0${value}\0${paths.join("\0")}`).digest("hex").slice(0, 20)
    const entry: KnowledgeEntry = {
      id,
      kind: input.kind,
      value: value.slice(0, 2_000),
      evidence: evidence.map((item) => item.slice(0, 500)).slice(0, 16),
      paths,
      sourceRun: input.sourceRun,
      sourcePlanVersion: input.sourcePlanVersion,
      revision,
      pathFingerprints,
      createdAt,
      ...(input.ttlDays && input.ttlDays > 0 ? { expiresAt: createdAt + input.ttlDays * 86_400_000 } : {}),
    }
    const state = await this.state()
    state.entries = [entry, ...state.entries.filter((candidate) => candidate.id !== id)].slice(0, this.maxEntries)
    state.updatedAt = createdAt
    await this.save(state)
    return { ...entry, evidence: [...entry.evidence], paths: [...entry.paths] }
  }

  async query(text: string, paths: string[] = []): Promise<KnowledgeMatch[]> {
    if (!this.enabled) return []
    const state = await this.state()
    const terms = text.toLocaleLowerCase("en-US").split(/[^\p{L}\p{N}_.-]+/u).filter((term) => term.length > 2)
    const requestedPaths = new Set(paths.map(normalizePath))
    const scored = state.entries.map((entry) => {
      const haystack = `${entry.kind} ${entry.value} ${entry.paths.join(" ")}`.toLocaleLowerCase("en-US")
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0)
        + entry.paths.reduce((total, item) => total + (requestedPaths.has(item) ? 2 : 0), 0)
      return { entry, score }
    }).filter(({ score }) => terms.length === 0 || score > 0)
      .sort((left, right) => right.score - left.score || right.entry.createdAt - left.entry.createdAt)
      .slice(0, 24)
    const matches: KnowledgeMatch[] = []
    for (const { entry } of scored) matches.push({ ...entry, evidence: [...entry.evidence], paths: [...entry.paths], ...await this.validity(entry) })
    return matches
  }

  private async validity(entry: KnowledgeEntry): Promise<Pick<KnowledgeMatch, "status" | "staleReason">> {
    if (entry.expiresAt && entry.expiresAt <= Date.now()) return { status: "stale", staleReason: "expired" }
    const revision = await this.revision()
    if (entry.revision === "unversioned" || revision === "unversioned") return { status: "stale", staleReason: "repository revision unavailable" }
    if (entry.pathFingerprints) {
      for (const item of entry.paths) {
        try {
          if (await this.fingerprint(item) !== entry.pathFingerprints[item]) return { status: "stale", staleReason: "referenced path content changed after verification" }
        } catch {
          return { status: "stale", staleReason: "referenced path is missing, unreadable, or not a regular file" }
        }
      }
      return { status: "valid" }
    }
    const dirty = await this.git.run(["status", "--porcelain", "--untracked-files=all", "--", ...entry.paths], this.projectDirectory)
    if (dirty.exitCode !== 0) return { status: "stale", staleReason: "unable to inspect working tree" }
    if (dirty.stdout.trim()) return { status: "stale", staleReason: "referenced paths have uncommitted changes" }
    if (entry.revision !== revision) {
      const changed = await this.git.run(["diff", "--name-only", `${entry.revision}..${revision}`, "--", ...entry.paths], this.projectDirectory)
      if (changed.exitCode !== 0) return { status: "stale", staleReason: "source revision is no longer comparable" }
      if (changed.stdout.trim()) return { status: "stale", staleReason: "referenced paths changed after verification" }
    }
    return { status: "valid" }
  }

  private async fingerprint(item: string): Promise<string> {
    try {
      const target = path.resolve(this.projectDirectory, item)
      const info = await stat(target)
      if (!info.isFile()) throw new Error(`Knowledge path must be a regular file: ${item}`)
      const content = await readFile(target)
      return createHash("sha256").update(content).digest("hex")
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Knowledge path must be a regular file:")) throw error
      throw new Error(`Unable to fingerprint knowledge path ${item}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async revision(): Promise<string> {
    const result = await this.git.run(["rev-parse", "HEAD"], this.projectDirectory).catch(() => ({ stdout: "", stderr: "", exitCode: 1 }))
    return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : "unversioned"
  }

  private async state(): Promise<KnowledgeFile> {
    if (this.loaded) return this.loaded
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as KnowledgeFile
      this.loaded = parsed?.version === 1 && Array.isArray(parsed.entries) ? parsed : { version: 1, updatedAt: Date.now(), entries: [] }
    } catch {
      this.loaded = { version: 1, updatedAt: Date.now(), entries: [] }
    }
    return this.loaded
  }

  private async save(state: KnowledgeFile): Promise<void> {
    const content = `${JSON.stringify(state, null, 2)}\n`
    this.writes = this.writes.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true })
      const temporary = `${this.file}.${process.pid}.tmp`
      await writeFile(temporary, content, "utf8")
      await rename(temporary, this.file)
    })
    await this.writes
  }
}
