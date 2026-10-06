import { cp, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile, type FileHandle } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createInflateRaw } from 'node:zlib'
import { voiceDataDir, voiceManagedDir } from './voice.js'

export type VoiceAccelerator = 'auto' | 'cpu' | 'cuda' | 'cuda11' | 'vulkan'

export const VOICE_ACCELERATORS: readonly VoiceAccelerator[] = ['auto', 'cpu', 'cuda', 'cuda11', 'vulkan']

export function isVoiceAccelerator(value: unknown): value is VoiceAccelerator {
  return typeof value === 'string' && (VOICE_ACCELERATORS as readonly string[]).includes(value)
}

export interface AcceleratorAsset {
  kind: 'zip'
  url: string
  sizeBytes: number
  label: string
}

// Pinned to the same whisper.cpp release as the CPU sidecars.
const WHISPER_RELEASE = 'https://github.com/ggml-org/whisper.cpp/releases/download/b4938'

/**
 * Official GPU builds exist only for Windows CUDA; everything else is a local
 * Vulkan/CUDA build dropped into `<managed>/<accelerator>/`.
 */
export function acceleratorAsset(
  platform: string,
  arch: string,
  accelerator: VoiceAccelerator,
): AcceleratorAsset | null {
  if (platform !== 'win32' || arch !== 'x64') return null
  if (accelerator === 'cuda') {
    return {
      kind: 'zip',
      url: `${WHISPER_RELEASE}/whisper-cublas-12.4.0-bin-x64.zip`,
      sizeBytes: 671_045_732,
      label: 'CUDA 12.4',
    }
  }
  if (accelerator === 'cuda11') {
    return {
      kind: 'zip',
      url: `${WHISPER_RELEASE}/whisper-cublas-11.8.0-bin-x64.zip`,
      sizeBytes: 269_896_802,
      label: 'CUDA 11.8',
    }
  }
  return null
}

export function acceleratorPreferenceFile(platform: string, env: NodeJS.ProcessEnv, dataDir?: string): string | null {
  const dir = dataDir !== undefined ? dataDir : voiceDataDir(platform, env)
  return dir === null ? null : path.join(dir, 'accelerator.json')
}

export async function readAccelerator(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  dataDir?: string,
): Promise<VoiceAccelerator> {
  const override = env.ORCHESTRA_VOICE_ACCEL
  if (isVoiceAccelerator(override)) return override
  const file = acceleratorPreferenceFile(platform, env, dataDir)
  if (file === null) return 'auto'
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    const value = (parsed as { accelerator?: unknown } | null)?.accelerator
    if (isVoiceAccelerator(value)) return value
  } catch { /* missing or corrupt preference keeps auto */ }
  return 'auto'
}

