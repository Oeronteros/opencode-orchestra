import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, open, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { voiceManagedDir, voiceModelDir, voiceSidecarNames } from './voice.js'
import { createVoicePolicy, type VoiceModel, type VoiceLanguage } from './voice-context.js'
import { VoiceSegmentTracker, mergeVoiceSegments, wrapPcmAsWav } from './voice-audio.js'
import { transcribeVoice, voiceServerAvailable } from './voice-transcribe.js'

export function voiceRecorderPreferences(env: NodeJS.ProcessEnv) {
  const policy = createVoicePolicy()
  return {
    model: policy.model(env.ORCHESTRA_VOICE_MODEL ?? 'base'),
    language: policy.language(env.ORCHESTRA_VOICE_LANGUAGE ?? 'ru')
  }
}

const MIN_WAV_BYTES = 16000
const MAX_SECONDS = 120

async function removeRecordingFolder(folder: string): Promise<void> {
  const resolved = path.resolve(folder)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('orchestra-voice-'))
    throw new Error('Отказано в удалении постороннего каталога записи.')
  await rm(resolved, { recursive: true, force: true })
}

function executable(name: 'ffmpeg' | 'whisper'): string {
  const dir = voiceManagedDir(process.platform, process.env)
  const sidecars = voiceSidecarNames(process.platform, process.arch)
  const file = sidecars?.[name === 'ffmpeg' ? 0 : 1]
  if (!dir || !file || !existsSync(path.join(dir, file)))
    throw new Error(`${name} не установлен. Запустите opencode-orchestra install.`)
  return path.join(dir, file)
}

function spawnHidden(file: string, args: string[]): ChildProcessWithoutNullStreams {
  return spawn(file, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
}

function capture(file: string, args: string[], timeout = 10000): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnHidden(file, args)
    child.stdin.end()
    let output = ''
    const timer = setTimeout(() => child.kill(), timeout)
    const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-32000) }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => { clearTimeout(timer); resolve({ code, output }) })
  })
}

function firstWindowsMicrophone(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/"([^"]+)"\s*\(audio\)/)
    if (match?.[1]) return match[1]
  }
  return undefined
}

function supportsInput(output: string, name: string): boolean {
  return output.split(/\r?\n/).some(line => {
    const [flags, device] = line.trim().split(/\s+/)
    return flags?.includes('D') && device === name
  })
}

async function recordingFfmpeg(): Promise<string> {
  const bundled = executable('ffmpeg')
  if (process.platform !== 'linux' || process.env.VOICE_FFMPEG_TEST_INPUT) return bundled
  for (const candidate of [bundled, 'ffmpeg']) {
    try {
      const probe = await capture(candidate, ['-hide_banner', '-devices'], 5000)
      if (probe.code === 0 && supportsInput(probe.output, 'pulse')) return candidate
    } catch { /* Try the next candidate. */ }
  }
  throw new Error('ffmpeg с поддержкой PulseAudio не найден. Установите системный ffmpeg.')
}

function waitForClose(child: ChildProcessWithoutNullStreams, timeout: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill(), timeout)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => { clearTimeout(timer); resolve(code) })
  })
}

interface ActiveRecording {
  child: ChildProcessWithoutNullStreams
  folder: string
  wav: string
  model: VoiceModel
  language: VoiceLanguage
  closed: Promise<number | null>
  stderr: string
  tracker: VoiceSegmentTracker
  abort: AbortController
  timer: NodeJS.Timeout | undefined
  pumpTask: Promise<void> | undefined
  chunks: string[]
  failed: Error | undefined
  progressive: boolean
}

export class VoiceRecorder {
  private recording: ActiveRecording | undefined

