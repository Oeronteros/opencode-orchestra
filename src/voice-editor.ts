import { readFile, writeFile } from 'node:fs/promises'
import { VoiceRecorder } from './voice-recorder.js'

export function voiceEditorCommand(executable: string, cli: string): string {
  for (const value of [executable, cli]) {
    if (!value || /["\r\n]/.test(value)) throw new Error('Недопустимый путь к voice-editor.')
  }
  return `"${executable}" "${cli}" voice-editor`
}

export async function waitForStop(): Promise<void> {
  if (!process.stdin.isTTY) throw new Error('voice-editor требует интерактивный терминал.')
  const input = process.stdin
  const wasRaw = input.isRaw
  let prefix = false
  input.setRawMode(true)
  input.resume()
  try {
    process.stdout.write('Говорите. Нажмите Ctrl+X, E ещё раз или Enter для остановки (до 120 секунд).\n')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(), 120_000)
      const finish = (error?: Error) => {
        clearTimeout(timer)
        input.off('data', onData)
        if (error) reject(error)
        else resolve()
      }
      const onData = (chunk: Buffer) => {
        for (const byte of chunk) {
          if (byte === 3) { finish(new Error('Запись отменена.')); return }
          if (byte === 13 || byte === 10 || (prefix && (byte === 101 || byte === 69))) { finish(); return }
          prefix = byte === 24
        }
      }
      input.on('data', onData)
    })
  } finally {
    input.setRawMode(wasRaw)
    input.pause()
  }
}

/** OpenCode passes the current draft as a file to $EDITOR and reads it on exit. */
export async function runVoiceEditor(
  file: string,
  recorder: Pick<VoiceRecorder, 'start' | 'stop' | 'cancel'> = new VoiceRecorder(),
  stopSignal: () => Promise<void> = waitForStop,
): Promise<void> {
  if (!file) throw new Error('voice-editor: OpenCode не передал файл черновика.')
  const original = await readFile(file, 'utf8')
  await recorder.start()
  try {
    await stopSignal()
    const text = await recorder.stop()
    await writeFile(file, original + (original && !/\s$/.test(original) ? ' ' : '') + text, 'utf8')
  } catch (error) {
    await recorder.cancel()
    throw error
  }
}
