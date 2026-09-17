import { runInNewContext } from 'node:vm'
import { voiceClientScript } from '../../src/voice-web.js'

/** Small DOM/media contract fixture; real editing semantics are checked separately in a browser. */
class Element {
  children: Element[] = []
  parentElement: Element | null = null
  attributes = new Map<string, string>()
  style: Record<string, string> = {}
  textContent = ''
  value = ''
  disabled = false
  hidden = false
  type = ''
  onclick?: () => unknown
  onchange?: () => unknown
  oninput?: () => unknown
  constructor(public tag: string) {}
  get isConnected(): boolean {
    return this.tag === 'body' || !!this.parentElement?.isConnected
  }
  get nextElementSibling(): Element | null {
    const peers = this.parentElement?.children ?? []
    return peers[peers.indexOf(this) + 1] ?? null
  }
  getClientRects() {
    return this.isConnected ? [1] : []
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value)
  }
  getAttribute(key: string) {
    return this.attributes.get(key) ?? null
  }
  hasAttribute(key: string) {
    return this.attributes.has(key)
  }
  append(...children: Element[]) {
    for (const child of children) {
      child.remove()
      child.parentElement = this
      this.children.push(child)
    }
  }
  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter(
        (child) => child !== this
      )
      this.parentElement = null
    }
  }
  replaceChildren(...children: Element[]) {
    for (const child of [...this.children]) child.remove()
    this.append(...children)
  }
  insertBefore(child: Element, anchor: Element) {
    child.remove()
    child.parentElement = this
    this.children.splice(this.children.indexOf(anchor), 0, child)
  }
  closest(tag: string): Element | null {
    return this.tag === tag ? this : (this.parentElement?.closest(tag) ?? null)
  }
  querySelector(selector: string): Element | null {
    for (const child of this.children) {
      if (
        selector === 'button[data-action="prompt-submit"]' &&
        child.getAttribute('data-action') === 'prompt-submit'
      )
        return child
      if (
        selector === 'button[type="submit"]' &&
        child.tag === 'button' &&
        child.type === 'submit'
      )
        return child
      const nested = child.querySelector(selector)
      if (nested) return nested
    }
    return null
  }
  focus() {}
  click() {
    if (!this.disabled) return this.onclick?.()
  }
}

export function voiceBrowser(
  options: {
    preferences?: unknown
    remote?: boolean
    fallbackSend?: boolean
    pending?: unknown
  } = {}
) {
  const elements: Element[] = []
  const body = new Element('body')
  const root = new Element('html')
  const remoteRoot = new Element('main')
  body.append(remoteRoot)
  const location = {
    search: '',
    pathname: options.remote ? '/voice' : '/project-a/session/ses_one'
  }
  let observer = () => {}
  let submitted = 0
  let stopped = 0
  let constraints: unknown
  let focused: Element
  let frameHook = () => {}
  const inserted: { route: string; text: string }[] = []
  const requests: { url: string; init: any }[] = []
  const storage = new Map<string, string>()
  if (options.preferences)
    storage.set(
      'orchestra-voice-settings:v1',
      JSON.stringify(options.preferences)
    )
  if (options.pending)
    storage.set(
      options.remote
        ? 'orchestra-voice-remote-pending:v1'
        : 'orchestra-voice-pending:v1',
      JSON.stringify(options.pending)
    )
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key)
  }
  let form: Element, editor: Element, send: Element
  const replaceComposer = () => {
    form?.remove()
    form = new Element('form')
    body.append(form)
    editor = new Element('div')
    editor.textContent = 'Existing draft'
    editor.focus = () => {
      focused = editor
    }
    send = new Element('button')
    send.type = 'submit'
    if (!options.fallbackSend) send.setAttribute('data-action', 'prompt-submit')
    send.onclick = () => {
      submitted++
    }
    form.append(editor, send)
  }
  replaceComposer()
  let recording: Recorder
  class Recorder {
    state = 'inactive'
    ondataavailable: any
    onstop: any
    onerror: any
    constructor() {
      recording = this
    }
    start() {
      this.state = 'recording'
    }
    async stop() {
      this.state = 'inactive'
      this.ondataavailable?.({ data: new Blob(['audio']) })
      await this.onstop?.()
    }
  }
  let fetchHook: ((url: string, init: any) => Promise<any>) | undefined
  let microphoneError: Error | undefined
  const context = {
    document: {
      body,
      documentElement: root,
      createElement: (tag: string) => {
        const element = new Element(tag)
        elements.push(element)
        return element
      },
      getElementById: () => remoteRoot,
      querySelectorAll: () => (options.remote ? [] : [editor]),
      createRange: () => ({ selectNodeContents() {}, collapse() {} }),
      execCommand: (_command: string, _ui: boolean, text: string) => {
        inserted.push({ route: location.pathname, text })
        focused.textContent += text
        return true
      }
    },
    location,
    Blob,
    setTimeout,
    clearTimeout,
    AbortController,
    AbortSignal,
    Error,
    console: { debug() {} },
    requestAnimationFrame: (callback: () => void) => {
      frameHook()
      callback()
    },
    window: {
      addEventListener() {},
      getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
      localStorage,
      sessionStorage: localStorage
    },
    navigator: {
      mediaDevices: {
        getUserMedia: async (value: unknown) => {
          if (microphoneError) throw microphoneError
          constraints = value
          return {
            getTracks: () => [
              {
                stop() {
                  stopped++
                }
              }
            ]
          }
        },
        enumerateDevices: async () => []
      }
    },
    MediaRecorder: Recorder,
    AudioContext: class {
      async decodeAudioData() {
        return { duration: 1 }
      }
      async close() {}
    },
    OfflineAudioContext: class {
      destination = {}
      createBufferSource() {
        return { connect() {}, start() {} }
      }
      async startRendering() {
        return { getChannelData: () => new Float32Array(16000) }
      }
    },
    MutationObserver: class {
      constructor(callback: () => void) {
        observer = callback
      }
      observe() {}
    },
    fetch: async (url: string, init?: any) => {
      requests.push({ url, init })
      if (fetchHook) return fetchHook(url, init)
      return {
        ok: true,
        json: async () =>
          url === '/session'
            ? [{ id: 'ses_one', title: 'Session A' }]
            : { text: 'Привет' }
      }
    }
  }
  const inject = () => runInNewContext(voiceClientScript(), context)
  inject()
  const byLabel = (label: string) =>
    elements.find((el) => el.getAttribute('aria-label') === label)!
  const byText = (text: string) =>
    elements.find((el) => el.textContent === text)!
  const button = elements.find(
    (el) => el.getAttribute('data-action') === 'orchestra-voice'
  )!
  return {
    failMicrophone: (name?: string) => {
      microphoneError = name
        ? Object.assign(new Error(name), { name })
        : undefined
    },
    elements,
    inserted,
    requests,
    location,
    storage,
    button,
    byLabel,
    byText,
    inject,
    get submitted() {
      return submitted
    },
    get stopped() {
      return stopped
    },
    get constraints() {
      return constraints
    },
    get form() {
      return form
    },
    get editor() {
      return editor
    },
    get send() {
      return send
    },
    get recording() {
      return recording
    },
    observe: () => observer(),
    replaceComposer,
    onFrame: (fn: () => void) => {
      frameHook = fn
    },
    onFetch: (fn: (url: string, init: any) => Promise<any>) => {
      fetchHook = fn
    }
  }
}
