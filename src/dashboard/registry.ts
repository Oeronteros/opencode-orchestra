import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
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

export function projectId(directory: string): string {
  return createHash("sha256").update(path.resolve(directory)).digest("hex").slice(0, 16)
}

export async function registerProject(directory: string, configDirectory: string): Promise<void> {
  const resolved = path.resolve(directory)
  const file = registryPath(configDirectory)
  let projects: RegisteredProject[] = []
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { projects?: RegisteredProject[] }
    if (Array.isArray(parsed.projects)) projects = parsed.projects
  } catch {
    // A missing or corrupt registry is rebuilt from the current project.
  }
  const current: RegisteredProject = { id: projectId(resolved), name: path.basename(resolved), directory: resolved, lastSeenAt: new Date().toISOString() }
  const next = [...projects.filter((project) => project.directory !== resolved), current]
  await mkdir(configDirectory, { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  await writeFile(temporary, `${JSON.stringify({ version: 1, projects: next }, null, 2)}\n`, "utf8")
  await rename(temporary, file)
}

export async function readProjects(configDirectory: string): Promise<RegisteredProject[]> {
  try {
    const parsed = JSON.parse(await readFile(registryPath(configDirectory), "utf8")) as { projects?: RegisteredProject[] }
    return Array.isArray(parsed.projects) ? parsed.projects.filter((project) => typeof project.directory === "string") : []
  } catch {
    return []
  }
}
