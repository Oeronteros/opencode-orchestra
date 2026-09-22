import type { createOpenCodeAdapter } from './voice-opencode-adapter.js'

/** Serialized into the page alongside the existing native editor adapter. */
export function voiceBridgeClient(adapter: ReturnType<typeof createOpenCodeAdapter>) {
  if (location.pathname === '/voice') return
  const id = crypto.randomUUID()
  const completed = new Map<string, string | undefined>()
  let ack: { ack: string; error: string | undefined } | undefined
  let running = false
  let rerun = false
  async function poll() {
    if (running) { rerun = true; return }
    running = true
    try {
      const response = await fetch('/__orchestra_voice/bridge/poll', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-orchestra-voice': '1' },
        body: JSON.stringify({ id, route: adapter.route(), title: document.title,
          visible: document.visibilityState === 'visible' && !!adapter.editor(),
          focused: document.hasFocus(), ...ack }),
        signal: AbortSignal.timeout(3000)
      })
      if (!response.ok) return
      ack = undefined
      const job = await response.json()
      if (!job.id) return
      if (!completed.has(job.id)) {
        let error: string | undefined
        try {
          if (Date.now() >= job.expires || document.visibilityState !== 'visible')
            throw new Error('Вкладка скрыта или время вставки истекло. Текст сохранён в оверлее.')
          adapter.insert(job.text, job.route)
        } catch (e) { error = e instanceof Error ? e.message : String(e) }
        completed.set(job.id, error)
        if (completed.size > 100) completed.delete(completed.keys().next().value!)
      }
      ack = { ack: job.id, error: completed.get(job.id) }
      rerun = true
    } catch { /* The overlay retains the transcript if the proxy is unavailable. */ }
    finally {
      running = false
      if (rerun) { rerun = false; void poll() }
    }
  }
  window.addEventListener('focus', () => void poll())
  document.addEventListener('visibilitychange', () => void poll())
  window.addEventListener('popstate', () => void poll())
  setInterval(() => void poll(), 500)
  void poll()
}
