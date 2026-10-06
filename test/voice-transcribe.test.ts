import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { disposeVoiceServers, transcribeVoice, voiceServerAvailable } from '../src/voice-transcribe.js'
import { VOICE_SAMPLE_RATE, wrapPcmAsWav } from '../src/voice-audio.js'

const serverFixture = fileURLToPath(new URL('./fixtures/fake-whisper-server.js', import.meta.url))
const cliFixture = fileURLToPath(new URL('./fixtures/fake-whisper-cli.js', import.meta.url))

function tone(ms: number): Buffer {
  const samples = Math.round((VOICE_SAMPLE_RATE * ms) / 1000)
  const pcm = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / VOICE_SAMPLE_RATE) * 0.3 * 32767), i * 2)
  }
  return pcm
}

function silence(ms: number): Buffer {
  return Buffer.alloc(Math.round((VOICE_SAMPLE_RATE * ms) / 1000) * 2)
}

test('transcribeVoice prefers the warm server, trims silence and forwards language', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voice-transcribe-'))
  const capture = path.join(root, 'capture.jsonl')
  const models = path.join(root, 'models')
  await mkdir(models, { recursive: true })
  await writeFile(path.join(models, 'ggml-base.bin'), 'model fixture')
  const previous = process.env.FAKE_WHISPER_CAPTURE
  process.env.FAKE_WHISPER_CAPTURE = capture
  try {
    const wav = wrapPcmAsWav(Buffer.concat([silence(800), tone(600), silence(800)]))
    const text = await transcribeVoice(wav, 'base', 'ru', {
      serverPath: process.execPath,
      modelDir: models,
      managedDir: null,
      threads: 4,
      args: (port) => [serverFixture, '--port', String(port)],
    })
    assert.equal(text, 'Привет из тестового сервера')
    const record = JSON.parse((await readFile(capture, 'utf8')).trim())
    assert.ok(record.body.includes('\r\n\r\nru\r\n'))
    // The server must receive the trimmed WAV, not the original 2.2 s.
    const receivedBytes = Buffer.from(record.body, 'latin1')
    const waveIndex = receivedBytes.indexOf(Buffer.from('WAVEfmt '))
    const dataIndex = receivedBytes.indexOf(Buffer.from('data'), waveIndex)
    const declared = receivedBytes.readUInt32LE(dataIndex + 4)
    assert.ok(declared < wav.length - 44, `server got ${declared} bytes`)
  } finally {
    if (previous === undefined) delete process.env.FAKE_WHISPER_CAPTURE
    else process.env.FAKE_WHISPER_CAPTURE = previous
    await disposeVoiceServers()
    await rm(root, { recursive: true, force: true })
  }
})

test('transcribeVoice falls back to the one-shot CLI with the explicit thread count', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voice-transcribe-cli-'))
  const models = path.join(root, 'models')
  await mkdir(models, { recursive: true })
  await writeFile(path.join(models, 'ggml-base.bin'), 'model fixture')
  try {
    const received: string[][] = []
    const spawnImpl = ((command: string, args: string[], options: { windowsHide: boolean }) => {
      received.push([command, ...args])
      return spawn(process.execPath, [cliFixture, ...args], options)
    }) as import('../src/voice-server.js').SpawnFn
    const text = await transcribeVoice(wrapPcmAsWav(tone(500)), 'base', 'en', {
      serverPath: null,
      managedDir: null,
      modelDir: models,
      threads: 6,
      env: { ORCHESTRA_VOICE_WHISPER: 'whisper-cli' },
      spawn: spawnImpl,
    })
    assert.equal(text, 'threads=6 language=en')
    assert.equal(received[0]?.[0], 'whisper-cli')
    assert.equal(received[0]?.[received[0].indexOf('-t') + 1], '6')
    assert.equal(received[0]?.[received[0].indexOf('-l') + 1], 'en')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('voiceServerAvailable reflects the explicit override and managed layout', async () => {
  assert.equal(await voiceServerAvailable({ serverPath: process.execPath }), true)
  assert.equal(await voiceServerAvailable({ serverPath: null }), false)
  const managed = await mkdtemp(path.join(os.tmpdir(), 'voice-transcribe-managed-'))
  try {
    assert.equal(
      await voiceServerAvailable({ managedDir: managed, platform: 'linux', arch: 'x64', accelerator: 'cpu' }),
      false,
    )
    await writeFile(path.join(managed, 'whisper-server-x86_64-unknown-linux-gnu'), 'server')
    assert.equal(
      await voiceServerAvailable({ managedDir: managed, platform: 'linux', arch: 'x64', accelerator: 'cpu' }),
      true,
    )
  } finally {
    await rm(managed, { recursive: true, force: true })
  }
})
