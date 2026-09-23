import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { voiceManagedDir, voiceModelDir, voiceSidecarNames } from './voice.js'

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

export class VoiceRecorder {
  private recording: { child: ChildProcessWithoutNullStreams; folder: string; wav: string; closed: Promise<number | null>; stderr: string } | undefined

  async start(): Promise<void> {
    if (this.recording) throw new Error('Запись уже идёт.')
    const ffmpeg = await recordingFfmpeg()
    const whisper = executable('whisper')
    const model = process.env.ORCHESTRA_VOICE_MODEL === 'small' ? 'small' : 'base'
    const modelDir = voiceModelDir(process.platform, process.env)
    if (!modelDir || !existsSync(path.join(modelDir, `ggml-${model}.bin`)))
      throw new Error(`Модель ${model} не найдена. Запустите opencode-orchestra install.`)
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
    this.recording = { child, folder, wav, closed, get stderr() { return stderr } }
    const early = await Promise.race([
      closed.then(code => ({ code }), error => ({ error })),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 300)),
    ])
    if (early !== null && ('error' in early || early.code !== 0)) {
      await this.cancel()
      throw new Error(`Не удалось начать запись: ${stderr.trim() || ('error' in early ? String(early.error) : `ffmpeg завершился с кодом ${early.code}`)}`)
    }
  }

  async stop(): Promise<string> {
    const active = this.recording
    if (!active) throw new Error('Запись не запущена.')
    this.recording = undefined
    try {
      if (active.child.exitCode === null && !active.child.killed) {
        active.child.stdin.on('error', () => undefined)
        active.child.stdin.write('q\n')
        active.child.stdin.end()
      }
      const code = await active.closed
      if (code !== 0) throw new Error(`Ошибка записи: ${active.stderr.trim() || `ffmpeg: ${code}`}`)
      if ((await stat(active.wav)).size < MIN_WAV_BYTES) throw new Error('Запись слишком короткая.')
      const model = process.env.ORCHESTRA_VOICE_MODEL === 'small' ? 'small' : 'base'
      const modelDir = voiceModelDir(process.platform, process.env)!
      const result = await capture(executable('whisper'), [
        '-m', path.join(modelDir, `ggml-${model}.bin`), '-l', 'ru', '-f', active.wav,
        '-otxt', '-of', path.join(active.folder, 'result'),
      ], 600_000)
      if (result.code !== 0) throw new Error(`Ошибка распознавания: ${result.output.trim() || `whisper: ${result.code}`}`)
      const text = (await readFile(path.join(active.folder, 'result.txt'), 'utf8')).trim()
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
    active.child.kill()
    await active.closed.catch(() => undefined)
    await removeRecordingFolder(active.folder)
  }

  get isRecording(): boolean { return this.recording !== undefined }
}
