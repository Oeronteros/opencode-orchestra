import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { VoiceRecorder } from '../src/voice-recorder.js'
import { parseVoiceWav, VOICE_BYTES_PER_SECOND, VOICE_SEGMENT_BYTES } from '../src/voice-audio.js'

const childFixture = fileURLToPath(new URL('./fixtures/fake-voice-recorder.js', import.meta.url))

for (const mode of ['complete', 'interrupt', 'failure'] as const) {
  test(`recording Stop preserves metadata audio and tail: ${mode}`, { timeout: 10000 }, async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'voice-recorder-test-'))
    const previousInput = process.env.VOICE_FFMPEG_TEST_INPUT
    const previousModel = process.env.ORCHESTRA_VOICE_MODEL
    const previousLanguage = process.env.ORCHESTRA_VOICE_LANGUAGE
    process.env.VOICE_FFMPEG_TEST_INPUT = 'fixture'
    process.env.ORCHESTRA_VOICE_MODEL = 'base'
    process.env.ORCHESTRA_VOICE_LANGUAGE = 'ru'
    let recorder: VoiceRecorder | undefined
    try {
      const real = await readFile('test/fixtures/voice-ffmpeg.wav')
      const pcm = Buffer.alloc(65 * VOICE_BYTES_PER_SECOND)
      for (let i = 0; i < pcm.length; i++) pcm[i] = i % 251
      const header = Buffer.from(real.subarray(0, 78))
      header.writeUInt32LE(pcm.length, 74)
      header.writeUInt32LE(header.length + pcm.length - 8, 4)
      const source = path.join(folder, 'source.wav')
      await writeFile(source, Buffer.concat([header, pcm]))
      await writeFile(path.join(folder, 'ggml-base.bin'), 'model fixture')
      const received: Buffer[] = []
      let secondStarted!: () => void
      const started = new Promise<void>(resolve => { secondStarted = resolve })
      recorder = new VoiceRecorder({
        ffmpeg: async () => process.execPath,
        whisper: () => process.execPath,
        modelDir: () => folder,
        spawn: (_file, args) => spawn(process.execPath, [childFixture, source, args.at(-1)!], {
          windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        }),
        serverAvailable: async () => true,
        transcribe: async (wav, _model, _language, options) => {
          const parsed = parseVoiceWav(wav)!
          assert.ok(parsed)
          received.push(Buffer.from(wav.subarray(parsed.dataStart, parsed.dataStart + parsed.dataBytes)))
          if (received.length === 2) {
            secondStarted()
            if (mode === 'failure') throw new Error('fixture server crashed')
            if (mode === 'interrupt') {
              return new Promise<string>((_resolve, reject) => {
                const abort = () => reject(new Error('cancelled: fixture inference'))
                if (options?.signal?.aborted) abort()
                else options?.signal?.addEventListener('abort', abort, { once: true })
              })
            }
          }
          return received.length === 1 ? 'first' : received.length === 2 ? 'second' : 'tail'
        },
      })
      await recorder.start()
      await Promise.race([started, delay(5000, undefined, { ref: false }).then(() => {
        throw new Error('progressive transcription did not start')
      })])
      assert.equal(await recorder.stop(), mode === 'complete' ? 'first second tail' : 'first tail')
      assert.equal(received.length, 3)
      assert.deepEqual(received[0], pcm.subarray(0, VOICE_SEGMENT_BYTES))
      assert.deepEqual(received[1], pcm.subarray(VOICE_SEGMENT_BYTES, VOICE_SEGMENT_BYTES * 2))
      assert.deepEqual(received[2], pcm.subarray(VOICE_SEGMENT_BYTES * (mode === 'complete' ? 2 : 1)))
      assert.deepEqual(Buffer.concat([received[0]!, ...(mode === 'complete' ? [received[1]!] : []), received[2]!]), pcm)
    } finally {
      await recorder?.cancel()
      if (previousInput === undefined) delete process.env.VOICE_FFMPEG_TEST_INPUT
      else process.env.VOICE_FFMPEG_TEST_INPUT = previousInput
      if (previousModel === undefined) delete process.env.ORCHESTRA_VOICE_MODEL
      else process.env.ORCHESTRA_VOICE_MODEL = previousModel
      if (previousLanguage === undefined) delete process.env.ORCHESTRA_VOICE_LANGUAGE
      else process.env.ORCHESTRA_VOICE_LANGUAGE = previousLanguage
      await rm(folder, { recursive: true, force: true })
    }
  })
}
