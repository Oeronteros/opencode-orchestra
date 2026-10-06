import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createVoicePolicy, type VoiceLanguage, type VoiceModel } from './voice-context.js'
import { trimVoiceSilence } from './voice-audio.js'
import { readAccelerator, type VoiceAccelerator } from './voice-accelerator.js'
import { resolveWhisperCli, resolveWhisperServer, WhisperServer, type SpawnFn, type WhisperServerOptions } from './voice-server.js'
import { voiceThreadCount } from './voice-threads.js'
import { voiceManagedDir, voiceModelDir } from './voice.js'

export interface VoiceTranscribeOptions {
  signal?: AbortSignal | undefined
  env?: NodeJS.ProcessEnv | undefined
  platform?: NodeJS.Platform | undefined
  arch?: string | undefined
  managedDir?: string | null | undefined
  modelDir?: string | null | undefined
  /** Explicit server binary override (tests and ORCHESTRA_VOICE_SERVER). */
  serverPath?: string | null | undefined
  accelerator?: VoiceAccelerator | undefined
  threads?: number | undefined
  spawn?: SpawnFn | undefined
  fetch?: typeof fetch | undefined
  readyTimeoutMs?: number | undefined
  /** Test seam: override whisper-server argv construction. */
  args?: WhisperServerOptions['args']
}

function capture(
  file: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
  spawnImpl: SpawnFn = nodeSpawn as unknown as SpawnFn,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('cancelled: распознавание отменено'))
      return
    }
    const child: ChildProcess = spawnImpl(file, args, { windowsHide: true })
    let output = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    const onAbort = () => child.kill()
    signal?.addEventListener('abort', onAbort, { once: true })
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-32000)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.once('error', (error) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) reject(new Error('cancelled: распознавание отменено'))
      else resolve({ code, output })
    })
  })
}

async function transcribeWithCli(
  wav: Buffer,
  cli: string,
  modelPath: string,
  language: VoiceLanguage,
  threads: number,
  signal?: AbortSignal,
  spawnImpl?: SpawnFn,
): Promise<string> {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'orchestra-voice-stt-'))
  try {
    const file = path.join(folder, 'audio.wav')
    await writeFile(file, wav)
    const result = await capture(
      cli,
      ['-m', modelPath, '-l', language, '-f', file, '-otxt', '-of', path.join(folder, 'result'), '-t', String(threads)],
      600_000,
      signal,
      spawnImpl,
    )
    if (result.code !== 0) {
      const detail = result.output.trim().slice(-500)
      throw new Error(`transcribe-failed: whisper завершился с кодом ${result.code ?? -1}${detail ? `: ${detail}` : ''}`)
    }
    return (await readFile(path.join(folder, 'result.txt'), 'utf8')).trim()
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

let current: { key: string; server: WhisperServer } | undefined

/** Stops the cached warm server; used when a proxy or test session closes. */
export async function disposeVoiceServers(): Promise<void> {
  const active = current
  current = undefined
  if (active !== undefined) await active.server.dispose()
}

/**
 * Transcribes a canonical 16 kHz mono WAV: trims silence, then prefers the
 * long-lived whisper-server (model stays loaded) and falls back to the
 * one-shot whisper CLI with an explicit physical-core thread count.
 */
export async function transcribeVoice(
  wav: Buffer,
  model: VoiceModel,
  language: VoiceLanguage,
  options: VoiceTranscribeOptions = {},
): Promise<string> {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const managed = options.managedDir !== undefined ? options.managedDir : voiceManagedDir(platform, env)
  const models = options.modelDir !== undefined ? options.modelDir : voiceModelDir(platform, env)
  if (models === null) throw new Error('transcribe-failed: голосовой ввод поддерживает Windows и Linux')
  const modelPath = path.join(models, createVoicePolicy().modelFile(model))
  const prepared = trimVoiceSilence(wav).wav
  const accelerator = options.accelerator ?? (await readAccelerator(platform, env))
  const serverPath = options.serverPath !== undefined
    ? options.serverPath
    : resolveWhisperServer({ managedDir: managed, platform, arch, accelerator, env })

  if (serverPath !== null) {
    const key = `${serverPath}|${modelPath}`
    if (current?.key !== key) {
      if (current !== undefined) await current.server.dispose()
      current = {
        key,
        server: new WhisperServer({
          serverPath,
          modelPath,
          threads: options.threads ?? (await voiceThreadCount(env)),
          spawn: options.spawn,
          fetch: options.fetch,
          readyTimeoutMs: options.readyTimeoutMs,
          args: options.args,
        }),
      }
    }
    return current.server.transcribe(prepared, language, options.signal)
  }

  const cli = resolveWhisperCli({ managedDir: managed, platform, arch, env })
  if (cli === null) {
    throw new Error('transcribe-failed: Whisper не установлен. Запустите opencode-orchestra install.')
  }
  return transcribeWithCli(
    prepared,
    cli,
    modelPath,
    language,
    options.threads ?? (await voiceThreadCount(env)),
    options.signal,
    options.spawn,
  )
}

/** True when the warm server binary is installed, so progressive mode can run. */
export async function voiceServerAvailable(options: VoiceTranscribeOptions = {}): Promise<boolean> {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  if (options.serverPath !== undefined) return options.serverPath !== null
  const managed = options.managedDir !== undefined ? options.managedDir : voiceManagedDir(platform, env)
  const accelerator = options.accelerator ?? (await readAccelerator(platform, env))
  return resolveWhisperServer({ managedDir: managed, platform, arch, accelerator, env }) !== null
}
