import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { voiceBrowser } from './fixtures/voice-browser.js'
import {
  createVoicePolicy,
  normalizeOverlaySettings
} from '../src/voice-context.js'
import { startVoiceWeb, transcribeWebAudio } from '../src/voice-web.js'

test('voice web injects the UI, proxies API bodies and gates transcription to its own origin', async () => {
  const upstream = http
    .createServer(async (req, res) => {
      if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html')
        res.end('<html><head></head><body>OpenCode</body></html>')
        return
      }
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      res.end(
        JSON.stringify({
          url: req.url,
          body: Buffer.concat(chunks).toString(),
          auth: req.headers.authorization
        })
      )
    })
    .listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  let calls = 0
  const web = await startVoiceWeb({
    port: 0,
    upstream: `http://127.0.0.1:${(upstream.address() as import('node:net').AddressInfo).port}`,
    transcribe: async (audio) => {
      calls++
      assert.equal(audio.toString(), 'audio')
      return 'Привет'
    }
  })
  try {
    assert.match(
      await (await fetch(web.url)).text(),
      /script src="\/__orchestra_voice\/client.js"/
    )
    const remote = await (await fetch(web.url + '/voice')).text()
    assert.match(remote, /Remote Voice/)
    assert.match(remote, /id="orchestra-remote"/)
    const script = await (
      await fetch(web.url + '/__orchestra_voice/client.js')
    ).text()
    assert.doesNotThrow(() => new Function(script))
    const api = await fetch(web.url + '/session/test', {
      method: 'POST',
      body: 'draft',
      headers: { Authorization: 'Basic example' }
    })
    assert.deepEqual(await api.json(), {
      url: '/session/test',
      body: 'draft',
      auth: 'Basic example'
    })
    const endpoint = web.url + '/__orchestra_voice/transcribe'
    assert.equal(
      (await fetch(endpoint, { method: 'POST', body: 'audio' })).status,
      403
    )
    assert.equal(
      (
        await fetch(endpoint, {
          method: 'POST',
          headers: { Origin: 'https://example.com', 'X-Orchestra-Voice': '1' },
          body: 'audio'
        })
      ).status,
      403
    )
    assert.equal(calls, 0)
    const headers = { Origin: web.url, 'X-Orchestra-Voice': '1' }
    assert.equal(
      (
        await fetch(endpoint, {
          method: 'POST',
          headers: { ...headers, 'X-Orchestra-Model': '../../secret' },
          body: 'audio'
        })
      ).status,
      400
    )
    assert.equal(
      (await fetch(endpoint, { method: 'POST', headers })).status,
      400
    )
    assert.deepEqual(
      await (
        await fetch(endpoint, { method: 'POST', headers, body: 'audio' })
      ).json(),
      { text: 'Привет' }
    )
    assert.equal(calls, 1)
  } finally {
    web.server.closeAllConnections()
    upstream.closeAllConnections()
    await Promise.all([
      new Promise<void>((resolve) => web.server.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve()))
    ])
  }
})

test('new-session draft query changes preserve transcription for the original draft', async () => {
  const browser = voiceBrowser()
  browser.location.pathname = '/new-session'
  browser.location.search = '?draftId=A'
  await browser.button.click()
  browser.location.search = '?draftId=B'
  await browser.recording.stop()
  assert.equal(browser.inserted.length, 0)
  assert.match(browser.storage.get('orchestra-voice-pending:v1')!, /draftId=A/)
  browser.location.search = '?draftId=A'
  await browser.button.click()
  assert.equal(browser.inserted.length, 1)
})

for (const name of [
  'NotAllowedError',
  'NotFoundError',
  'OverconstrainedError'
]) {
  test(`microphone ${name} releases the operation and permits retry`, async () => {
    const browser = voiceBrowser()
    browser.failMicrophone(name)
    await browser.button.click()
    assert.equal(typeof browser.recording, 'undefined')
    assert.equal(browser.button.disabled, false)
    assert.equal(browser.requests.length, 0)
    browser.failMicrophone()
    await browser.button.click()
    await browser.recording.stop()
    assert.equal(browser.inserted.length, 1)
  })
}

