import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  voiceManagedDir,
  voiceModelDir,
  voiceSidecarNames,
  VOICE_MODEL_FILE
} from './voice.js'
import { voiceWebClient } from './voice-web-client.js'
import { createVoicePolicy } from './voice-context.js'
import { createOpenCodeAdapter } from './voice-opencode-adapter.js'

export function voiceClientScript(): string {
  return `(${voiceWebClient.toString()})((${createVoicePolicy.toString()})(), (${createOpenCodeAdapter.toString()})());`
}

const run = promisify(execFile)
export function injectVoice(html: string): string {
  return html.replace(
    /<\/head>/i,
    '<script src="/__orchestra_voice/client.js" defer></script></head>'
  )
}

export async function transcribeWebAudio(
  audio: Buffer,
  signal?: AbortSignal,
  model = 'base'
): Promise<string> {
  if (!['base', 'small'].includes(model)) throw new Error('Unknown voice model')
  if (
    audio.length < 46 ||
    audio.length > 44 + 120 * 32000 ||
    audio.toString('ascii', 0, 4) !== 'RIFF' ||
    audio.toString('ascii', 8, 16) !== 'WAVEfmt ' ||
    audio.readUInt32LE(16) !== 16 ||
    audio.readUInt16LE(20) !== 1 ||
    audio.readUInt16LE(22) !== 1 ||
    audio.readUInt32LE(24) !== 16000 ||
    audio.readUInt32LE(28) !== 32000 ||
    audio.readUInt16LE(32) !== 2 ||
    audio.readUInt16LE(34) !== 16 ||
    audio.toString('ascii', 36, 40) !== 'data' ||
    audio.readUInt32LE(40) !== audio.length - 44 ||
    audio.readUInt32LE(4) !== audio.length - 8 ||
    audio.length % 2
  )
    throw new Error('Invalid PCM WAV recording')
  const managed = voiceManagedDir(process.platform, process.env)
  const models = voiceModelDir(process.platform, process.env)
  const names = voiceSidecarNames(process.platform, process.arch)
  if (!managed || !models || !names)
    throw new Error('Голосовой ввод поддерживается на Windows и Linux.')
  const folder = await mkdtemp(path.join(tmpdir(), 'orchestra-voice-'))
  try {
    const wav = path.join(folder, 'audio.wav')
    await writeFile(wav, audio)
    await run(
      path.join(managed, names[1]!),
      [
        '-m',
        path.join(
          models,
          model === 'base' ? VOICE_MODEL_FILE : 'ggml-small.bin'
        ),
        '-l',
        'ru',
        '-f',
        wav,
        '-otxt',
        '-of',
        wav
      ],
      { timeout: 600_000, windowsHide: true, signal }
    )
    return (await readFile(`${wav}.txt`, 'utf8')).trim()
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

/** Loopback proxy keeps the web app and microphone API on the same origin. */
export async function startVoiceWeb(
  options: {
    upstream?: string
    port?: number
    transcribe?: (
      audio: Buffer,
      signal?: AbortSignal,
      model?: string
    ) => Promise<string>
  } = {}
) {
  const upstream = new URL(options.upstream ?? 'http://127.0.0.1:4096')
  if (
    upstream.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(upstream.hostname) ||
    upstream.username ||
    upstream.password ||
    upstream.pathname !== '/' ||
    upstream.search ||
    upstream.hash
  ) {
    throw new Error(
      '--upstream must be a local HTTP origin, for example http://127.0.0.1:4096'
    )
  }
  let busy = false
  const target = (url: string) =>
    new URL(upstream.origin + (url.startsWith('/') ? url : '/'))
  const server = http.createServer(async (req, res) => {
    const host = req.headers.host
    if (
      !host ||
      !['127.0.0.1', 'localhost', '[::1]'].some(
        (name) =>
          host ===
          `${name}:${(server.address() as import('node:net').AddressInfo).port}`
      )
    ) {
      res.writeHead(403).end()
      return
    }
    if (req.url === '/voice' && req.method === 'GET') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(
        injectVoice(
          '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Remote Voice</title><style>body{font:16px system-ui;background:#141917;color:#e9ede9;margin:24px}main{max-width:600px;margin:auto}button,select,textarea{font:inherit;padding:10px;margin:4px;border-radius:8px}button{cursor:pointer}</style></head><body><main id="orchestra-remote"><h1>Remote Voice</h1><p>Выберите сессию, запишите речь и проверьте текст перед отправкой.</p><a href="/">OpenCode Web</a></main></body></html>'
        )
      )
      return
    }
    // Manual remote delivery uses the existing same-origin OpenCode API, with CSRF protection.
    if (
      req.headers['x-orchestra-voice'] &&
      !req.url?.startsWith('/__orchestra_voice/') &&
      req.headers.origin !== `http://${host}`
    ) {
      res.writeHead(403).end()
      return
    }
    if (req.url?.startsWith('/__orchestra_voice/')) {
      res.setHeader('Cache-Control', 'no-store')
      if (req.url === '/__orchestra_voice/client.js' && req.method === 'GET') {
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
        res.end(voiceClientScript())
        return
      }
      if (
        req.url !== '/__orchestra_voice/transcribe' ||
        req.method !== 'POST'
      ) {
        res.writeHead(404).end()
        return
      }
      if (
        req.headers.origin !== `http://${host}` ||
        req.headers['x-orchestra-voice'] !== '1'
      ) {
        res.writeHead(403).end()
        return
      }
      const model = req.headers['x-orchestra-model'] ?? 'base'
      if (model !== 'base' && model !== 'small') {
        res.writeHead(400).end(JSON.stringify({ error: 'Неизвестная модель.' }))
        return
      }
      res.setHeader('Content-Type', 'application/json')
      if (busy) {
        res
          .writeHead(409)
          .end(
            JSON.stringify({
              error: 'Распознавание уже выполняется. Попробуйте позже.'
            })
          )
        return
      }
      busy = true
      const controller = new AbortController()
      req.once('aborted', () => controller.abort())
      res.once('close', () => {
        if (!res.writableEnded) controller.abort()
      })
      try {
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of req) {
          size += chunk.length
          if (size > 20 * 1024 * 1024) {
            res
              .writeHead(413)
              .end(JSON.stringify({ error: 'Запись слишком большая.' }))
            return
          }
          chunks.push(Buffer.from(chunk))
        }
        if (!size) {
          res.writeHead(400).end(JSON.stringify({ error: 'Пустая запись.' }))
          return
        }
        const text = await (options.transcribe ?? transcribeWebAudio)(
          Buffer.concat(chunks),
          controller.signal,
          model
        )
        if (controller.signal.aborted || res.destroyed) return
        res.end(JSON.stringify({ text }))
      } catch (error) {
        if (controller.signal.aborted || res.destroyed) return
        // execFile errors can include Whisper output; do not log private transcripts.
        console.error('Voice transcription failed', {
          code: (error as NodeJS.ErrnoException).code
        })
        res
          .writeHead(500)
          .end(
            JSON.stringify({
              error: `Не удалось распознать речь. Проверьте установку voice-overlay и модели ggml-${model}.bin.`
            })
          )
      } finally {
        busy = false
      }
      return
    }
    const proxy = http.request(
      target(req.url ?? '/'),
      {
        method: req.method,
        headers: {
          ...req.headers,
          host: upstream.host,
          'accept-encoding': 'identity'
        }
      },
      (response) => {
        const headers = { ...response.headers }
        if (headers['content-type']?.includes('text/html')) {
          delete headers['content-length']
          delete headers.etag
          const chunks: Buffer[] = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('end', () => {
            res.writeHead(response.statusCode ?? 200, headers)
            res.end(injectVoice(Buffer.concat(chunks).toString('utf8')))
          })
        } else {
          res.writeHead(response.statusCode ?? 200, headers)
          response.pipe(res)
        }
        response.on('error', () => res.destroy())
      }
    )
    proxy.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end('OpenCode недоступен. Запустите opencode web --port 4096.')
    })
    req.on('aborted', () => proxy.destroy())
    res.on('close', () => proxy.destroy())
    req.pipe(proxy)
  })
  // OpenCode terminals use WebSockets; relay the handshake and subsequent bytes.
  server.on('upgrade', (req, socket, head) => {
    const port = (server.address() as import('node:net').AddressInfo).port
    if (
      !['127.0.0.1', 'localhost', '[::1]'].some(
        (name) => req.headers.host === `${name}:${port}`
      ) ||
      (req.headers.origin &&
        req.headers.origin !== `http://${req.headers.host}`)
    ) {
      socket.destroy()
      return
    }
    const proxy = http.request(target(req.url ?? '/'), {
      headers: { ...req.headers, host: upstream.host }
    })
    proxy.on('upgrade', (response, remote, remoteHead) => {
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
          .map(([key, value]) => `${key}: ${value}`)
          .join('\r\n')}\r\n\r\n`
      )
      if (remoteHead.length) socket.write(remoteHead)
      if (head.length) remote.write(head)
      socket.pipe(remote).pipe(socket)
      socket.on('error', () => remote.destroy())
      remote.on('error', () => socket.destroy())
      socket.on('close', () => remote.destroy())
    })
    proxy.on('response', () => socket.destroy())
    proxy.on('error', () => socket.destroy())
    proxy.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 4097, '127.0.0.1', resolve)
  })
  const address = server.address() as import('node:net').AddressInfo
  return { server, url: `http://127.0.0.1:${address.port}` }
}
