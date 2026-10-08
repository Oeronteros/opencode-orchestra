import type { Hooks as LegacyHooks, Plugin as LegacyPlugin, PluginInput } from "@opencode-ai/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { z } from "zod"
import { registerBrowserHost } from "./browser/v2.js"
import type { RuntimeAgentConfig } from "./agents/types.js"
import { abortableDelay } from "./routing/retry.js"

type LegacyClient = PluginInput["client"]
type LegacyAssistant = { id: string; type: "assistant"; agent: string; model: { providerID: string; id: string }; content: Array<{ type: string; text?: string; id?: string; name?: string; state?: { status: string; error?: unknown } }>; time: { created: number; completed?: number }; finish?: string; cost?: number; tokens?: { input: number; output: number; reasoning: number; cache?: { read: number; write: number } }; error?: unknown }

function legacyMessage(message: LegacyAssistant, sessionID: string, parentID?: string) {
  return {
    info: {
      id: message.id,
      sessionID,
      parentID,
      role: "assistant" as const,
      agent: message.agent,
      modelID: message.model.id,
      providerID: message.model.providerID,
      time: message.time,
      finish: message.finish,
      cost: message.cost ?? 0,
      tokens: message.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      error: message.error,
    },
    parts: message.content.map((part) => part.type === "text" || part.type === "reasoning"
      ? { type: part.type, text: part.text ?? "" }
      : { type: "tool", callID: part.id, tool: part.name, state: part.state }),
  }
}

/** The V1 orchestration engine uses SDK response envelopes. Keep that contract at this boundary. */
function legacyClient(ctx: Context, trackSession: (id: string) => void): LegacyClient {
  const session = ctx.session as Context["session"] & { interrupt?: (input: { sessionID: string; resume?: boolean }) => Promise<unknown> }
  const select = async (id: string, body: { agent?: string; model?: { providerID: string; modelID: string } }) => {
    if (body.agent) await ctx.session.switchAgent({ sessionID: id, agent: body.agent })
    if (body.model) await ctx.session.switchModel({ sessionID: id, model: { providerID: body.model.providerID, id: body.model.modelID } })
  }
  const prompt = async (input: { path: { id: string }; body: { agent?: string; model?: { providerID: string; modelID: string }; parts: Array<{ type: string; text?: string }> }; signal?: AbortSignal }, wait: boolean) => {
    const id = input.path.id
    trackSession(id)
    const previous = wait ? new Set((await ctx.session.context({ sessionID: id })).map((item) => item.id)) : undefined
    await select(id, input.body)
    const text = input.body.parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n")
    await ctx.session.prompt({ sessionID: id, text }, input.signal ? { signal: input.signal } : undefined)
    if (!wait) return { data: undefined }
    await ctx.session.wait({ sessionID: id }, input.signal ? { signal: input.signal } : undefined)
    const messages = await ctx.session.context({ sessionID: id }, input.signal ? { signal: input.signal } : undefined)
    const answer = [...messages].reverse().find((item) => item.type === "assistant" && !previous?.has(item.id)) as LegacyAssistant | undefined
    if (!answer) throw new Error("OpenCode V2 completed without an assistant response")
    const user = [...messages].reverse().find((item) => item.type === "user")
    return { data: legacyMessage(answer, id, user?.id) }
  }
  const facade = {
    mcp: { status: async () => {
      const servers = await ctx.mcp.list()
      return { data: Object.fromEntries(servers.data.map((server) => [server.name, server.status])) }
    } },
    app: { log: async ({ body }: { body: { level: string; message: string; extra?: unknown } }) => {
      const line = `[opencode-orchestra] ${body.message}`
      if (body.level === "warn" || body.level === "error") console.warn(line, body.extra ?? "")
      else console.info(line, body.extra ?? "")
      return { data: undefined }
    } },
    provider: { list: async () => {
      const result = await ctx.model.list()
      const all = new Map<string, { id: string; models: Record<string, unknown> }>()
      for (const model of result.data) {
        if (!model.enabled) continue
        const provider = all.get(model.providerID) ?? { id: model.providerID, models: {} }
        provider.models[model.id] = {
          id: model.id,
          reasoning: Boolean(model.compatibility?.reasoningField || model.compatibility?.requireReasoning)
            || model.variants.some((variant) => variant.id.includes("thinking") || variant.id.includes("reasoning")),
          tool_call: model.capabilities.tools,
          attachment: model.capabilities.input.includes("image"),
          status: model.status,
          ...(model.cost[0] ? { cost: { input: model.cost[0].input, output: model.cost[0].output } } : {}),
          limit: model.limit,
          modalities: { input: model.capabilities.input, output: model.capabilities.output },
        }
        all.set(model.providerID, provider)
      }
      return { data: { all: [...all.values()], connected: [...all.keys()] } }
    } },
    session: {
      create: async ({ body, query }: { body: { parentID?: string; title?: string }; query?: { directory?: string } }) => {
        const created = await ctx.session.create({
          title: body.title,
          location: { directory: query?.directory ?? ctx.location.directory },
          ...(body.parentID ? { metadata: { orchestraParentID: body.parentID } } : {}),
        })
        trackSession(created.id)
        return { data: created }
      },
      abort: async ({ path }: { path: { id: string } }) => {
        if (!session.interrupt) throw new Error("OpenCode V2 session interrupt is unavailable")
        await session.interrupt({ sessionID: path.id, resume: false })
        return { data: undefined }
      },
      prompt: (input: Parameters<typeof prompt>[0]) => prompt(input, true),
      promptAsync: (input: Parameters<typeof prompt>[0]) => prompt(input, false),
      message: async ({ path }: { path: { id: string; messageID: string } }) => {
        const messages = await ctx.session.context({ sessionID: path.id })
        const target = messages.find((item) => item.id === path.messageID)
        if (!target || target.type !== "assistant") throw new Error("Assistant message not found")
        const user = messages.slice(0, messages.indexOf(target)).findLast((item) => item.type === "user")
        return { data: legacyMessage(target as LegacyAssistant, path.id, user?.id) }
      },
    },
  }
  return facade as unknown as LegacyClient
}

