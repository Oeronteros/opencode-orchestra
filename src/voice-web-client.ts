import { createVoicePolicy, type VoicePreferences } from './voice-context.js'
import { createOpenCodeAdapter } from './voice-opencode-adapter.js'

/** Runs in the OpenCode page; dependencies are serialized by the proxy. */
export function voiceWebClient(
  policy = createVoicePolicy(),
  adapter = createOpenCodeAdapter()
) {
  const root = document.documentElement
  if (root.hasAttribute('data-orchestra-voice')) return
  root.setAttribute('data-orchestra-voice', '1')
  const remote = location.pathname === '/voice'
  const settingsKey = 'orchestra-voice-settings:v1'
  let preferences = policy.preferences(null)
  try {
    preferences = policy.preferences(
      JSON.parse(window.localStorage.getItem(settingsKey) ?? 'null')
    )
  } catch {
    /* Defaults. */
  }
  const icon =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>'
  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute('data-action', 'orchestra-voice')
  button.style.cssText =
    'display:inline-flex;align-items:center;justify-content:center;min-width:36px;height:36px;border-radius:8px;margin-right:6px;color:inherit;background:transparent;border:1px solid #8885;cursor:pointer'
  const notice = document.createElement('div')
  const noticeText = document.createElement('span')
  notice.append(noticeText)
  notice.setAttribute('role', 'status')
  notice.style.cssText =
    'position:fixed;bottom:110px;right:24px;max-width:min(400px,90vw);padding:12px;border-radius:8px;background:#252b35;color:white;z-index:9999;display:none;white-space:pre-wrap'
  document.body.append(notice)
  const panel = document.createElement('section')
  panel.setAttribute('aria-label', 'Распознанный текст')
  panel.style.cssText =
    'position:fixed;bottom:180px;right:24px;width:min(400px,90vw);padding:12px;border-radius:8px;background:#252b35;color:white;z-index:9999;display:none'
  const draft = document.createElement('textarea')
  draft.setAttribute('aria-label', 'Распознанный текст — можно исправить')
  draft.rows = 5
  draft.style.cssText =
    'width:100%;padding:8px;color:inherit;background:#161b22;border:1px solid #8885;border-radius:6px;resize:vertical'
  const actions = document.createElement('div')
  actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:8px'
  panel.append(draft, actions)
  document.body.append(panel)
  const action = (label: string, handler: () => void) => {
    const control = document.createElement('button')
    control.type = 'button'
    control.textContent = label
    control.onclick = handler
    control.style.cssText =
      'padding:6px;border:1px solid #8885;border-radius:6px;color:inherit;background:#343c49;cursor:pointer'
    actions.append(control)
    return control
  }
  type Job = {
    route: string
    preferences: VoicePreferences
    controller: AbortController
    recorder?: MediaRecorder
    stream?: MediaStream
    timer?: ReturnType<typeof setTimeout>
  }
  let active: Job | undefined
  let pending: { route: string; text: string } | undefined
  const storageKey = remote
    ? 'orchestra-voice-remote-pending:v1'
    : 'orchestra-voice-pending:v1'
  const route = () => (remote ? preferences.sessionId : adapter.route())
  const show = (text: string) => {
    noticeText.textContent = text
    notice.style.display = text ? 'block' : 'none'
  }
  const save = () => {
    try {
      if (pending)
        window.sessionStorage.setItem(storageKey, JSON.stringify(pending))
      else window.sessionStorage.removeItem(storageKey)
    } catch {
      /* The visible draft remains available when storage is disabled. */
    }
  }
  const renderDraft = () => {
    draft.value = pending?.text ?? ''
    draft.hidden = !pending
    panel.style.display = pending ? 'block' : 'none'
    insertButton.hidden = copyButton.hidden = discardButton.hidden = !pending
    cancelButton.hidden = !active
  }
  const reset = () => {
    button.innerHTML = icon
    button.title = pending
      ? 'Показать распознанный текст'
      : 'Голосовой ввод в открытую сессию'
    button.setAttribute('aria-label', button.title)
    button.setAttribute('aria-pressed', 'false')
    button.disabled = false
    button.style.color = 'inherit'
  }
  const insert = async (submit = false) => {
    if (!pending) return
    if (pending.route !== route()) {
      show('Вернитесь в исходную сессию для вставки или скопируйте текст.')
      return
    }
    if (remote) {
      renderDraft()
      show('Проверьте текст и нажмите «Отправить в сессию».')
      return
    }
    const savedRoute = pending.route
    try {
      const input = adapter.insert(pending.text, savedRoute)
      pending = undefined
      save()
      renderDraft()
      reset()
      show('')
      console.debug('voice transcription inserted', { source: 'web' })
      if (submit)
        await adapter.submit(input, savedRoute, active?.controller.signal)
    } catch (error) {
      show(error instanceof Error ? error.message : String(error))
    }
  }
  const insertButton = action(
    remote ? 'Отправить в сессию' : 'Вставить в исходную сессию',
    () => {
      void (remote ? sendRemote() : insert())
    }
  )
  const copyButton = action('Копировать', () => {
    if (!pending) return
    if (!navigator.clipboard) {
      show('Выделите и скопируйте текст вручную.')
      return
    }
    void navigator.clipboard
      .writeText(pending.text)
      .then(() => show('Текст скопирован.'))
      .catch(() => show('Выделите и скопируйте текст вручную.'))
  })
  const discardButton = action('Удалить', () => {
    pending = undefined
    save()
    renderDraft()
    reset()
    show('')
  })
  const cancelButton = action('Отменить', () => {
    if (active) {
      active.controller.abort()
      cleanup(active)
      show('Запись или распознавание отменено.')
    }
  })
  // Cancellation remains available without opening the recovery panel.
  notice.append(cancelButton)
  let sending = false
  async function sendRemote() {
    if (!pending || !pending.text.trim() || sending || active) return
    const destination = policy.resolve('auto', {
      source: 'remote',
      sessionId: pending.route
    })
    if (destination.type !== 'session') {
      show('Выберите сессию.')
      return
    }
    if (pending.route !== route()) {
      show('Вернитесь к сессии, выбранной при записи, или скопируйте текст.')
      return
    }
    const snapshot = pending
    sending = true
    insertButton.disabled = true
    button.disabled = true
    sessionPicker.disabled = true
    draft.disabled = true
    discardButton.disabled = true
    try {
      const response = await fetch(
        `/session/${encodeURIComponent(destination.sessionId)}/prompt_async`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orchestra-Voice': '1'
          },
          body: JSON.stringify({
            parts: [{ type: 'text', text: snapshot.text }]
          }),
          signal: AbortSignal.timeout(30_000)
        }
      )
      if (!response.ok)
        throw new Error(
          response.status === 404
            ? 'Сессия удалена. Скопируйте текст и выберите другую.'
            : `Не удалось отправить текст (HTTP ${response.status}).`
        )
      if (pending === snapshot) {
        pending = undefined
        save()
        renderDraft()
      }
      show('Отправлено в выбранную сессию.')
    } catch (error) {
      show(
        `${error instanceof Error ? error.message : String(error)} Текст сохранён; перед повтором проверьте сессию.`
      )
    } finally {
      sending = false
      insertButton.disabled = false
      sessionPicker.disabled = false
      draft.disabled = false
      discardButton.disabled = false
      reset()
    }
  }
  const settingsButton = document.createElement('button')
  settingsButton.type = 'button'
  settingsButton.textContent = '⚙'
  settingsButton.title = 'Настройки голоса'
  settingsButton.setAttribute('aria-label', 'Настройки голоса')
  const settingsPanel = document.createElement('section')
  settingsPanel.setAttribute('aria-label', 'Голос')
  settingsPanel.style.cssText = `${panel.style.cssText};color-scheme:dark`
  const createSelectOption = (value: string, text: string) => {
    const option = document.createElement('option')
    option.value = value
    option.textContent = text
    option.style.cssText = 'color:#f8fafc;background:#161b22'
    return option
  }
  const addSelect = (
    title: string,
    choices: [string, string][],
    value: string
  ) => {
    const label = document.createElement('label')
    label.textContent = title
    label.style.cssText = 'display:grid;gap:6px;margin:12px 0'
    const select = document.createElement('select')
    select.style.cssText =
      'width:100%;padding:8px;color:#f8fafc;background:#161b22;border:1px solid #8885;border-radius:6px;color-scheme:dark'
    for (const [id, text] of choices) {
      select.append(createSelectOption(id, text))
    }
    select.value = value
    label.append(select)
    settingsPanel.append(label)
    return select
  }
  const devicePicker = addSelect(
    'Микрофон',
    [['', 'Системный по умолчанию']],
    ''
  )
  const modelPicker = addSelect(
    'Модель',
    [
      ['base', 'base — быстрая (~140 МБ)'],
      ['small', 'small — точнее (~460 МБ)']
    ],
    preferences.model
  )
  const behaviorPicker = addSelect(
    'После распознавания',
    [
      ['insert', 'Вставить текст'],
      ['insert-and-submit', 'Вставить и отправить']
    ],
    preferences.postTranscriptionAction
  )
  const sessionPicker = addSelect(
    'Сессия',
    [['', 'Выберите сессию']],
    preferences.sessionId
  )
  sessionPicker.parentElement!.hidden = !remote
  sessionPicker.parentElement!.style.display = remote ? 'grid' : 'none'
  const saveSettings = document.createElement('button')
  saveSettings.type = 'button'
  saveSettings.textContent = 'Сохранить'
  const persist = () => {
    try {
      window.localStorage.setItem(settingsKey, JSON.stringify(preferences))
      return true
    } catch {
      show('Не удалось сохранить настройки в браузере.')
      return false
    }
  }
  saveSettings.onclick = () => {
    preferences = policy.preferences({
      ...preferences,
      model: modelPicker.value,
      device: devicePicker.value,
      postTranscriptionAction: behaviorPicker.value
    })
    if (persist()) settingsPanel.style.display = 'none'
  }
  settingsPanel.append(saveSettings)
  document.body.append(settingsPanel)
  const refreshDevices = async () => {
    try {
      const devices = await navigator.mediaDevices?.enumerateDevices()
      devicePicker.replaceChildren()
      for (const device of [
        { deviceId: '', label: 'Системный по умолчанию' },
        ...(devices ?? []).filter(
          (d) => d.kind === 'audioinput' && d.deviceId !== 'default'
        )
      ]) {
        devicePicker.append(
          createSelectOption(
            device.deviceId,
            device.label || 'Микрофон (разрешите доступ для названия)'
          )
        )
      }
      devicePicker.value = preferences.device
    } catch {
      show(
        'Не удалось получить список микрофонов. Проверьте разрешение браузера.'
      )
    }
  }
  settingsButton.onclick = () => {
    settingsPanel.style.display =
      settingsPanel.style.display === 'none' ? 'block' : 'none'
    void refreshDevices()
  }
  async function refreshSessions() {
    if (active || sending) return
    try {
      const response = await fetch('/session', {
        signal: AbortSignal.timeout(15_000)
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const sessions: unknown = await response.json()
      if (!Array.isArray(sessions))
        throw new Error('Некорректный список сессий')
      if (active || sending) return
      sessionPicker.replaceChildren()
      sessionPicker.append(createSelectOption('', 'Выберите сессию'))
      for (const item of sessions) {
        if (!item || typeof item.id !== 'string') continue
        sessionPicker.append(
          createSelectOption(
            item.id,
            typeof item.title === 'string' ? item.title : item.id
          )
        )
      }
      sessionPicker.value = preferences.sessionId
      preferences.sessionId = sessionPicker.value
    } catch {
      show(
        'Список сессий недоступен. Проверьте подключение и повторите обновление.'
      )
    }
  }
  sessionPicker.onchange = () => {
    preferences.sessionId = sessionPicker.value
    persist()
  }
  if (remote) {
    const container = document.getElementById('orchestra-remote')!
    container.append(sessionPicker.parentElement!, button, settingsButton)
    const refresh = document.createElement('button')
    refresh.type = 'button'
    refresh.textContent = 'Обновить сессии'
    refresh.onclick = () => {
      void refreshSessions()
    }
    container.append(refresh)
    void refreshSessions()
  }
  draft.oninput = () => {
    if (pending) {
      pending.text = draft.value
      save()
    }
  }
  function cleanup(job: Job) {
    clearTimeout(job.timer)
    if (job.recorder) {
      job.recorder.onstop = null
      job.recorder.onerror = null
      job.recorder.ondataavailable = null
    }
    if (job.recorder?.state === 'recording') job.recorder.stop()
    job.stream?.getTracks().forEach((track) => track.stop())
    if (active !== job) return
    active = undefined
    settingsButton.disabled = false
    sessionPicker.disabled = false
    reset()
    renderDraft()
  }
  button.onclick = async () => {
    if (sending) return
    if (active?.recorder?.state === 'recording') {
      button.disabled = true
      active.recorder.stop()
      return
    }
    if (active) return
    if (pending) {
      renderDraft()
      await insert()
      return
    }
    const destination = policy.resolve(
      remote ? 'auto' : preferences.target,
      remote
        ? { source: 'remote', sessionId: route() }
        : { source: 'web', route: route() }
    )
    if (destination.type === 'picker') {
      show('Выберите сессию для записи.')
      return
    }
    if (!remote && !adapter.editor()) {
      show('Поле ввода OpenCode не найдено. Откройте сессию или /voice.')
      return
    }
    const job: Job = {
      route: route(),
      preferences: { ...preferences },
      controller: new AbortController()
    }
    active = job
    button.disabled = true
    settingsButton.disabled = true
    sessionPicker.disabled = true
    settingsPanel.style.display = 'none'
    renderDraft()
    try {
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === 'undefined'
      )
        throw new Error(
          'Браузер не поддерживает запись. Откройте страницу через localhost в Chrome или Edge.'
        )
      show('Разрешите доступ к микрофону…')
      job.stream = await navigator.mediaDevices.getUserMedia({
        audio: job.preferences.device
          ? { deviceId: { exact: job.preferences.device } }
          : true
      })
      if (active !== job) {
        cleanup(job)
        return
      }
      const chunks: Blob[] = []
      const recorder = (job.recorder = new MediaRecorder(job.stream))
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data)
      }
      recorder.onerror = () => {
        if (active === job) show('Ошибка записи микрофона. Попробуйте ещё раз.')
        cleanup(job)
      }
      recorder.onstop = async () => {
        if (active !== job) return
        clearTimeout(job.timer)
        job.stream?.getTracks().forEach((track) => track.stop())
        button.disabled = true
        button.textContent = '…'
        show('Распознаю речь…')
        job.timer = setTimeout(() => job.controller.abort(), 610_000)
        try {
          const context = new AudioContext()
          let decoded: AudioBuffer
          try {
            decoded = await context.decodeAudioData(
              await new Blob(chunks).arrayBuffer()
            )
          } finally {
            await context.close()
          }
          if (active !== job) return
          if (decoded.duration < 0.5)
            throw new Error('Запись короче полсекунды. Попробуйте ещё раз.')
          const offline = new OfflineAudioContext(
            1,
            Math.ceil(Math.min(decoded.duration, 120) * 16000),
            16000
          )
          const source = offline.createBufferSource()
          source.buffer = decoded
          source.connect(offline.destination)
          source.start()
          const samples = (await offline.startRendering()).getChannelData(0)
          if (active !== job) return
          const wav = new ArrayBuffer(44 + samples.length * 2)
          const view = new DataView(wav)
          const label = (offset: number, value: string) => {
            for (let i = 0; i < value.length; i++)
              view.setUint8(offset + i, value.charCodeAt(i))
          }
          label(0, 'RIFF')
          view.setUint32(4, wav.byteLength - 8, true)
          label(8, 'WAVE')
          label(12, 'fmt ')
          view.setUint32(16, 16, true)
          view.setUint16(20, 1, true)
          view.setUint16(22, 1, true)
          view.setUint32(24, 16000, true)
          view.setUint32(28, 32000, true)
          view.setUint16(32, 2, true)
          view.setUint16(34, 16, true)
          label(36, 'data')
          view.setUint32(40, samples.length * 2, true)
          samples.forEach((sample, i) =>
            view.setInt16(
              44 + i * 2,
              Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767),
              true
            )
          )
          const response = await fetch('/__orchestra_voice/transcribe', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-Orchestra-Voice': '1',
              'X-Orchestra-Model': job.preferences.model
            },
            body: wav,
            signal: job.controller.signal
          })
          const result = await response.json()
          if (active !== job) return
          if (!response.ok)
            throw new Error(result.error || 'Ошибка распознавания')
          if (typeof result.text !== 'string' || !result.text.trim()) {
            show('Речь не распознана. Попробуйте ещё раз.')
            return
          }
          pending = { route: job.route, text: result.text.trim() }
          save()
          renderDraft()
          console.debug('voice transcription completed', {
            source: remote ? 'remote' : 'web',
            chars: pending.text.length
          })
          await insert(
            job.preferences.postTranscriptionAction === 'insert-and-submit'
          )
        } catch (error) {
          if (active === job)
            show(
              job.controller.signal.aborted
                ? 'Превышено время ожидания распознавания. Попробуйте ещё раз.'
                : error instanceof Error
                  ? error.message
                  : String(error)
            )
        } finally {
          cleanup(job)
          if (
            !job.controller.signal.aborted &&
            remote &&
            pending?.route === job.route &&
            route() === job.route &&
            job.preferences.postTranscriptionAction === 'insert-and-submit'
          )
            await sendRemote()
        }
      }
      recorder.start()
      console.debug('voice recording started', {
        source: remote ? 'remote' : 'web'
      })
      button.disabled = false
      button.textContent = '■'
      button.style.color = '#ef6666'
      button.title = 'Остановить запись'
      button.setAttribute('aria-label', button.title)
      button.setAttribute('aria-pressed', 'true')
      show('Запись… Нажмите ■ для остановки (максимум 120 секунд).')
      job.timer = setTimeout(() => {
        if (active === job && recorder.state === 'recording') {
          button.disabled = true
          recorder.stop()
        }
      }, 120_000)
    } catch (error) {
      if (active === job)
        show(
          error instanceof Error && error.name === 'NotAllowedError'
            ? 'Разрешите доступ к микрофону в настройках браузера.'
            : error instanceof Error &&
                ['NotFoundError', 'OverconstrainedError'].includes(error.name)
              ? 'Микрофон не найден. Выберите доступное устройство в настройках голоса.'
              : error instanceof Error
                ? error.message
                : String(error)
        )
      cleanup(job)
    }
  }
  function mount() {
    if (!remote) adapter.mount(button, settingsButton)
  }
  try {
    const saved = JSON.parse(
      window.sessionStorage.getItem(storageKey) ?? 'null'
    )
    if (
      typeof saved?.route === 'string' &&
      (remote || saved.route.startsWith('/')) &&
      typeof saved.text === 'string'
    )
      pending = { route: saved.route, text: saved.text }
  } catch {
    /* No saved draft. */
  }
  reset()
  renderDraft()
  mount()
  new MutationObserver(mount).observe(document.body, {
    childList: true,
    subtree: true
  })
  window.addEventListener('pagehide', () => {
    if (active) {
      active.controller.abort()
      cleanup(active)
    }
  })
}
