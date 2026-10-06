import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  pickFreePort,
  resolveWhisperCli,
  resolveWhisperServer,
  whisperServerArgs,
  WhisperServer,
  type SpawnFn,
} from '../src/voice-server.js'

const fixture = fileURLToPath(new URL('./fixtures/fake-whisper-server.js', import.meta.url))

function countedSpawn(): { spawnImpl: SpawnFn; calls: () => number } {
  let calls = 0
  const spawnImpl: SpawnFn = (command, args, options) => {
    calls++
    return spawn(command, args, options)
  }
  return { spawnImpl, calls: () => calls }
}

test('whisper-server argv matches the pinned b4938 contract', () => {
  assert.deepEqual(whisperServerArgs(9000, 'C:\\models\\ggml-base.bin', 8), [
    '-m', 'C:\\models\\ggml-base.bin', '-t', '8', '--host', '127.0.0.1', '--port', '9000',
  ])
})

test('pickFreePort returns a loopback port that can be bound again', async () => {
  const port = await pickFreePort()
  assert.ok(port > 0 && port < 65536)
  const { createServer } = await import('node:net')
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('keeps one process warm across requests and sends per-request language', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'voice-server-'))
  const capture = path.join(folder, 'capture.jsonl')
  const { spawnImpl, calls } = countedSpawn()
  const server = new WhisperServer({
    serverPath: process.execPath,
    modelPath: 'ggml-base.bin',
    threads: 4,
    spawn: spawnImpl,
    args: (port) => [fixture, '--port', String(port)],
  })
  const previous = process.env.FAKE_WHISPER_CAPTURE
  process.env.FAKE_WHISPER_CAPTURE = capture
  try {
    const wav = Buffer.from('RIFF0000WAVE-audio-marker')
    assert.equal(await server.transcribe(wav, 'ru'), 'Привет из тестового сервера')
    assert.equal(await server.transcribe(wav, 'en'), 'Привет из тестового сервера')
    assert.equal(calls(), 1, 'the model must stay loaded in one process')
    const records = (await readFile(capture, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(records.length, 2)
    assert.match(records[0].contentType, /multipart\/form-data; boundary=/)
    assert.ok(records[0].body.includes('name="file"; filename="audio.wav"'))
    assert.ok(records[0].body.includes('name="response_format"'))
    assert.ok(records[0].body.includes('\r\n\r\ntext\r\n'))
    assert.ok(records[0].body.includes('name="language"'))
    assert.ok(records[0].body.includes('\r\n\r\nru\r\n'))
    assert.ok(records[1].body.includes('\r\n\r\nen\r\n'))
    assert.ok(records[0].body.includes('RIFF0000WAVE-audio-marker'))
  } finally {
    if (previous === undefined) delete process.env.FAKE_WHISPER_CAPTURE
    else process.env.FAKE_WHISPER_CAPTURE = previous
    await server.dispose()
    await rm(folder, { recursive: true, force: true })
  }
})

test('reports a server that exits during startup instead of hanging', async () => {
  const server = new WhisperServer({
    serverPath: process.execPath,
    modelPath: 'ggml-base.bin',
    threads: 4,
    readyTimeoutMs: 2000,
    args: () => ['-e', 'process.stderr.write("boom");process.exit(3)'],
  })
  await assert.rejects(server.transcribe(Buffer.from('x'), 'ru'), /whisper-server завершился: boom/)
})

test('aborting a request kills the busy server so the next call restarts it', async () => {
  const { spawnImpl, calls } = countedSpawn()
  const server = new WhisperServer({
    serverPath: process.execPath,
    modelPath: 'ggml-base.bin',
    threads: 4,
    spawn: spawnImpl,
    args: (port) => [fixture, '--port', String(port)],
  })
  try {
    const controller = new AbortController()
    const pending = server.transcribe(Buffer.from('slow audio'), 'slow', controller.signal)
    controller.abort()
    await assert.rejects(pending, /cancelled/)
    assert.equal(calls(), 1)
    assert.equal(await server.transcribe(Buffer.from('fast audio'), 'ru'), 'Привет из тестового сервера')
    assert.equal(calls(), 2, 'the aborted server must be replaced, not reused')
  } finally {
    await server.dispose()
  }
})

test('resolves GPU accelerator directories before the managed root and honors env overrides', () => {
  const managed = path.join('C:', 'voice')
  const existing = new Set([
    path.join(managed, 'cuda', 'whisper-server.exe'),
    path.join(managed, 'whisper-server-x86_64-pc-windows-msvc.exe'),
  ])
  const options = {
    managedDir: managed,
    platform: 'win32' as NodeJS.Platform,
    arch: 'x64',
    exists: (file: string) => existing.has(file),
  }
  assert.equal(
    resolveWhisperServer({ ...options, accelerator: 'auto' }),
    path.join(managed, 'cuda', 'whisper-server.exe'),
  )
  assert.equal(
    resolveWhisperServer({ ...options, accelerator: 'cpu' }),
    path.join(managed, 'whisper-server-x86_64-pc-windows-msvc.exe'),
  )
  assert.equal(
    resolveWhisperServer({ ...options, accelerator: 'vulkan' }),
    path.join(managed, 'whisper-server-x86_64-pc-windows-msvc.exe'),
    'an uninstalled accelerator falls back to the CPU root binary',
  )
  assert.equal(
    resolveWhisperServer({ ...options, accelerator: 'cpu', env: { ORCHESTRA_VOICE_SERVER: 'D:\\custom\\server.exe' }, exists: () => true }),
    'D:\\custom\\server.exe',
  )
  assert.equal(resolveWhisperServer({ ...options, accelerator: 'cpu', managedDir: null }), null)
})

test('resolves the CLI fallback in npm layout and via the environment', () => {
  const managed = path.join('C:', 'voice')
  const cli = path.join(managed, 'whisper-x86_64-pc-windows-msvc.exe')
  assert.equal(
    resolveWhisperCli({ managedDir: managed, platform: 'win32', arch: 'x64', exists: (file: string) => file === cli }),
    cli,
  )
  assert.equal(
    resolveWhisperCli({ managedDir: managed, platform: 'win32', arch: 'x64', env: { ORCHESTRA_VOICE_WHISPER: 'D:\\w.exe' } }),
    'D:\\w.exe',
  )
  assert.equal(resolveWhisperCli({ managedDir: null, platform: 'linux', arch: 'x64' }), null)
})
