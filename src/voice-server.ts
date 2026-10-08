import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { voiceServerSidecarName, voiceSidecarNames } from './voice.js'

export type SpawnFn = (
  command: string,
  args: string[],
  options: { windowsHide: boolean },
) => ChildProcess

export interface WhisperServerOptions {
  serverPath: string
  modelPath: string
  threads: number
  spawn?: SpawnFn | undefined
  fetch?: typeof fetch | undefined
  readyTimeoutMs?: number | undefined
  /** Test seam: override argv construction. */
  args?: ((port: number, options: WhisperServerOptions) => string[]) | undefined
}

export function whisperServerArgs(port: number, modelPath: string, threads: number): string[] {
  return ['-m', modelPath, '-t', String(threads), '--host', '127.0.0.1', '--port', String(port)]
}

export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.unref()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => {
        if (port > 0) resolve(port)
        else reject(new Error('no free loopback port'))
      })
    })
  })
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(new Error('aborted'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

/**
 * A long-lived `whisper-server` child: the model stays loaded between
 * dictations, which removes the per-request model load and process startup.
 * Requests are serialized; the server holds a single context.
 */
export class WhisperServer {
  private child: ChildProcess | undefined
  private port = 0
  private stderrTail = ''
  private startError: Error | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private disposed = false

  constructor(readonly options: WhisperServerOptions) {}

  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null && !this.child.killed
  }

  async transcribe(wav: Buffer, language: string, signal?: AbortSignal): Promise<string> {
    const task = this.queue.then(() => this.request(wav, language, signal))
    this.queue = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  private async request(wav: Buffer, language: string, signal?: AbortSignal): Promise<string> {
    if (this.disposed) throw new Error('transcribe-failed: whisper-server остановлен')
    try {
      await this.ensureStarted(signal)
    } catch (error) {
      if (signal?.aborted) {
        await this.kill()
        throw new Error('cancelled: распознавание отменено')
      }
      throw error
    }
    const form = new FormData()
    form.append('file', new Blob([Uint8Array.from(wav)], { type: 'audio/wav' }), 'audio.wav')
    form.append('language', language)
    form.append('response_format', 'text')
    const timeout = AbortSignal.timeout(600_000)
    // Do not abort the fetch body itself: Node's undici can throw an internal
    // ReadableStream error when a FormData upload is aborted mid-flight.
    const pending = this.fetchImpl(`http://127.0.0.1:${this.port}/inference`, {
      method: 'POST',
      body: form,
      signal: timeout,
    })
    pending.catch(() => undefined)
    let response: Response
    try {
      response = await raceAbort(pending, signal)
    } catch (error) {
      if (signal?.aborted) {
        // The server may still be busy with the aborted request; restart it
        // for the next dictation instead of queueing behind dead work.
        await this.kill()
        throw new Error('cancelled: распознавание отменено')
      }
      throw new Error(
        `transcribe-failed: whisper-server недоступен: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (!response.ok) {
      throw new Error(`transcribe-failed: whisper-server http ${response.status}`)
    }
    return (await response.text()).trim()
  }

  private async ensureStarted(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('aborted')
    if (this.running) return
    if (this.child !== undefined) await this.kill()
    this.stderrTail = ''
    this.startError = null
    this.port = await pickFreePort()
    const args = this.options.args
      ? this.options.args(this.port, this.options)
      : whisperServerArgs(this.port, this.options.modelPath, this.options.threads)
    const child = this.spawnImpl(this.options.serverPath, args, { windowsHide: true })
    this.child = child
    // Parent exits (voice-editor finishes, crash) must not orphan the model
    // process on Windows: kill it synchronously from the exit hook.
    const killOnExit = () => {
      try { child.kill() } catch { /* already gone */ }
    }
    process.once('exit', killOnExit)
    child.once('exit', () => process.removeListener('exit', killOnExit))
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4000)
    })
    child.stdout?.resume()
    child.once('error', (error) => {
      this.startError = error instanceof Error ? error : new Error(String(error))
    })
    child.once('exit', () => {
      if (this.child === child) this.child = undefined
    })
    await this.waitReady(signal)
  }

  private async waitReady(signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? 120_000)
    for (;;) {
      if (signal?.aborted) throw new Error('aborted')
      if (this.disposed) throw new Error('transcribe-failed: whisper-server остановлен')
      if (this.startError !== null) {
        throw new Error(`transcribe-failed: не удалось запустить whisper-server: ${this.startError.message}`)
      }
      if (!this.running) {
        throw new Error(`transcribe-failed: whisper-server завершился: ${this.stderrTail.trim()}`)
      }
      try {
        await this.fetchImpl(`http://127.0.0.1:${this.port}/`, {
          signal: signal === undefined ? AbortSignal.timeout(1500)
            : AbortSignal.any([signal, AbortSignal.timeout(1500)]),
        })
        return
      } catch { /* not listening yet */ }
      if (Date.now() > deadline) {
        throw new Error('transcribe-failed: whisper-server не запустился вовремя')
      }
      await delay(150, undefined, signal === undefined ? {} : { signal })
    }
  }

  async kill(): Promise<void> {
    const child = this.child
    this.child = undefined
    if (child === undefined || child.exitCode !== null) return
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill()
    await Promise.race([
      exited,
      delay(3000).then(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }),
    ])
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.kill()
  }

  private get spawnImpl(): SpawnFn {
    return this.options.spawn ?? (nodeSpawn as unknown as SpawnFn)
  }

  private get fetchImpl(): typeof fetch {
    return this.options.fetch ?? fetch
  }
}

