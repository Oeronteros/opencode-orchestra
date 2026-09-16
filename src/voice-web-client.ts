/** Runs in the OpenCode page; serialized into an external same-origin script. */
export function voiceWebClient() {
  const selector = '[data-component="prompt-input"][contenteditable="true"]'
  const icon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>'
  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute('data-action', 'orchestra-voice')
  button.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;min-width:36px;height:36px;border-radius:8px;margin-right:6px;color:inherit;background:transparent;border:1px solid #8885;cursor:pointer'
  const notice = document.createElement('div')
  notice.setAttribute('role', 'status')
  notice.style.cssText = 'position:fixed;bottom:110px;right:24px;max-width:min(400px,90vw);padding:12px;border-radius:8px;background:#252b35;color:white;z-index:9999;display:none;white-space:pre-wrap'
  document.body.append(notice)
  const panel = document.createElement('section')
  panel.setAttribute('aria-label', 'Распознанный текст')
  panel.style.cssText = 'position:fixed;bottom:180px;right:24px;width:min(400px,90vw);padding:12px;border-radius:8px;background:#252b35;color:white;z-index:9999;display:none'
  const draft = document.createElement('textarea')
  draft.setAttribute('aria-label', 'Распознанный текст — можно исправить')
  draft.rows = 5
  draft.style.cssText = 'width:100%;padding:8px;color:inherit;background:#161b22;border:1px solid #8885;border-radius:6px;resize:vertical'
  const actions = document.createElement('div')
  actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:8px'
  panel.append(draft, actions)
  document.body.append(panel)
  const action = (label: string, handler: () => void) => {
    const control = document.createElement('button')
    control.type = 'button'; control.textContent = label; control.onclick = handler
    control.style.cssText = 'padding:6px;border:1px solid #8885;border-radius:6px;color:inherit;background:#343c49;cursor:pointer'
    actions.append(control)
    return control
  }
  type Job = { route: string; controller: AbortController; recorder?: MediaRecorder; stream?: MediaStream; timer?: ReturnType<typeof setTimeout> }
  let active: Job | undefined
  let pending: { route: string; text: string } | undefined
  const storageKey = 'orchestra-voice-pending:v1'
  const route = () => location.pathname
  const show = (text: string) => { notice.textContent = text; notice.style.display = text ? 'block' : 'none' }
  const save = () => {
    try {
      if (pending) window.sessionStorage.setItem(storageKey, JSON.stringify(pending))
      else window.sessionStorage.removeItem(storageKey)
    } catch { /* The visible draft remains available when storage is disabled. */ }
  }
  const renderDraft = () => {
    draft.value = pending?.text ?? ''
    draft.hidden = !pending
    panel.style.display = pending || active ? 'block' : 'none'
    insertButton.hidden = copyButton.hidden = discardButton.hidden = !pending
    cancelButton.hidden = !active
  }
  const reset = () => {
    button.innerHTML = icon
    button.title = pending ? 'Показать распознанный текст' : 'Голосовой ввод в открытую сессию'
    button.setAttribute('aria-label', button.title); button.setAttribute('aria-pressed', 'false')
    button.disabled = false; button.style.color = 'inherit'
  }
  const insert = () => {
    if (!pending) return
    if (pending.route !== route()) { show('Вернитесь в исходную сессию для вставки или скопируйте текст.'); return }
    const editor = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(el => el.getClientRects().length)
    if (!editor || !pending.text.trim()) { show('Поле ввода недоступно или текст пуст. Результат сохранён.'); return }
    editor.focus()
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(editor); range.collapse(false)
    selection?.removeAllRanges(); selection?.addRange(range)
    try {
      // Native editing fires OpenCode's input handler and preserves mentions/attachments.
      if (!document.execCommand('insertText', false, (editor.textContent ? ' ' : '') + pending.text)) throw new Error('insert failed')
    } catch { show('Не удалось вставить текст. Скопируйте его ниже.'); return }
    pending = undefined; save(); renderDraft(); reset(); show('')
  }
  const insertButton = action('Вставить в исходную сессию', insert)
  const copyButton = action('Копировать', () => {
    if (!pending) return
    if (!navigator.clipboard) { show('Выделите и скопируйте текст вручную.'); return }
    void navigator.clipboard.writeText(pending.text).then(() => show('Текст скопирован.'))
      .catch(() => show('Выделите и скопируйте текст вручную.'))
  })
  const discardButton = action('Удалить', () => { pending = undefined; save(); renderDraft(); reset(); show('') })
  const cancelButton = action('Отменить', () => {
    if (active) { active.controller.abort(); cleanup(active); show('Запись или распознавание отменено.') }
  })
  draft.oninput = () => { if (pending) { pending.text = draft.value; save() } }
  function cleanup(job: Job) {
    clearTimeout(job.timer)
    if (job.recorder) { job.recorder.onstop = null; job.recorder.onerror = null; job.recorder.ondataavailable = null }
    if (job.recorder?.state === 'recording') job.recorder.stop()
    job.stream?.getTracks().forEach(track => track.stop())
    if (active !== job) return
    active = undefined; reset(); renderDraft()
  }
  button.onclick = async () => {
    if (active?.recorder?.state === 'recording') { button.disabled = true; active.recorder.stop(); return }
    if (active) return
    if (pending) { renderDraft(); insert(); return }
    const job: Job = { route: route(), controller: new AbortController() }
    active = job; button.disabled = true; renderDraft()
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('Браузер не поддерживает запись. Откройте страницу через localhost в Chrome или Edge.')
      show('Разрешите доступ к микрофону…')
      job.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (active !== job) { cleanup(job); return }
      const chunks: Blob[] = []
      const recorder = job.recorder = new MediaRecorder(job.stream)
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data) }
      recorder.onerror = () => { if (active === job) show('Ошибка записи микрофона. Попробуйте ещё раз.'); cleanup(job) }
      recorder.onstop = async () => {
        if (active !== job) return
        clearTimeout(job.timer)
        job.stream?.getTracks().forEach(track => track.stop())
        button.disabled = true; button.textContent = '…'; show('Распознаю речь…')
        job.timer = setTimeout(() => job.controller.abort(), 610_000)
        try {
          const context = new AudioContext()
          let decoded: AudioBuffer
          try { decoded = await context.decodeAudioData(await new Blob(chunks).arrayBuffer()) }
          finally { await context.close() }
          if (active !== job) return
          if (decoded.duration < 0.5) throw new Error('Запись короче полсекунды. Попробуйте ещё раз.')
          const offline = new OfflineAudioContext(1, Math.ceil(Math.min(decoded.duration, 120) * 16000), 16000)
          const source = offline.createBufferSource()
          source.buffer = decoded; source.connect(offline.destination); source.start()
          const samples = (await offline.startRendering()).getChannelData(0)
          if (active !== job) return
          const wav = new ArrayBuffer(44 + samples.length * 2)
          const view = new DataView(wav)
          const label = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)) }
          label(0, 'RIFF'); view.setUint32(4, wav.byteLength - 8, true); label(8, 'WAVE'); label(12, 'fmt ')
          view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
          view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
          label(36, 'data'); view.setUint32(40, samples.length * 2, true)
          samples.forEach((sample, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767), true))
          const response = await fetch('/__orchestra_voice/transcribe', {
            method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Orchestra-Voice': '1' },
            body: wav, signal: job.controller.signal,
          })
          const result = await response.json()
          if (active !== job) return
          if (!response.ok) throw new Error(result.error || 'Ошибка распознавания')
          if (typeof result.text !== 'string' || !result.text.trim()) { show('Речь не распознана. Попробуйте ещё раз.'); return }
          pending = { route: job.route, text: result.text.trim() }; save(); renderDraft(); insert()
        } catch (error) {
          if (active === job) show(job.controller.signal.aborted ? 'Превышено время ожидания распознавания. Попробуйте ещё раз.' : error instanceof Error ? error.message : String(error))
        } finally { cleanup(job) }
      }
      recorder.start()
      button.disabled = false; button.textContent = '■'; button.style.color = '#ef6666'
      button.title = 'Остановить запись'; button.setAttribute('aria-label', button.title); button.setAttribute('aria-pressed', 'true')
      show('Запись… Нажмите ■ для остановки (максимум 120 секунд).')
      job.timer = setTimeout(() => { if (active === job && recorder.state === 'recording') { button.disabled = true; recorder.stop() } }, 120_000)
    } catch (error) { if (active === job) show(error instanceof Error ? error.message : String(error)); cleanup(job) }
  }
  function mount() {
    const editor = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(el => el.getClientRects().length)
    const form = editor?.closest('form')
    const send = form?.querySelector('button[data-action="prompt-submit"]') ?? form?.querySelector('button[type="submit"]')
    if (send && !button.isConnected) send.parentElement?.insertBefore(button, send)
    if (send && button.closest('form') !== form) send.parentElement?.insertBefore(button, send)
  }
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(storageKey) ?? 'null')
    if (typeof saved?.route === 'string' && saved.route.startsWith('/') && typeof saved.text === 'string') pending = { route: saved.route, text: saved.text }
  } catch { /* No saved draft. */ }
  reset(); renderDraft(); mount()
  new MutationObserver(mount).observe(document.body, { childList: true, subtree: true })
  window.addEventListener('pagehide', () => { if (active) { active.controller.abort(); cleanup(active) } })
}
