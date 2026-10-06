import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  acceleratorAsset,
  extractAcceleratorZip,
  installAccelerator,
  listAcceleratorBuild,
  readAccelerator,
  writeAccelerator,
} from '../src/voice-accelerator.js'

interface ZipFixtureEntry {
  name: string
  data: Buffer
  store?: boolean
}

function buildZip(entries: ZipFixtureEntry[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = entry.store === true ? entry.data : deflateRawSync(entry.data)
    const method = entry.store === true ? 0 : 8
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(0, 14) // CRC is not verified by the extractor.
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)
    localParts.push(local, data)
    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    centralParts.push(central)
    offset += local.length + data.length
  }
  const central = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, central, eocd])
}

test('maps CUDA assets to the pinned whisper.cpp release and leaves Vulkan to local builds', () => {
  assert.match(acceleratorAsset('win32', 'x64', 'cuda')!.url, /b4938\/whisper-cublas-12\.4\.0-bin-x64\.zip$/)
  assert.match(acceleratorAsset('win32', 'x64', 'cuda11')!.url, /b4938\/whisper-cublas-11\.8\.0-bin-x64\.zip$/)
  assert.equal(acceleratorAsset('win32', 'x64', 'cuda')!.sizeBytes, 671_045_732)
  assert.equal(acceleratorAsset('linux', 'x64', 'cuda'), null)
  assert.equal(acceleratorAsset('win32', 'x64', 'vulkan'), null)
  assert.equal(acceleratorAsset('win32', 'arm64', 'cuda'), null)
})

test('persists the accelerator preference, honors the env override and survives corrupt files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voice-accel-'))
  try {
    const env = { APPDATA: root }
    assert.equal(await readAccelerator('win32', env), 'auto')
    await writeAccelerator('cuda', 'win32', env)
    assert.equal(await readAccelerator('win32', env), 'cuda')
    assert.equal(await readAccelerator('win32', { ...env, ORCHESTRA_VOICE_ACCEL: 'vulkan' }), 'vulkan')
    assert.equal(await readAccelerator('win32', { ...env, ORCHESTRA_VOICE_ACCEL: 'nonsense' }), 'cuda')
    await writeFile(path.join(root, 'ai.opencode.voice-overlay', 'accelerator.json'), '{broken')
    assert.equal(await readAccelerator('win32', env), 'auto')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('extracts selected zip entries by basename with deflate and stored methods', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voice-zip-'))
  try {
    const zip = buildZip([
      { name: 'Release/whisper-server.exe', data: Buffer.from('server-binary') },
      { name: 'Release/ggml-cuda.dll', data: Buffer.from('gpu-library'), store: true },
      { name: 'docs/readme.txt', data: Buffer.from('ignore me') },
    ])
    const zipPath = path.join(root, 'build.zip')
    await writeFile(zipPath, zip)
    const dest = path.join(root, 'out')
    const files = await extractAcceleratorZip(zipPath, dest, (name) => /\.(exe|dll)$/i.test(name))
    assert.deepEqual(files.sort(), ['ggml-cuda.dll', 'whisper-server.exe'])
    assert.equal(await readFile(path.join(dest, 'whisper-server.exe'), 'utf8'), 'server-binary')
    assert.equal(await readFile(path.join(dest, 'ggml-cuda.dll'), 'utf8'), 'gpu-library')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('installs a local CUDA zip into the accelerator directory and records the preference', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voice-accel-install-'))
  try {
    const managed = path.join(root, 'Programs', 'voice-overlay')
    const data = path.join(root, 'AppData', 'ai.opencode.voice-overlay')
    const zipPath = path.join(root, 'cuda.zip')
    await writeFile(zipPath, buildZip([
      { name: 'Release/whisper-server.exe', data: Buffer.from('server') },
      { name: 'Release/whisper.dll', data: Buffer.from('lib') },
      { name: 'Release/bench.exe', data: Buffer.from('not needed') },
    ]))
    const result = await installAccelerator('cuda', {
      platform: 'win32', arch: 'x64', managedDir: managed, dataDir: data, zipPath,
    })
    assert.equal(result.dir, path.join(managed, 'cuda'))
    assert.deepEqual(result.files.sort(), ['whisper-server.exe', 'whisper.dll'])
    assert.equal(await readFile(path.join(managed, 'cuda', 'whisper-server.exe'), 'utf8'), 'server')
    assert.equal(await readAccelerator('win32', { APPDATA: root }, data), 'cuda')
    assert.deepEqual((await listAcceleratorBuild(path.join(managed, 'cuda'))).sort(), ['whisper-server.exe', 'whisper.dll'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('downloads through fetch, rejects missing whisper-server and accepts a local Vulkan build', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voice-accel-fetch-'))
  try {
    const managed = path.join(root, 'managed')
    const data = path.join(root, 'data')
    const zip = buildZip([{ name: 'Release/whisper-server.exe', data: Buffer.from('server') }])
    const result = await installAccelerator('cuda', {
      platform: 'win32', arch: 'x64', managedDir: managed, dataDir: data,
      fetch: async () => new Response(Uint8Array.from(zip)),
    })
    assert.equal(result.bytes, 671_045_732)
    assert.equal(await readAccelerator('win32', {}, data), 'cuda')

    const broken = buildZip([{ name: 'Release/bench.exe', data: Buffer.from('x') }])
    await assert.rejects(
      installAccelerator('cuda11', {
        platform: 'win32', arch: 'x64', managedDir: managed, dataDir: data,
        fetch: async () => new Response(Uint8Array.from(broken)),
      }),
      /нет whisper-server/,
    )

    await assert.rejects(
      installAccelerator('vulkan', { platform: 'win32', arch: 'x64', managedDir: managed, dataDir: data }),
      /accelerator-unavailable:.*Vulkan/s,
    )
    const vulkanDir = path.join(managed, 'vulkan')
    await mkdir(vulkanDir, { recursive: true })
    await writeFile(path.join(vulkanDir, 'whisper-server.exe'), 'local build')
    const local = await installAccelerator('vulkan', { platform: 'win32', arch: 'x64', managedDir: managed, dataDir: data })
    assert.deepEqual(local.files, ['whisper-server.exe'])
    assert.equal(await readAccelerator('win32', {}, data), 'vulkan')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
