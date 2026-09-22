import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

type Tab = { id: string; route: string; title: string; visible: boolean; seen: number; focused: number }
type Job = { id: string; tab: string; route: string; text: string; expires: number; finish: (error?: string) => void }

/** One bridge per proxy. Tabs identify themselves, never infer a session from API recency. */
export function createVoiceBridge() {
  const tabs = new Map<string, Tab>()
  const jobs = new Map<string, Job>()
  let focusSequence = 0
  let activeId: string | undefined
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    if (req.headers['x-orchestra-voice'] !== '1' ||
        (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)) {
      reply(403, { error: 'Forbidden' }); return
    }
    const now = Date.now()
    for (const [id, tab] of tabs) if (now - tab.seen > 5000) tabs.delete(id)
    const active = () => {
      const tab = activeId ? tabs.get(activeId) : undefined
      return tab?.visible ? tab : undefined
    }
    if (req.method === 'GET' && req.url === '/__orchestra_voice/bridge/active') {
      const tab = active()
      reply(tab ? 200 : 409, tab ?? { error: 'Откройте нужную вкладку OpenCode через voice-web и нажмите в её поле ввода.' })
      return
    }
    if (req.method !== 'POST') { reply(404, {}); return }
    let body: Record<string, unknown>
    try {
      let size = 0
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        size += chunk.length
        if (size > 128_000) { reply(413, {}); return }
        chunks.push(chunk)
      }
      body = JSON.parse(Buffer.concat(chunks).toString())
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error()
    } catch { reply(400, {}); return }
    if (req.url === '/__orchestra_voice/bridge/poll') {
      const { id, route, title, visible, focused, ack, error } = body
      if (typeof id !== 'string' || !id || id.length > 100 || typeof route !== 'string' || !route.startsWith('/') || route.length > 4000) {
        reply(400, {}); return
      }
      const previous = tabs.get(id)
      if (!previous && tabs.size >= 100) { reply(429, {}); return }
      const tab = { id, route, title: typeof title === 'string' ? title.slice(0, 300) : route,
        visible: visible === true, seen: now,
        focused: focused === true ? ++focusSequence : previous?.focused ?? 0 }
      tabs.set(id, tab)
      if (focused === true) activeId = id
      if (typeof ack === 'string') {
        const job = jobs.get(ack)
        if (job?.tab === id) job.finish(typeof error === 'string' ? error : undefined)
      }
      const job = [...jobs.values()].find(job => job.tab === id && job.expires > now)
      reply(200, job ? { id: job.id, route: job.route, text: job.text, expires: job.expires } : {})
      return
    }
    if (req.url === '/__orchestra_voice/bridge/insert') {
      const { id, route, text } = body
      const tab = typeof id === 'string' ? tabs.get(id) : undefined
      if (!tab || !tab.visible || tab.route !== route || active()?.id !== tab.id) {
        reply(409, { error: 'Вкладка изменилась. Вернитесь в исходную вкладку и повторите вставку. Текст сохранён.' }); return
      }
      if (typeof text !== 'string' || !text.trim() || text.length > 100_000) { reply(400, {}); return }
      if ([...jobs.values()].some(job => job.tab === tab.id)) { reply(409, { error: 'Вставка уже выполняется.' }); return }
      await new Promise<void>(resolve => {
        const jobId = randomUUID()
        const timer = setTimeout(() => finish('Нет подтверждения вставки. Проверьте исходную вкладку перед повтором.'), 4000)
        const finish = (error?: string) => {
          clearTimeout(timer)
          jobs.delete(jobId)
          reply(error ? 409 : 200, error ? { error } : { inserted: true })
          resolve()
        }
        jobs.set(jobId, { id: jobId, tab: tab.id, route: tab.route, text, expires: now + 3500, finish })
      })
      return
    }
    reply(404, {})
  }
}
