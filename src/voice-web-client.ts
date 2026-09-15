/** Runs in the OpenCode page; serialized into an external same-origin script. */
export function voiceWebClient() {
  const selector = '[data-component="prompt-input"][contenteditable="true"]'
  const icon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>'
  const button = document.createElement('button')
  button.type = 'button'
  button.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;min-width:36px;height:36px;border-radius:8px;margin-right:6px;color:inherit;background:transparent;border:1px solid #8885;cursor:pointer'
  const notice = document.createElement('div')
  notice.setAttribute('role', 'status')
  notice.style.cssText = 'position:fixed;bottom:110px;right:24px;max-width:400px;padding:12px;border-radius:8px;background:#252b35;color:white;z-index:9999;display:none;white-space:pre-wrap'
  document.body.append(notice)
  let recorder: MediaRecorder | undefined
  let stream: MediaStream | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let busy = false
  let recordingRoute = ''
  let pending: { route: string; text: string } | undefined
  const route = () => location.pathname // includes project and session, including /session for new drafts
  const show = (text: string) => { notice.textContent = text; notice.style.display = text ? 'block' : 'none' }
  const reset = () => {
    button.innerHTML = icon
    button.title = 'Голосовой ввод в открытую сессию'
    button.setAttribute('aria-label', button.title)
    button.setAttribute('aria-pressed', 'false')
    button.disabled = false
    button.style.color = 'inherit'
  }
  const insert = () => {
    if (!pending || pending.route !== route()) return
    const editor = document.querySelector<HTMLElement>(selector)
    if (!editor || !editor.getClientRects().length) return
    editor.focus()
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    selection?.removeAllRanges()
    selection?.addRange(range)
    // Native editing fires the input handler and preserves existing mentions/attachments.
    if (!document.execCommand('insertText', false, (editor.textContent ? ' ' : '') + pending.text)) {
      show('Не удалось вставить текст. Скопируйте его:\n' + pending.text)
      return
    }
    pending = undefined
    show('')
  }
  button.onclick = async () => {
    if (recorder?.state === 'recording') { recorder.stop(); return }
    if (busy) return
    if (pending) { insert(); if (pending) show('Вернитесь в исходную сессию. Распознанный текст:\n' + pending.text); return }
    busy = true
    button.disabled = true
    recordingRoute = route()
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('Браузер не поддерживает запись. Откройте страницу через localhost в Chrome или Edge.')
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const chunks: Blob[] = []
      recorder = new MediaRecorder(stream)
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data) }
      recorder.onerror = () => { show('Ошибка записи микрофона'); cleanup() }
      recorder.onstop = async () => {
        clearTimeout(timer)
        stream?.getTracks().forEach(track => track.stop())
        button.disabled = true
        button.textContent = '…'
        show('Распознаю речь…')
        try {
          const context = new AudioContext()
          let decoded: AudioBuffer
          try { decoded = await context.decodeAudioData(await new Blob(chunks).arrayBuffer()) }
          finally { await context.close() }
          const offline = new OfflineAudioContext(1, Math.ceil(Math.min(decoded.duration, 120) * 16000), 16000)
          const source = offline.createBufferSource()
          source.buffer = decoded
          source.connect(offline.destination)
          source.start()
          const samples = (await offline.startRendering()).getChannelData(0)
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
            body: wav,
          })
          const result = await response.json()
          if (!response.ok) throw new Error(result.error || 'Ошибка распознавания')
          if (!result.text) { show('Речь не распознана. Попробуйте ещё раз.'); return }
          pending = { route: recordingRoute, text: result.text }
          show('Вернитесь в исходную сессию для вставки текста:\n' + result.text)
          insert()
        } catch (error) { show(error instanceof Error ? error.message : String(error)) }
        finally { cleanup() }
      }
      recorder.start()
      button.disabled = false
      button.textContent = '■'
      button.style.color = '#ef6666'
      button.title = 'Остановить запись'
      button.setAttribute('aria-label', button.title)
      button.setAttribute('aria-pressed', 'true')
      show('Запись… Нажмите ■ для остановки (максимум 120 секунд).')
      timer = setTimeout(() => { if (recorder?.state === 'recording') recorder.stop() }, 120_000)
    } catch (error) { show(error instanceof Error ? error.message : String(error)); cleanup() }
  }
  function cleanup() {
    clearTimeout(timer)
    stream?.getTracks().forEach(track => track.stop())
    stream = undefined
    recorder = undefined
    busy = false
    reset()
  }
  function mount() {
    const editor = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(el => el.getClientRects().length)
    const form = editor?.closest('form')
    const send = form?.querySelector('button[type="submit"]')
    if (send && !button.isConnected) send.parentElement?.insertBefore(button, send)
    if (send && button.closest('form') !== form) send.parentElement?.insertBefore(button, send)
  }
  reset()
  mount()
  new MutationObserver(mount).observe(document.body, { childList: true, subtree: true })
  window.addEventListener('pagehide', () => { stream?.getTracks().forEach(track => track.stop()) })
}