/** Path candidates for a whisper sidecar in npm and Tauri layouts. */
export function whisperSidecarCandidates(
  base: 'whisper-server' | 'whisper',
  dir: string,
  platform: NodeJS.Platform,
  arch: string,
): string[] {
  const short = platform === 'win32' ? `${base}.exe` : base
  const names = base === 'whisper-server'
    ? [voiceServerSidecarName(platform, arch), short]
    : [voiceSidecarNames(platform, arch)?.[1] ?? null, short]
  return names
    .filter((name): name is string => name !== null)
    .map((name) => path.join(dir, name))
}

export interface ResolveServerOptions {
  managedDir: string | null
  platform: NodeJS.Platform
  arch: string
  accelerator: string
  env?: NodeJS.ProcessEnv
  exists?: (file: string) => boolean
}

/**
 * Prefers a GPU accelerator subdirectory (`<managed>/<accel>/`), then the
 * managed root. Returns null when no server binary is installed, so callers
 * fall back to the one-shot whisper CLI.
 */
export function resolveWhisperServer(options: ResolveServerOptions): string | null {
  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync
  const explicit = env.ORCHESTRA_VOICE_SERVER
  if (explicit !== undefined && explicit.trim() !== '' && exists(explicit)) return explicit
  if (options.managedDir === null) return null
  const accelDirs = options.accelerator === 'auto'
    ? ['cuda', 'cuda11', 'vulkan']
    : options.accelerator === 'cpu'
      ? []
      : [options.accelerator]
  for (const accel of accelDirs) {
    const dir = path.join(options.managedDir, accel)
    for (const candidate of whisperSidecarCandidates('whisper-server', dir, options.platform, options.arch)) {
      if (exists(candidate)) return candidate
    }
  }
  for (const candidate of whisperSidecarCandidates('whisper-server', options.managedDir, options.platform, options.arch)) {
    if (exists(candidate)) return candidate
  }
  return null
}

export function resolveWhisperCli(options: Omit<ResolveServerOptions, 'accelerator'>): string | null {
  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync
  const explicit = env.ORCHESTRA_VOICE_WHISPER
  if (explicit !== undefined && explicit.trim() !== '') return explicit
  if (options.managedDir === null) return null
  for (const candidate of whisperSidecarCandidates('whisper', options.managedDir, options.platform, options.arch)) {
    if (exists(candidate)) return candidate
  }
  return null
}