test('recorder error stops tracks and allows a fresh recording', async () => {
  const browser = voiceBrowser()
  await browser.button.click()
  browser.recording.onerror()
  assert.ok(browser.stopped > 0)
  assert.equal(browser.button.disabled, false)
  assert.equal(browser.requests.length, 0)
  await browser.button.click()
  await browser.recording.stop()
  assert.equal(browser.inserted.length, 1)
})

test('cancelling pending transcription ignores even a late successful response', async () => {
  const browser = voiceBrowser({
    preferences: { postTranscriptionAction: 'insert-and-submit' }
  })
  let release!: (value: unknown) => void
  let started!: () => void
  const waiting = new Promise<void>((resolve) => {
    started = resolve
  })
  browser.onFetch(async () => {
    started()
    return new Promise((resolve) => {
      release = resolve
    })
  })
  await browser.button.click()
  const stopping = browser.recording.stop()
  await waiting
  browser.byText('Отменить').click()
  release({ ok: true, json: async () => ({ text: 'Late response' }) })
  await stopping
  assert.equal(browser.inserted.length, 0)
  assert.equal(browser.submitted, 0)
  assert.equal(browser.button.disabled, false)
})

test('settings are saved and restored by the browser client', () => {
  const browser = voiceBrowser()
  const select = browser.elements.find(
    (el) => el.tag === 'label' && el.textContent === 'После распознавания'
  )!.children[0]!
  select.value = 'insert-and-submit'
  browser.byText('Сохранить').click()
  const saved = JSON.parse(browser.storage.get('orchestra-voice-settings:v1')!)
  assert.equal(saved.postTranscriptionAction, 'insert-and-submit')
  const reloaded = voiceBrowser({ preferences: saved })
  assert.equal(
    reloaded.elements.find(
      (el) => el.tag === 'label' && el.textContent === 'После распознавания'
    )!.children[0]!.value,
    'insert-and-submit'
  )
})

