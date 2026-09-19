import { createHash } from "node:crypto"
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import path from "node:path"

export interface RegisteredProject {
  id: string
  name: string
  directory: string
  lastSeenAt: string
}

function registryPath(configDirectory: string): string {
  return path.join(configDirectory, "orchestra-projects.json")
}

async function existingProjects(projects: RegisteredProject[]): Promise<RegisteredProject[]> {
  const checked = await Promise.all(projects.map(async (project) => {
    if (typeof project?.directory !== "string") return undefined
    const directory = path.resolve(project.directory)
    try {
      if (!(await stat(directory)).isDirectory()) return undefined
    } catch {
      return undefined
    }
    return {
      id: projectId(directory),
      name: path.basename(directory),
      directory,
      lastSeenAt: typeof project.lastSeenAt === "string" ? project.lastSeenAt : new Date(0).toISOString(),
    }
  }))
  return checked.filter((project): project is RegisteredProject => project !== undefined)
}

async function loadProjects(file: string): Promise<RegisteredProject[]> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { projects?: RegisteredProject[] }
    return Array.isArray(parsed.projects) ? existingProjects(parsed.projects) : []
  } catch {
    return []
  }
}

async function saveProjects(file: string, projects: RegisteredProject[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  await writeFile(temporary, `${JSON.stringify({ version: 1, projects }, null, 2)}\n`, "utf8")
  await rename(temporary, file)
}

export function projectId(directory: string): string {
  return createHash("sha256").update(path.resolve(directory)).digest("hex").slice(0, 16)
}

export async function registerProject(directory: string, configDirectory: string): Promise<void> {
  const resolved = path.resolve(directory)
  const file = registryPath(configDirectory)
  const projects = await loadProjects(file)
  const current: RegisteredProject = { id: projectId(resolved), name: path.basename(resolved), directory: resolved, lastSeenAt: new Date().toISOString() }
  const next = [...projects.filter((project) => project.directory !== resolved), current]
  await saveProjects(file, next)
}

export async function readProjects(configDirectory: string): Promise<RegisteredProject[]> {
  return loadProjects(registryPath(configDirectory))
}
