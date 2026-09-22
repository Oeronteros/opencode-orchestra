export type DestinationMode = 'auto' | 'tui' | 'web'
export type PostTranscriptionAction = 'insert' | 'insert-and-submit'
export type VoiceInvocationContext =
  | { source: 'web'; route: string }
  | { source: 'tui' }
  | { source: 'remote'; sessionId: string }
  | { source: 'unknown' }
export type VoiceDestination =
  | { type: 'composer'; route: string }
  | { type: 'tui' }
  | { type: 'session'; sessionId: string }
  | { type: 'picker' }

export interface VoicePreferences {
  target: DestinationMode
  postTranscriptionAction: PostTranscriptionAction
  model: 'base' | 'small'
  device: string
  sessionId: string
}

/** Pure policy, also serialized for the injected client. Keep free of runtime imports. */
export function createVoicePolicy() {
  function preferences(value: unknown): VoicePreferences {
    const raw =
      value && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : {}
    const target = raw.target ?? raw.destination
    return {
      target: target === 'tui' || target === 'web' ? target : 'auto',
      postTranscriptionAction:
        raw.postTranscriptionAction === 'insert-and-submit'
          ? 'insert-and-submit'
          : 'insert',
      model: raw.model === 'small' ? 'small' : 'base',
      device: typeof raw.device === 'string' ? raw.device : '',
      sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : ''
    }
  }
  function resolve(
    mode: DestinationMode,
    context: VoiceInvocationContext,
    sessionId = ''
  ): VoiceDestination {
    // An embedded invocation always owns its composer, regardless of saved manual settings.
    if (context.source === 'web')
      return context.route
        ? { type: 'composer', route: context.route }
        : { type: 'picker' }
    if (mode === 'tui') return { type: 'tui' }
    if (mode === 'auto' && context.source === 'tui') return { type: 'tui' }
    if (mode === 'auto' && context.source === 'unknown')
      return { type: 'picker' }
    const selected = context.source === 'remote' ? context.sessionId : sessionId
    return selected
      ? { type: 'session', sessionId: selected }
      : { type: 'picker' }
  }
  return { preferences, resolve }
}

export function normalizeOverlaySettings(value: unknown) {
  const raw =
    value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    ...createVoicePolicy().preferences(raw),
    host: typeof raw.host === 'string' && raw.host ? raw.host : '127.0.0.1',
    port:
      typeof raw.port === 'number' &&
      Number.isInteger(raw.port) &&
      raw.port > 0 &&
      raw.port <= 65535
        ? raw.port
        : 4096,
    browserPort:
      typeof raw.browserPort === 'number' && Number.isInteger(raw.browserPort) &&
      raw.browserPort > 0 && raw.browserPort <= 65535 ? raw.browserPort : 4097,
    username: typeof raw.username === 'string' ? raw.username : '',
    password: typeof raw.password === 'string' ? raw.password : ''
  }
}
