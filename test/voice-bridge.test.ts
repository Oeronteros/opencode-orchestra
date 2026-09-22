import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { startVoiceWeb } from '../src/voice-web.js'
import { voiceBridgeClient } from '../src/voice-bridge-client.js'

test('overlay bridge selects focused tabs and binds insertion to the original route', async () => {
  const web = await startVoiceWeb({ port: 0 })
  const request = (path: string, body?: unknown, extra = {}) => fetch(web.url + '/__orchestra_voice/bridge/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-orchestra-voice': '1', ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const poll = (id: string, focused: boolean, extra = {}) => request('poll', {
    id, route: '/project/session/' + id, title: id, visible: true, focused, ...extra
  })
  try {
    assert.equal((await request('active')).status, 409)
    assert.equal((await request('active', undefined, { Origin: 'https://evil.example' })).status, 403)
    assert.equal((await fetch(web.url + '/__orchestra_voice/bridge/active')).status, 403)
    await poll('A', true)
    await poll('B', false)
    const original = await (await request('active')).json()
    assert.equal(original.id, 'A')
    // Losing focus to the native overlay retains the target.
    await poll('A', false)
    assert.equal((await (await request('active')).json()).id, 'A')
    const delivery = request('insert', { ...original, text: 'hello' })
    let job: Record<string, unknown> = {}
    for (let i = 0; i < 20 && !job.id; i++) {
      job = await (await poll('A', false)).json()
      if (!job.id) await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(job.text, 'hello')
    assert.equal((await (await poll('B', false)).json()).id, undefined)
    await poll('A', false, { ack: job.id })
    assert.deepEqual(await (await delivery).json(), { inserted: true })
    await poll('B', true)
    assert.equal((await (await request('active')).json()).id, 'B')
    assert.equal((await request('insert', { ...original, text: 'wrong tab' })).status, 409)
    await poll('A', true, { route: '/project/session/changed' })
    assert.equal((await request('insert', { ...original, text: 'wrong route' })).status, 409)
    await poll('A', false, { visible: false })
    // Never fall back to an older visible browser window.
    assert.equal((await request('active')).status, 409)
    await poll('B', false, { visible: false })
    assert.equal((await request('active')).status, 409)
    assert.equal((await request('poll', { id: {}, route: '/a' })).status, 400)
  } finally {
    web.server.closeAllConnections()
    await new Promise<void>((resolve, reject) => web.server.close(e => e ? reject(e) : resolve()))
  }
})

test('browser bridge inserts once, never submits, and reports route/visibility failures', async () => {
  let route = '/session/A'
  let visible = 'visible'
  const inserted: string[] = []
  const requests: Record<string, unknown>[] = []
  let tick: () => void = () => {}
  const jobs: Record<string, unknown>[] = []
  const adapter = {
    route: () => route, editor: () => ({}),
    insert: (text: string, expected: string) => {
      if (expected !== route) throw new Error('route changed')
      inserted.push(text)
    },
    submit: () => assert.fail('must never submit')
  }
  const context = {
    adapter, location: { pathname: '/session/A' }, crypto: { randomUUID: () => 'tab' },
    document: { title: 'A', get visibilityState() { return visible }, hasFocus: () => true, addEventListener() {} },
    window: { addEventListener() {} }, setInterval: (fn: () => void) => { tick = fn },
    AbortSignal,
    fetch: async (_url: string, init: { body: string }) => {
      requests.push(JSON.parse(init.body))
      return { ok: true, json: async () => jobs.shift() ?? {} }
    }
  }
  const flush = () => new Promise(resolve => setImmediate(resolve))
  runInNewContext(`(${voiceBridgeClient.toString()})(adapter)`, context)
  await flush()
  const job = { id: 'one', route, text: 'hello', expires: Date.now() + 10000 }
  jobs.push(job, job)
  tick(); await flush()
  assert.deepEqual(inserted, ['hello'])
  assert.ok(requests.some(r => r.ack === 'one' && !r.error))
  route = '/session/B'
  jobs.push({ ...job, id: 'two' })
  tick(); await flush()
  assert.match(String(requests.at(-1)?.error), /route changed/)
  visible = 'hidden'
  jobs.push({ ...job, id: 'three', route })
  tick(); await flush()
  assert.match(String(requests.at(-1)?.error), /скрыта/)
  visible = 'visible'
  jobs.push({ ...job, id: 'expired', route, expires: 0 })
  tick(); await flush()
  assert.match(String(requests.at(-1)?.error), /истекло/)
  assert.deepEqual(inserted, ['hello'])
})