  async start(): Promise<void> {
    if (this.recording) throw new Error('Запись уже идёт.')
    const { model, language } = voiceRecorderPreferences(process.env)
    const ffmpeg = await recordingFfmpeg()
    const whisper = executable('whisper')
    const modelDir = voiceModelDir(process.platform, process.env)
    if (!modelDir || !existsSync(path.join(modelDir, `ggml-${model}.bin`)))
      throw new Error(`Модель ${model} не найдена. Запустите opencode-orchestra voice-model ${model}.`)
    if (!existsSync(whisper)) throw new Error('Whisper не установлен.')
    let input: string[]
    if (process.env.VOICE_FFMPEG_TEST_INPUT) input = ['-f', 'lavfi', '-i', process.env.VOICE_FFMPEG_TEST_INPUT]
    else if (process.platform === 'linux') input = ['-f', 'pulse', '-i', process.env.ORCHESTRA_VOICE_DEVICE || 'default']
    else if (process.platform === 'win32') {
      let device = process.env.ORCHESTRA_VOICE_DEVICE
      if (!device) {
        const listed = await capture(ffmpeg, ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'])
        device = firstWindowsMicrophone(listed.output)
      }
      if (!device) throw new Error('Микрофон не найден. Укажите ORCHESTRA_VOICE_DEVICE.')
      input = ['-f', 'dshow', '-i', `audio=${device}`]
    } else throw new Error('Голосовой ввод поддерживает Windows и Linux.')
    const folder = await mkdtemp(path.join(os.tmpdir(), 'orchestra-voice-'))
    const wav = path.join(folder, 'audio.wav')
    const child = spawnHidden(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...input, '-t', String(MAX_SECONDS), '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', wav])
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8000) })
    child.stdout.resume()
    const closed = waitForClose(child, (MAX_SECONDS + 5) * 1000)
    // The process can fail before Stop is pressed; keep the rejection observed.
    void closed.catch(() => undefined)
    const progressive = await voiceServerAvailable().catch(() => false)
    const active: ActiveRecording = {
      child, folder, wav, model, language, closed,
      get stderr() { return stderr },
      tracker: new VoiceSegmentTracker(),
      abort: new AbortController(),
      timer: undefined,
      pumpTask: undefined,
      chunks: [],
      failed: undefined,
      progressive,
    }
    this.recording = active
    if (progressive) {
      active.timer = setInterval(() => this.schedulePump(active), 1500)
      active.timer.unref?.()
    }
    const early = await Promise.race([
      closed.then(code => ({ code }), error => ({ error })),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 300)),
    ])
    if (early !== null && ('error' in early || early.code !== 0)) {
      await this.cancel()
      throw new Error(`Не удалось начать запись: ${stderr.trim() || ('error' in early ? String(early.error) : `ffmpeg завершился с кодом ${early.code}`)}`)
    }
  }

  /** Transcribes completed 30 s segments while the user is still speaking. */
  private schedulePump(active: ActiveRecording): void {
    if (active.pumpTask !== undefined || active.failed !== undefined) return
    active.pumpTask = this.pump(active).finally(() => { active.pumpTask = undefined })
  }

  private async pump(active: ActiveRecording): Promise<void> {
    try {
      const info = await stat(active.wav)
      const available = Math.max(0, info.size - 44)
      const completed = active.tracker.take(available)
      if (completed.length === 0) return
      const handle = await open(active.wav, 'r')
      try {
        for (const range of completed) {
          const buffer = Buffer.alloc(range.to - range.from)
          await handle.read(buffer, 0, buffer.length, 44 + range.from)
          const text = await transcribeVoice(wrapPcmAsWav(buffer), active.model, active.language, {
            signal: active.abort.signal,
          })
          if (text !== '') active.chunks.push(text)
        }
      } finally {
        await handle.close()
      }
    } catch (error) {
      active.failed = error instanceof Error ? error : new Error(String(error))
    }
  }

  async stop(): Promise<string> {
    const active = this.recording
    if (!active) throw new Error('Запись не запущена.')
    this.recording = undefined
    try {
      if (active.timer !== undefined) clearInterval(active.timer)
      if (active.child.exitCode === null && !active.child.killed) {
        active.child.stdin.on('error', () => undefined)
        active.child.stdin.write('q\n')
        active.child.stdin.end()
      }
      const code = await active.closed
      if (code !== 0) throw new Error(`Ошибка записи: ${active.stderr.trim() || `ffmpeg: ${code}`}`)
      if ((await stat(active.wav)).size < MIN_WAV_BYTES) throw new Error('Запись слишком короткая.')
      await active.pumpTask
      if (active.failed !== undefined) throw active.failed
      const info = await stat(active.wav)
      const available = Math.max(0, info.size - 44)
      const from = active.tracker.pendingFrom
      let tail = ''
      if (available - from >= 2) {
        const handle = await open(active.wav, 'r')
        try {
          const buffer = Buffer.alloc((available - from) & ~1)
          await handle.read(buffer, 0, buffer.length, 44 + from)
          tail = await transcribeVoice(wrapPcmAsWav(buffer), active.model, active.language, {
            signal: active.abort.signal,
          })
        } finally {
          await handle.close()
        }
      }
      const text = mergeVoiceSegments(active.chunks, tail)
      if (!text) throw new Error('Речь не распознана.')
      return text
    } finally {
      await removeRecordingFolder(active.folder)
    }
  }

  async cancel(): Promise<void> {
    const active = this.recording
    if (!active) return
    this.recording = undefined
    if (active.timer !== undefined) clearInterval(active.timer)
    active.abort.abort()
    active.child.kill()
    await active.closed.catch(() => undefined)
    await active.pumpTask?.catch(() => undefined)
    await removeRecordingFolder(active.folder)
  }

  get isRecording(): boolean { return this.recording !== undefined }
}