export async function writeAccelerator(
  accelerator: VoiceAccelerator,
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  dataDir?: string,
): Promise<void> {
  const file = acceleratorPreferenceFile(platform, env, dataDir)
  if (file === null) throw new Error('accelerator-install: платформа не поддерживается')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify({ accelerator }, null, 2)}\n`, 'utf8')
}

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  localOffset: number
}

async function readZipEntries(handle: FileHandle, size: number): Promise<ZipEntry[]> {
  if (size < 22) throw new Error('accelerator-install: файл не является zip-архивом')
  const tailLength = Math.min(size, 66_000)
  const tail = Buffer.alloc(tailLength)
  await handle.read(tail, 0, tailLength, size - tailLength)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd === -1) throw new Error('accelerator-install: повреждённый zip-архив')
  const count = tail.readUInt16LE(eocd + 10)
  const centralOffset = tail.readUInt32LE(eocd + 16)
  if (count === 0xffff || centralOffset === 0xffffffff) {
    throw new Error('accelerator-install: zip64 не поддерживается')
  }
  const centralLength = Math.min(size - centralOffset, 64 * 1024 * 1024)
  const central = Buffer.alloc(centralLength)
  await handle.read(central, 0, centralLength, centralOffset)
  const entries: ZipEntry[] = []
  let offset = 0
  for (let i = 0; i < count; i++) {
    if (offset + 46 > central.length || central.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('accelerator-install: повреждённый zip-каталог')
    }
    const method = central.readUInt16LE(offset + 10)
    const compressedSize = central.readUInt32LE(offset + 20)
    const nameLen = central.readUInt16LE(offset + 28)
    const extraLen = central.readUInt16LE(offset + 30)
    const commentLen = central.readUInt16LE(offset + 32)
    const localOffset = central.readUInt32LE(offset + 42)
    const name = central.toString('utf8', offset + 46, offset + 46 + nameLen)
    entries.push({ name, method, compressedSize, localOffset })
    offset += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

async function* readRange(handle: FileHandle, start: number, length: number): AsyncGenerator<Buffer> {
  const chunkSize = 1024 * 1024
  let position = start
  let remaining = length
  while (remaining > 0) {
    const size = Math.min(chunkSize, remaining)
    const buffer = Buffer.allocUnsafe(size)
    const { bytesRead } = await handle.read(buffer, 0, size, position)
    if (bytesRead <= 0) throw new Error('accelerator-install: неожиданный конец zip-архива')
    position += bytesRead
    remaining -= bytesRead
    yield buffer.subarray(0, bytesRead)
  }
}

async function extractEntry(handle: FileHandle, entry: ZipEntry, target: string): Promise<void> {
  const header = Buffer.alloc(30)
  await handle.read(header, 0, 30, entry.localOffset)
  if (header.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('accelerator-install: повреждённая запись zip-архива')
  }
  const nameLen = header.readUInt16LE(26)
  const extraLen = header.readUInt16LE(28)
  const dataStart = entry.localOffset + 30 + nameLen + extraLen
  const source = Readable.from(readRange(handle, dataStart, entry.compressedSize))
  if (entry.method === 0) {
    await pipeline(source, createWriteStream(target))
    return
  }
  if (entry.method === 8) {
    await pipeline(source, createInflateRaw(), createWriteStream(target))
    return
  }
  throw new Error(`accelerator-install: метод сжатия ${entry.method} не поддерживается`)
}

/** Extracts selected entries (flattened to basenames) from a zip archive. */
export async function extractAcceleratorZip(
  zipPath: string,
  destDir: string,
  match: (name: string) => boolean,
): Promise<string[]> {
  const info = await stat(zipPath)
  const handle = await open(zipPath, 'r')
  const written: string[] = []
  try {
    const entries = await readZipEntries(handle, info.size)
    await mkdir(destDir, { recursive: true })
    for (const entry of entries) {
      if (entry.name.endsWith('/')) continue
      if (!match(entry.name)) continue
      const base = path.basename(entry.name)
      if (base === '' || base === '.' || base === '..' || base.includes('\\')) {
        throw new Error(`accelerator-install: недопустимое имя в архиве: ${entry.name}`)
      }
      await extractEntry(handle, entry, path.join(destDir, base))
      written.push(base)
    }
  } finally {
    await handle.close()
  }
  return written
}

export interface InstallAcceleratorOptions {
  platform?: string
  arch?: string
  env?: NodeJS.ProcessEnv
  managedDir?: string | null
  dataDir?: string | null
  fetch?: typeof fetch
  /** Test seam: skip the real download and use this zip file. */
  zipPath?: string
}

export interface InstallAcceleratorResult {
  accelerator: VoiceAccelerator
  dir: string | null
  files: string[]
  bytes: number
}

function acceleratorMatch(name: string): boolean {
  const base = path.basename(name)
  return /^whisper-server(\.exe)?$/i.test(base) || /\.dll$/i.test(base) || /^lib.*\.so/i.test(base)
}

/**
 * Installs a GPU build into `<managed>/<accelerator>/` and records the
 * preference. CPU clears the preference; Vulkan and Linux CUDA require a local
 * build already placed there (no official binaries exist).
 */
export async function installAccelerator(
  accelerator: VoiceAccelerator,
  options: InstallAcceleratorOptions = {},
): Promise<InstallAcceleratorResult> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const env = options.env ?? process.env
  const managed = options.managedDir !== undefined ? options.managedDir : voiceManagedDir(platform, env)
  const data = options.dataDir !== undefined ? options.dataDir : voiceDataDir(platform, env)
  if (managed === null || data === null) {
    throw new Error('accelerator-install: голосовой ввод поддерживает Windows и Linux')
  }
  if (accelerator === 'cpu' || accelerator === 'auto') {
    await writeAccelerator(accelerator, platform, env, data)
    return { accelerator, dir: null, files: [], bytes: 0 }
  }
  const asset = acceleratorAsset(platform, arch, accelerator)
  if (asset === null) {
    const dest = path.join(managed, accelerator)
    const existing = await listAcceleratorBuild(dest)
    if (existing.length === 0) {
      throw new Error(
        `accelerator-unavailable: готовой сборки ${accelerator} для ${platform}/${arch} нет. ` +
          `Собери её (scripts/build-whisper-vulkan.ps1|.sh для Vulkan) и положи файлы в ${dest}.`,
      )
    }
    await writeAccelerator(accelerator, platform, env, data)
    return { accelerator, dir: dest, files: existing, bytes: 0 }
  }

  await mkdir(data, { recursive: true })
  const stagingRoot = await mkdtemp(path.join(data, '.accelerator-'))
  let zipPath = options.zipPath ?? ''
  try {
    if (zipPath === '') {
      zipPath = path.join(stagingRoot, 'build.zip')
      const response = await (options.fetch ?? fetch)(asset.url, { redirect: 'follow', signal: AbortSignal.timeout(1_800_000) })
      if (!response.ok || response.body === null) {
        throw new Error(`accelerator-install: загрузка не удалась: HTTP ${response.status}`)
      }
      const file = await open(zipPath, 'wx')
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          await file.write(chunk)
        }
      } finally {
        await file.close()
      }
    }
    const staging = path.join(stagingRoot, 'files')
    const files = await extractAcceleratorZip(zipPath, staging, acceleratorMatch)
    if (!files.some((file) => /^whisper-server(\.exe)?$/i.test(file))) {
      throw new Error(`accelerator-install: в сборке ${asset.label} нет whisper-server`)
    }
    const dest = path.join(managed, accelerator)
    await mkdir(managed, { recursive: true })
    await rm(dest, { recursive: true, force: true })
    try {
      await rename(staging, dest)
    } catch {
      await cp(staging, dest, { recursive: true })
    }
    await writeAccelerator(accelerator, platform, env, data)
    return { accelerator, dir: dest, files, bytes: asset.sizeBytes }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}

/** True when an accelerator directory contains a whisper-server binary. */
export async function listAcceleratorBuild(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir)
    return entries.filter((name) => /^whisper-server(\.exe)?$/i.test(name) || /\.(dll|so(\.\d+)*)$/i.test(name))
  } catch {
    return []
  }
}
