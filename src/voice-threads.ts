import { execFile as nodeExecFile } from 'node:child_process'
import { readFile as nodeReadFile } from 'node:fs/promises'
import os from 'node:os'

/**
 * Thread count for local whisper.cpp inference. whisper.cpp defaults to
 * `min(4, logical cores)`, which leaves most of a modern CPU idle. We prefer
 * the number of physical cores (SMT siblings do not help the GEMM-heavy
 * encoder) and let the user override it with `ORCHESTRA_VOICE_THREADS`.
 */
export interface PhysicalCoreDeps {
  platform?: NodeJS.Platform
  logical?: number
  env?: NodeJS.ProcessEnv
  readFile?: (path: string) => Promise<string>
  /** Runs a command and resolves its stdout; rejects when the command is absent. */
  run?: (file: string, args: string[]) => Promise<string>
}

const MAX_THREADS = 128

export function threadOverride(env: NodeJS.ProcessEnv): number | null {
  const raw = env.ORCHESTRA_VOICE_THREADS
  if (raw === undefined || raw.trim() === '') return null
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > MAX_THREADS) return null
  return value
}

/** Unique `physical id`/`core id` pairs from Linux /proc/cpuinfo. */
export function parseProcCpuinfo(text: string): number | null {
  const pairs = new Set<string>()
  let physical: string | undefined
  let core: string | undefined
  const flush = () => {
    if (core !== undefined) pairs.add(`${physical ?? '0'}:${core}`)
    physical = undefined
    core = undefined
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') {
      flush()
      continue
    }
    const physicalMatch = /^physical id\s*:\s*(\d+)$/.exec(trimmed)
    if (physicalMatch) {
      physical = physicalMatch[1]
      continue
    }
    const coreMatch = /^core id\s*:\s*(\d+)$/.exec(trimmed)
    if (coreMatch) core = coreMatch[1]
  }
  flush()
  return pairs.size > 0 ? pairs.size : null
}

/**
 * `wmic cpu get NumberOfCores /value` prints `NumberOfCores=8` per socket;
 * PowerShell prints a single number. Sum across sockets.
 */
export function parseCoreCountOutput(text: string): number | null {
  let sum = 0
  let found = false
  for (const match of text.matchAll(/(?:^|[=\s])(\d+)(?=\s|$)/g)) {
    const value = Number(match[1])
    if (Number.isInteger(value) && value > 0 && value <= 1024) {
      sum += value
      found = true
    }
  }
  return found ? sum : null
}

/** No SMT information available: assume 2-way SMT on even logical counts. */
export function fallbackPhysicalCores(logical: number): number {
  if (logical <= 1) return 1
  if (logical <= 3) return logical
  if (logical % 2 === 0) return Math.floor(logical / 2)
  return logical
}

function defaultRun(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    nodeExecFile(file, args, { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(String(stdout))
    })
  })
}

export async function physicalCoreCount(deps: PhysicalCoreDeps = {}): Promise<number> {
  const platform = deps.platform ?? process.platform
  const logical = deps.logical ?? (os.availableParallelism?.() ?? os.cpus().length) ?? 1
  const readFile = deps.readFile ?? (async (file: string) => String(await nodeReadFile(file, 'utf8')))
  const run = deps.run ?? defaultRun
  if (platform === 'linux') {
    try {
      const parsed = parseProcCpuinfo(await readFile('/proc/cpuinfo'))
      if (parsed !== null) return Math.min(parsed, logical)
    } catch { /* fall through to the heuristic */ }
  }
  if (platform === 'win32') {
    try {
      const parsed = parseCoreCountOutput(await run('wmic', ['cpu', 'get', 'NumberOfCores', '/value']))
      if (parsed !== null) return Math.min(parsed, logical)
    } catch { /* wmic is deprecated; try PowerShell */ }
    try {
      const parsed = parseCoreCountOutput(await run('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        '(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum',
      ]))
      if (parsed !== null) return Math.min(parsed, logical)
    } catch { /* fall through to the heuristic */ }
  }
  return Math.max(1, Math.min(fallbackPhysicalCores(logical), logical))
}

let cachedPhysical: Promise<number> | undefined

export async function voiceThreadCount(
  env: NodeJS.ProcessEnv = process.env,
  deps?: PhysicalCoreDeps,
): Promise<number> {
  const override = threadOverride(env)
  if (override !== null) return override
  if (deps) return physicalCoreCount(deps)
  cachedPhysical ??= physicalCoreCount({})
  return cachedPhysical
}
