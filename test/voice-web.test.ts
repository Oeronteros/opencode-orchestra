import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import { startVoiceWeb, transcribeWebAudio } from '../src/voice-web.js'
import { voiceWebClient } from '../src/voice-web-client.js'

test('voice web injects the UI, proxies API bodies and gates transcription to its own origin', async () => {
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<html><head></head><body>OpenCode</body></html>'); return }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    res.end(JSON.stringify({ url: req.url, body: Buffer.concat(chunks).toString(), auth: req.headers.authorization }))
  }).listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  let calls = 0
  const web = await startVoiceWeb({ port: 0, upstream: `http://127.0.0.1:${(upstream.address() as import('node:net').AddressInfo).port}`, transcribe: async audio => { calls++; assert.equal(audio.toString(), 'audio'); return 'Привет' } })
  try {
    assert.match(await (await fetch(web.url)).text(), /script src="\/__orchestra_voice\/client.js"/)
    const script = await (await fetch(web.url + '/__orchestra_voice/client.js')).text()
    assert.doesNotThrow(() => new Function(script))
    const api = await fetch(web.url + '/session/test', { method: 'POST', body: 'draft', headers: { Authorization: 'Basic example' } })
    assert.deepEqual(await api.json(), { url: '/session/test', body: 'draft', auth: 'Basic example' })
    const endpoint = web.url + '/__orchestra_voice/transcribe'
    assert.equal((await fetch(endpoint, { method: 'POST', body: 'audio' })).status, 403)
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { Origin: 'https://example.com', 'X-Orchestra-Voice': '1' }, body: 'audio' })).status, 403)
    assert.equal(calls, 0)
    const headers = { Origin: web.url, 'X-Orchestra-Voice': '1' }
    assert.equal((await fetch(endpoint, { method: 'POST', headers })).status, 400)
    assert.deepEqual(await (await fetch(endpoint, { method: 'POST', headers, body: 'audio' })).json(), { text: 'Привет' })
    assert.equal(calls, 1)
  } finally {
    web.server.closeAllConnections(); upstream.closeAllConnections()
    await Promise.all([new Promise<void>(resolve => web.server.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))])
  }
})

test('voice web rejects remote upstreams and invalid audio', async () => {
  await assert.rejects(startVoiceWeb({ upstream: 'http://example.com' }), /local HTTP/)
  await assert.rejects(transcribeWebAudio(Buffer.from('invalid')), /Invalid PCM/)
})

test('aborting a browser request cancels server-side transcription', async () => {
  const upstream = http.createServer((_req, res) => res.end('ok')).listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  let started!: () => void
  const transcriptionStarted = new Promise<void>(resolve => { started = resolve })
  let cancelled = false
  const web = await startVoiceWeb({
    port: 0,
    upstream: `http://127.0.0.1:${(upstream.address() as import('node:net').AddressInfo).port}`,
    transcribe: async (_audio, signal) => new Promise<string>((_resolve, reject) => {
      started()
      signal?.addEventListener('abort', () => { cancelled = true; reject(new Error('cancelled')) }, { once: true })
    }),
  })
  try {
    const controller = new AbortController()
    const request = fetch(web.url + '/__orchestra_voice/transcribe', {
      method: 'POST',
      headers: { Origin: web.url, 'X-Orchestra-Voice': '1' },
      body: 'audio',
      signal: controller.signal,
    })
    await transcriptionStarted
    controller.abort()
    await assert.rejects(request, /abort/i)
    await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(cancelled, true)
  } finally {
    web.server.closeAllConnections(); upstream.closeAllConnections()
    await Promise.all([new Promise<void>(resolve => web.server.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))])
  }
})

for (const sendSelector of ['button[data-action="prompt-submit"]', 'button[type="submit"]']) {
  test(`microphone mounts beside ${sendSelector} and survives composer replacement`, () => {
    let mounted = 0
    let observe: (() => void) | undefined
    let currentForm: object
    const createForm = () => {
      const form = { querySelector: (selector: string) => selector === sendSelector ? send : null }
      const send = { parentElement: { insertBefore(button: any, anchor: unknown) {
        assert.equal(anchor, send)
        button.isConnected = true
        button.closest = () => form
        mounted++
      } } }
      return form
    }
    currentForm = createForm()
    const editor = { getClientRects: () => [1], closest: () => currentForm }
    runInNewContext(`(${voiceWebClient.toString()})();`, {
      document: {
        body: { append() {} },
        createElement: () => ({ style: {}, setAttribute() {}, append() {}, isConnected: false }),
        querySelectorAll: () => [editor],
      },
      window: { addEventListener() {} },
      MutationObserver: class { constructor(callback: () => void) { observe = callback } observe() {} },
    })
    assert.equal(mounted, 1)
    observe!()
    assert.equal(mounted, 1)
    currentForm = createForm()
    observe!()
    assert.equal(mounted, 2)
  })
}

test('dictation stays with the project/session captured at recording start', async () => {
  const location = { pathname: '/project-a/session/ses_one' }
  const inserted: { route: string; text: string }[] = []
  const elements: any[] = []
  let stopped = 0
  const editor = { textContent: 'Existing draft', focus() {}, getClientRects: () => [1], closest: () => null }
  const document = {
    body: { append() {} },
    createElement: () => {
      const element = { style: {}, setAttribute() {}, append() {}, textContent: '', onclick: undefined, hidden: false }
      elements.push(element)
      return element
    },
    querySelectorAll: (selector: string) => selector.includes('prompt-input') ? [editor] : [],
    createRange: () => ({ selectNodeContents() {}, collapse() {} }),
    execCommand: (_command: string, _ui: boolean, text: string) => { inserted.push({ route: location.pathname, text }); return true },
  }
  let recording: any
  class Recorder {
    state = 'inactive'
    ondataavailable: any
    onstop: any
    constructor() { recording = this }
    start() { this.state = 'recording' }
    async stop() { this.state = 'inactive'; this.ondataavailable({ data: new Blob(['audio']) }); await this.onstop() }
  }
  runInNewContext(`(${voiceWebClient.toString()})();`, {
    document, location, Blob, setTimeout, clearTimeout,
    window: {
      addEventListener() {}, getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
      sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { stopped++ } }] }) } },
    MediaRecorder: Recorder,
    AudioContext: class { async decodeAudioData() { return { duration: 1 } } async close() {} },
    OfflineAudioContext: class { destination = {}; createBufferSource() { return { connect() {}, start() {} } } async startRendering() { return { getChannelData: () => new Float32Array(16000) } } },
    MutationObserver: class { observe() {} }, AbortController,
    fetch: async () => ({ ok: true, json: async () => ({ text: 'Привет' }) }),
  })
  const button = elements[0]
  await button.onclick()
  location.pathname = '/project-b/session/ses_two'
  await recording.stop()
  assert.equal(stopped > 0, true)
  assert.deepEqual(inserted, [])
  await button.onclick()
  assert.deepEqual(inserted, [])
  assert.equal(elements[3].value, 'Привет')
  location.pathname = '/project-a/session/ses_one'
  await button.onclick()
  assert.deepEqual(inserted, [{ route: '/project-a/session/ses_one', text: ' Привет' }])
  await button.onclick()
  await recording.stop()
  assert.equal(inserted.length, 2)
})