test('voice settings keep native select menus legible without hover', () => {
  const browser = voiceBrowser()
  const microphone = browser.elements.find(
    (el) => el.tag === 'label' && el.textContent === 'Микрофон'
  )!.children[0]!
  assert.match(microphone.style.cssText ?? '', /color:#f8fafc/)
  assert.match(microphone.style.cssText ?? '', /background:#161b22/)
  assert.match(microphone.style.cssText ?? '', /color-scheme:dark/)
  assert.match(microphone.children[0]!.style.cssText ?? '', /color:#f8fafc/)
  assert.match(
    microphone.children[0]!.style.cssText ?? '',
    /background:#161b22/
  )
})

test('voice web rejects remote upstreams and invalid audio', async () => {
  await assert.rejects(
    startVoiceWeb({ upstream: 'http://example.com' }),
    /local HTTP/
  )
  await assert.rejects(
    transcribeWebAudio(Buffer.from('invalid')),
    /Invalid PCM/
  )
})

test('destination policy preserves legacy settings and defaults to Auto/Insert', () => {
  const policy = createVoicePolicy()
  assert.equal(policy.preferences(null).target, 'auto')
  assert.equal(policy.preferences({}).postTranscriptionAction, 'insert')
  assert.equal(policy.preferences({ destination: 'web' }).target, 'web')
  assert.equal(
    policy.preferences({ target: 'tui', sessionId: 'old' }).sessionId,
    'old'
  )
  assert.equal(
    policy.preferences({ target: 'invalid', model: '../../secret', device: 42 })
      .model,
    'base'
  )
  assert.equal(policy.preferences({ device: 42 }).device, '')
  assert.deepEqual(
    policy.resolve('auto', { source: 'web', route: '/project/session/A' }),
    { type: 'composer', route: '/project/session/A' }
  )
  assert.deepEqual(
    policy.resolve('tui', { source: 'web', route: '/project/session/A' }),
    { type: 'composer', route: '/project/session/A' }
  )
  assert.deepEqual(policy.resolve('auto', { source: 'tui' }), { type: 'tui' })
  assert.deepEqual(
    policy.resolve('auto', { source: 'remote', sessionId: 'A' }),
    { type: 'session', sessionId: 'A' }
  )
  assert.deepEqual(
    policy.resolve('auto', { source: 'remote', sessionId: '' }),
    { type: 'picker' }
  )
  assert.deepEqual(policy.resolve('auto', { source: 'unknown' }), {
    type: 'picker'
  })
  assert.deepEqual(policy.resolve('auto', { source: 'unknown' }, 'stale'), {
    type: 'picker'
  })
  assert.deepEqual(policy.resolve('auto', { source: 'web', route: '' }), {
    type: 'picker'
  })
})

test('overlay config migration retains credentials and legacy destination, sanitizes invalid fields', () => {
  const old = {
    target: 'web',
    sessionId: 'A',
    host: 'localhost',
    port: 5000,
    username: 'user',
    password: 'secret',
    device: 'Mic',
    model: 'small'
  }
  assert.deepEqual(normalizeOverlaySettings(old), {
    ...old,
    browserPort: 4097,
    postTranscriptionAction: 'insert'
  })
  assert.equal(normalizeOverlaySettings({ destination: 'web' }).target, 'web')
  const defaults = normalizeOverlaySettings(null)
  assert.equal(defaults.target, 'auto')
  for (const corrupt of [
    [],
    42,
    'oops',
    { target: 5, port: -1, password: null, model: '../../bad' }
  ]) {
    assert.deepEqual(normalizeOverlaySettings(corrupt), defaults)
  }
})

for (const fallbackSend of [false, true]) {
  test(`one microphone survives repeated injection and SPA rerenders (fallback=${fallbackSend})`, () => {
    const browser = voiceBrowser({ fallbackSend })
    const count = () =>
      browser.form.children.filter(
        (el) => el.getAttribute('data-action') === 'orchestra-voice'
      ).length
    assert.equal(count(), 1)
    for (let i = 0; i < 5; i++) {
      browser.observe()
      browser.inject()
      assert.equal(count(), 1)
    }
    for (let i = 0; i < 5; i++) {
      browser.replaceComposer()
      browser.observe()
      assert.equal(count(), 1)
    }
  })
}

for (const action of ['insert', 'insert-and-submit']) {
  test(`embedded ${action} uses composer, never the session API`, async () => {
    const browser = voiceBrowser({
      preferences: {
        target: 'web',
        sessionId: 'wrong-session',
        postTranscriptionAction: action,
        model: 'small',
        device: 'microphone-1'
      }
    })
    await browser.button.click()
    await browser.recording.stop()
    assert.deepEqual(browser.inserted, [
      { route: '/project-a/session/ses_one', text: ' Привет' }
    ])
    assert.equal(browser.submitted, action === 'insert' ? 0 : 1)
    assert.equal(browser.requests.length, 1)
    assert.equal(browser.requests[0]?.url, '/__orchestra_voice/transcribe')
    assert.equal(
      browser.requests[0]?.init.headers['X-Orchestra-Model'],
      'small'
    )
    assert.equal(
      JSON.stringify(browser.constraints),
      JSON.stringify({ audio: { deviceId: { exact: 'microphone-1' } } })
    )
    assert.ok(browser.stopped > 0)
    assert.equal(browser.byLabel('Распознанный текст').style.display, 'none')
    const sessionLabel = browser.elements.find(
      (el) => el.tag === 'label' && el.textContent === 'Сессия'
    )!
    assert.equal(sessionLabel.style.display, 'none')
  })
}

test('session switch during STT retains draft; recovery inserts without automatic submit', async () => {
  const browser = voiceBrowser({
    preferences: { postTranscriptionAction: 'insert-and-submit' }
  })
  await browser.button.click()
  browser.onFetch(async () => {
    browser.location.pathname = '/project-b/session/ses_two'
    return { ok: true, json: async () => ({ text: 'Привет' }) }
  })
  await browser.recording.stop()
  assert.deepEqual(browser.inserted, [])
  assert.equal(browser.submitted, 0)
  assert.equal(
    browser.byLabel('Распознанный текст — можно исправить').value,
    'Привет'
  )
  await browser.button.click()
  assert.equal(browser.inserted.length, 0)
  browser.location.pathname = '/project-a/session/ses_one'
  await browser.button.click()
  assert.equal(browser.inserted.length, 1)
  assert.equal(browser.submitted, 0)
})

test('navigation between insertion and submit cancels submit', async () => {
  const browser = voiceBrowser({
    preferences: { postTranscriptionAction: 'insert-and-submit' }
  })
  browser.onFrame(() => {
    browser.location.pathname = '/project-b/session/ses_two'
  })
  await browser.button.click()
  await browser.recording.stop()
  assert.equal(browser.inserted.length, 1)
  assert.equal(browser.submitted, 0)
})

test('disabled send leaves text in the composer without retrying or duplicating it', async () => {
  const browser = voiceBrowser({
    preferences: { postTranscriptionAction: 'insert-and-submit' }
  })
  browser.send.disabled = true
  await browser.button.click()
  await browser.recording.stop()
  assert.equal(browser.inserted.length, 1)
  assert.equal(browser.submitted, 0)
  browser.send.disabled = false
  browser.observe()
  assert.equal(browser.submitted, 0)
})

test('missing composer preserves transcription in recoverable storage', async () => {
  const browser = voiceBrowser()
  await browser.button.click()
  browser.form.remove()
  await browser.recording.stop()
  assert.equal(browser.inserted.length, 0)
  assert.match(browser.storage.get('orchestra-voice-pending:v1')!, /Привет/)
  browser.replaceComposer()
  browser.observe()
  await browser.button.click()
  assert.equal(browser.inserted.length, 1)
})

for (const action of ['insert', 'insert-and-submit']) {
  test(`remote ${action} keeps the manual session flow`, async () => {
    const browser = voiceBrowser({
      remote: true,
      preferences: { sessionId: 'ses_one', postTranscriptionAction: action }
    })
    await new Promise((resolve) => setImmediate(resolve))
    await browser.button.click()
    await browser.recording.stop()
    assert.equal(browser.inserted.length, 0)
    let sends = browser.requests.filter((req) =>
      req.url.includes('prompt_async')
    )
    assert.equal(sends.length, action === 'insert' ? 0 : 1)
    if (action === 'insert') {
      browser.byText('Отправить в сессию').click()
      await new Promise((resolve) => setImmediate(resolve))
      sends = browser.requests.filter((req) => req.url.includes('prompt_async'))
    }
    assert.equal(sends.length, 1)
    assert.equal(sends[0]?.url, '/session/ses_one/prompt_async')
  })
}

test('remote without a selected session requests selection before recording', async () => {
  const browser = voiceBrowser({ remote: true })
  await new Promise((resolve) => setImmediate(resolve))
  await browser.button.click()
  assert.equal(browser.recording, undefined)
  assert.equal(
    browser.requests.filter((req) => req.url.includes('transcribe')).length,
    0
  )
})

test('failed transcription can be retried and does not insert or submit', async () => {
  const browser = voiceBrowser()
  browser.onFetch(async () => ({
    ok: false,
    json: async () => ({ error: 'Backend unavailable' })
  }))
  await browser.button.click()
  await browser.recording.stop()
  assert.equal(browser.inserted.length, 0)
  assert.equal(browser.button.disabled, false)
  browser.onFetch(async () => ({
    ok: true,
    json: async () => ({ text: 'Recovered' })
  }))
  await browser.button.click()
  await browser.recording.stop()
  assert.equal(browser.inserted[0]?.text, ' Recovered')
})

test(
  'aborting a browser request cancels server-side transcription',
  { timeout: 10_000 },
  async () => {
    const upstream = http
      .createServer((_req, res) => res.end('ok'))
      .listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    let started!: () => void
    const transcriptionStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    let cancelled = false
    const web = await startVoiceWeb({
      port: 0,
      upstream: `http://127.0.0.1:${(upstream.address() as import('node:net').AddressInfo).port}`,
      transcribe: async (_audio, signal) =>
        new Promise<string>((_resolve, reject) => {
          started()
          signal?.addEventListener(
            'abort',
            () => {
              cancelled = true
              reject(new Error('cancelled'))
            },
            { once: true }
          )
        })
    })
    try {
      const controller = new AbortController()
      const request = fetch(web.url + '/__orchestra_voice/transcribe', {
        method: 'POST',
        headers: { Origin: web.url, 'X-Orchestra-Voice': '1' },
        body: 'audio',
        signal: controller.signal
      })
      await transcriptionStarted
      controller.abort()
      await assert.rejects(request, /abort/i)
      await new Promise((resolve) => setTimeout(resolve, 25))
      assert.equal(cancelled, true)
    } finally {
      const closed = Promise.all([
        new Promise<void>((resolve) => web.server.close(() => resolve())),
        new Promise<void>((resolve) => upstream.close(() => resolve()))
      ])
      web.server.closeAllConnections()
      upstream.closeAllConnections()
      await closed
    }
  }
)