function permissions(config: RuntimeAgentConfig): Array<{ action: string; resource: string; effect: "allow" | "ask" | "deny" }> {
  const rules: Array<{ action: string; resource: string; effect: "allow" | "ask" | "deny" }> = []
  for (const [action, policy] of Object.entries(config.permission)) {
    const translated = action === "bash" ? "shell" : action === "task" ? "subagent" : action === "write" || action === "patch" ? "edit" : action
    if (typeof policy === "string") rules.push({ action: translated, resource: "*", effect: policy })
    else for (const [resource, effect] of Object.entries(policy)) rules.push({ action: translated, resource, effect })
  }
  return rules
}

export async function setupV2(ctx: Context, initialize: LegacyPlugin, retry: { baseDelayMs?: number; maxDelayMs?: number } = {}): Promise<() => Promise<void>> {
  const sessions = new Set<string>()
  const client = legacyClient(ctx, (id) => sessions.add(id))
  const browser = registerBrowserHost(client, ctx)
  const hooks: LegacyHooks = await initialize({ client, directory: ctx.location.directory } as unknown as PluginInput, ctx.options)
  const config: { agent?: Record<string, RuntimeAgentConfig>; command?: Record<string, { template: string; description?: string; agent?: string }> } = {}
  await hooks.config?.(config as Parameters<NonNullable<LegacyHooks["config"]>>[0])

  await ctx.agent.transform((editor) => {
    for (const [id, agent] of Object.entries(config.agent ?? {})) {
      if (!editor.get(id)) continue // V2's agent editor can update existing agents but cannot add them.
      editor.update(id, (draft) => {
        draft.description ??= agent.description
        draft.system ??= agent.prompt
        draft.mode = agent.mode
        draft.hidden = agent.hidden ?? false
        if (agent.color && !draft.color) draft.color = agent.color
        if (agent.temperature !== undefined && draft.request.body.temperature === undefined) draft.request.body.temperature = agent.temperature
        if (agent.model && !draft.model) {
          const slash = agent.model.indexOf("/")
          if (slash > 0) draft.model = { providerID: agent.model.slice(0, slash), id: agent.model.slice(slash + 1) } as unknown as NonNullable<typeof draft.model>
        }
        // V2 uses the last matching rule. Keep configured user rules after plugin defaults.
        draft.permissions.unshift(...permissions(agent))
      })
    }
  })

  await ctx.command.transform((editor) => {
    for (const [name, command] of Object.entries(config.command ?? {})) editor.add({
      name,
      ...(command.description ? { description: command.description } : {}),
      execute: async ({ sessionID, prompt, delivery }) => {
        const parts = [{ type: "text" as const, text: command.template.replaceAll("$ARGUMENTS", prompt.text) }]
        await hooks["command.execute.before"]?.({ command: name, sessionID, arguments: prompt.text }, { parts: parts as never })
        if (command.agent) await ctx.session.switchAgent({ sessionID, agent: command.agent })
        await ctx.session.prompt({ ...prompt, sessionID, text: parts[0]!.text, delivery } as Parameters<typeof ctx.session.prompt>[0])
      },
    })
  })

  await ctx.tool.transform((editor) => {
    for (const [name, tool] of Object.entries(hooks.tool ?? {})) editor.add({
      name,
      description: tool.description,
      input: z.object(tool.args),
      execute: async (input, context) => {
        const current = await ctx.session.get({ sessionID: context.sessionID })
        const directory = current.location.directory
        const result = await tool.execute(input as never, {
          sessionID: context.sessionID,
          messageID: context.messageID,
          agent: context.agent,
          directory,
          worktree: directory,
          abort: context.signal,
          metadata: () => undefined,
          ask: async () => { throw new Error("Tool permission requests are unavailable through the V2 adapter") },
        })
        return typeof result === "string"
          ? { content: result }
          : { content: result.output, ...(result.metadata ? { metadata: result.metadata } : {}) }
      },
    })
  })

  await ctx.permission.hook("evaluate", async (event) => {
    if (event.effect !== "ask") return
    const output = { status: event.effect }
    await hooks["permission.ask"]?.({ sessionID: event.sessionID } as never, output)
    event.effect = output.status
  })
  await ctx.session.hook("prompt", async (event) => {
    sessions.add(event.sessionID)
    const output = { message: { id: event.messageID }, parts: [{ type: "text", text: event.prompt.text }] }
    await hooks["chat.message"]?.({ sessionID: event.sessionID }, output as never)
  })
  await ctx.session.hook("context", async (event) => {
    sessions.add(event.sessionID)
    await hooks["chat.params"]?.({ sessionID: event.sessionID, agent: event.agent, model: { providerID: event.model.providerID, id: event.model.id } } as never, {} as never)
    if (event.agent === "orch-lead") {
      const history = await ctx.session.context({ sessionID: event.sessionID })
      if (history.some((message) => message.type === "assistant" && message.agent === "plan")) {
        const { PLAN_TRANSITION_REMINDER } = await import("./routing/plan-reminder.js")
        event.system.push({ type: "text", text: PLAN_TRANSITION_REMINDER })
      }
    }
    if (hooks["experimental.chat.system.transform"]) {
      const output = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]({ model: { providerID: event.model.providerID, id: event.model.id } } as never, output)
      for (const line of output.system) event.system.push({ type: "text", text: line })
    }
  })
  await ctx.tool.hook("execute.before", (event) => hooks["tool.execute.before"]?.(
    { tool: event.tool === "shell" ? "bash" : event.tool, sessionID: event.sessionID, callID: event.id }, { args: event.input },
  ))
  await ctx.tool.hook("execute.after", async (event) => {
    if (event.status === "completed") {
      const content = event.result.content
      const output = typeof content === "string" ? content : content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? ""
      await hooks["tool.execute.after"]?.({ tool: event.tool === "shell" ? "bash" : event.tool, sessionID: event.sessionID, callID: event.id, args: event.input }, { title: event.tool, output, metadata: event.result.metadata })
    } else await hooks.event?.({ event: { type: "message.part.updated", properties: { part: { type: "tool", id: event.id, callID: event.id, sessionID: event.sessionID, messageID: event.messageID, state: { status: "error", time: {} } } } } as never })
  })

  const controller = new AbortController()
  await browser.install()
  // Keep only finalized IDs, not response text. A timestamp watermark would
  // lose a response that completes out of order or after a clock adjustment.
  // IDs live for the session lifetime and are released on session.deleted.
  const completed = new Map<string, Set<string>>()
  const synchronize = async (sessionID: string): Promise<"idle" | "error" | undefined> => {
    const messages = await ctx.session.context({ sessionID }, { signal: controller.signal })
    for (let i = 0; i < messages.length; i++) {
      controller.signal.throwIfAborted()
      const message = messages[i]
      if (!message || message.type !== "assistant") continue
      const answer = message as LegacyAssistant
      if (answer.time.completed === undefined && answer.finish === undefined && answer.error === undefined) continue
      const seen = completed.get(sessionID) ?? new Set<string>()
      if (seen.has(answer.id)) continue
      const user = messages.slice(0, i).findLast((item) => item.type === "user")
      await hooks.event?.({ event: { type: "message.updated", properties: legacyMessage(answer, sessionID, user?.id) } as never })
      seen.add(answer.id)
      completed.set(sessionID, seen)
    }
    // V2 records an idle marker in context. A completed assistant alone may
    // still be an intermediate tool step, so it cannot imply session.idle.
    const last = messages.at(-1)
    return last?.type === "idle" ? (last.outcome === "succeeded" ? "idle" : "error") : undefined
  }
  const reconcile = async () => {
    for (const sessionID of sessions) {
      try {
        const terminal = await synchronize(sessionID)
        if (terminal) await hooks.event?.({ event: { type: terminal === "idle" ? "session.idle" : "session.error", properties: { sessionID } } as never })
      } catch (error) {
        if (!controller.signal.aborted) console.warn("[opencode-orchestra] V2 session reconciliation failed", error)
      }
    }
  }
  type StreamEvent = ReturnType<Context["event"]["subscribe"]> extends AsyncIterable<infer E> ? E : never
  let connected = false
  const processEvent = async (event: StreamEvent) => {
    if (event.type === "server.connected") {
      if (connected) await reconcile()
      connected = true
    } else if (event.type === "session.reasoning.delta") {
      sessions.add(event.data.sessionID)
      const partID = `${event.data.assistantMessageID}:reasoning:${event.data.ordinal}`
      await hooks.event?.({ event: { type: "message.part.updated", properties: { part: { type: "reasoning", id: partID, messageID: event.data.assistantMessageID, sessionID: event.data.sessionID }, delta: event.data.delta } } as never })
    } else if (event.type === "session.text.delta") {
      sessions.add(event.data.sessionID)
      await hooks.event?.({ event: { type: "message.part.delta", properties: { sessionID: event.data.sessionID, messageID: event.data.assistantMessageID, partID: `${event.data.assistantMessageID}:${event.data.ordinal}`, field: "text", delta: event.data.delta } } as never })
    } else if (event.type === "session.idle" || event.type === "session.execution.failed" || event.type === "session.execution.interrupted") {
      const sessionID = event.data.sessionID
      sessions.add(sessionID)
      await synchronize(sessionID)
      await hooks.event?.({ event: { type: event.type === "session.idle" ? "session.idle" : "session.error", properties: { sessionID } } as never })
    } else if (event.type === "session.deleted") {
      sessions.delete(event.data.sessionID)
      completed.delete(event.data.sessionID)
    }
  }
  const stream = (async () => {
    let failures = 0
    let reconnect = false
    while (!controller.signal.aborted) {
      try {
        const subscription = ctx.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]()
        try {
          // Start the subscription before reading history, so events arriving
          // during reconciliation remain queued by the SDK.
          let pending = subscription.next()
          void pending.catch(() => undefined)
          if (reconnect) await reconcile()
          while (!controller.signal.aborted) {
            const item = await pending
            if (item.done) break
            const event = item.value
            failures = 0
            pending = subscription.next()
            void pending.catch(() => undefined)
            try {
              await processEvent(event)
            } catch (error) {
              if (!controller.signal.aborted) console.warn("[opencode-orchestra] V2 event processing failed", error)
            }
          }
        } finally { await subscription.return?.() }
      } catch (error) {
        if (!controller.signal.aborted) console.warn("[opencode-orchestra] V2 event stream failed; reconnecting", error)
      }
      if (controller.signal.aborted) break
      reconnect = true
      const delay = Math.min(retry.maxDelayMs ?? 30_000, (retry.baseDelayMs ?? 500) * 2 ** Math.min(failures++, 6))
      await abortableDelay(delay, controller.signal)
    }
  })().catch((error: unknown) => { if (!controller.signal.aborted) console.warn("[opencode-orchestra] V2 event stream failed", error) })

  return async () => {
    controller.abort()
    await stream
    try { await hooks.dispose?.() }
    finally { await browser.dispose() }
  }
}
