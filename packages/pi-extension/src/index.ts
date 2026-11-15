// herdr-web's pi extension. Runs inside each pi. Does nothing unless pi was started by herdr-core
// (HC_TERMINAL_ID is set); then it connects out to the backend's agents socket and reports what
// the session file cannot: the reply while it is written, the session's current leaf, working or
// settled, the model and effort, and queued messages. It also carries the backend's actions in.
//
// Constraints that shape this file: it imports only Node built-ins and pi's API (nothing from the
// workspace, so it can be installed on its own); it never blocks pi, never throws into it and
// prints nothing; every connection problem is retried quietly. The messages are written here by
// hand and held to packages/agents/src/wire.ts by test/wire.test.ts.
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { StringDecoder } from "node:string_decoder"

const WIRE = 1
const EXTENSION_VERSION = "0.0.0"
const REPLY_EVERY_MS = 50
const BACKOFF_MIN_MS = 500
const BACKOFF_MAX_MS = 30_000
const REFUSED_BACKOFF_MS = 60_000
const MAX_BUFFERED_BYTES = 1024 * 1024
const MAX_LINE_BYTES = 4 * 1024 * 1024
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

// ---- the parts of pi's API this uses, declared here so nothing has to be imported -----------

interface PiModel {
  provider: string
  id: string
  name?: string
  reasoning?: boolean
  thinkingLevelMap?: Record<string, unknown>
}
interface PiCtx {
  model?: PiModel
  thinkingLevel?: string
  scopedModels?: readonly { model: PiModel }[]
  cwd?: string
  hasUI?: boolean
  /** "tui" (the interactive pi), "print", "json" or "rpc". */
  mode?: string
  ui?: { setEditorText?(text: string): void }
  modelRegistry: { getAvailable(): PiModel[]; find(provider: string, id: string): PiModel | undefined }
  sessionManager: {
    getSessionFile(): string | undefined
    getSessionId(): string | undefined
    getLeafId(): string | null | undefined
  }
  isIdle(): boolean
  abort(): void
  getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined
}
interface PiApi {
  on(event: string, handler: (event: any, ctx: PiCtx) => unknown): void
  sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): unknown
  setModel(model: PiModel): Promise<boolean> | boolean
  setThinkingLevel(level: string): void
  getThinkingLevel(): string
  getSessionName?(): string | undefined
}

type Json = Record<string, unknown>

export default function herdrWeb(pi: PiApi): void {
  const terminalId = process.env.HC_TERMINAL_ID
  if (!terminalId) return // not started by herdr-core: this extension does nothing at all
  const pid = process.pid // said in every hello: the backend tells two pis that carry one terminal id apart by it

  let ctx: PiCtx | null = null
  let active = false
  let reason = "startup"

  let socket: net.Socket | null = null
  let connected = false
  let backoff = BACKOFF_MIN_MS
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let nextRetryMs: number | null = null

  let working = false
  let pending: { id: string; text: string; mode: "steer" | "followUp" }[] = []
  let pendingSeq = 0

  let replyMessage: any = null
  let replyTimer: ReturnType<typeof setTimeout> | null = null
  let lastReplyAt = 0
  let stateTimer: ReturnType<typeof setImmediate> | null = null
  let hintTimer: ReturnType<typeof setImmediate> | null = null
  let hintReplyDone = false

  // ---- the socket ---------------------------------------------------------------------------

  function socketPath(): string {
    const env = process.env
    if (env.HERDR_WEB_AGENTS_SOCKET) return env.HERDR_WEB_AGENTS_SOCKET
    const state = env.XDG_STATE_HOME || path.join(env.HOME || os.homedir(), ".local", "state")
    return path.join(state, "herdr-web", "agents.sock")
  }

  function write(message: Json, droppable = false): void {
    const s = socket
    if (!s || !connected || s.destroyed) return
    if (droppable && s.writableLength > MAX_BUFFERED_BYTES) return
    try {
      s.write(JSON.stringify({ v: WIRE, ...message }) + "\n")
    } catch {
      /* a broken pipe shows up as 'close' */
    }
  }

  function connect(): void {
    if (!active || socket) return
    let s: net.Socket
    try {
      s = net.createConnection(socketPath())
    } catch {
      return scheduleRetry(backoff)
    }
    socket = s
    s.unref()
    let received = ""
    const decoder = new StringDecoder("utf8") // a character can be split between two reads
    s.on("error", () => {})
    s.on("connect", () => {
      connected = true
      // The delay goes back to its minimum only when the backend has said `welcome`: a connection that is closed before that (a
      // refusal that did not arrive, a backend that hangs up) is a failed try, and the delay keeps growing.
      sendOpening()
    })
    s.on("data", (chunk) => {
      received += decoder.write(chunk)
      for (;;) {
        const at = received.indexOf("\n")
        if (at < 0) break
        const line = received.slice(0, at)
        received = received.slice(at + 1)
        if (line.trim() !== "") onLine(line)
      }
      if (received.length > MAX_LINE_BYTES) s.destroy()
    })
    s.on("close", () => {
      if (socket === s) socket = null
      connected = false
      if (active) scheduleRetry(nextRetryMs ?? backoff)
      nextRetryMs = null
    })
  }

  function scheduleRetry(delay: number): void {
    if (!active || retryTimer) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      connect()
    }, delay)
    retryTimer.unref()
    backoff = Math.min(Math.max(backoff, delay) * 2, BACKOFF_MAX_MS)
  }

  function stop(): void {
    active = false
    if (retryTimer) clearTimeout(retryTimer)
    if (replyTimer) clearTimeout(replyTimer)
    if (stateTimer) clearImmediate(stateTimer)
    if (hintTimer) clearImmediate(hintTimer)
    retryTimer = replyTimer = null
    stateTimer = hintTimer = null
    const s = socket
    socket = null
    connected = false
    try {
      s?.destroy()
    } catch {
      /* already gone */
    }
  }

  // ---- what is sent -------------------------------------------------------------------------

  function efforts(model: PiModel | undefined): string[] {
    if (!model) return []
    if (!model.reasoning) return ["off"]
    return LEVELS.filter((level) => {
      const mapped = model.thinkingLevelMap?.[level]
      if (mapped === null) return false
      if (level === "xhigh" || level === "max") return mapped !== undefined
      return true
    })
  }

  function modelList(c: PiCtx): Json[] {
    const scoped = c.scopedModels ?? []
    const models = scoped.length > 0 ? scoped.map((s) => s.model) : c.modelRegistry.getAvailable()
    return models.slice(0, 2000).map((m) => ({
      provider: m.provider,
      id: m.id,
      name: m.name ?? m.id,
      reasoning: m.reasoning === true,
      efforts: efforts(m),
    }))
  }

  function leaf(): string | null {
    try {
      return ctx?.sessionManager.getLeafId() ?? null
    } catch {
      return null
    }
  }

  function stateMessage(): Json {
    const c = ctx
    const model = c?.model
    let usage: Json | null = null
    try {
      const u = c?.getContextUsage()
      if (u) usage = { tokens: u.tokens, window: u.contextWindow, percent: u.percent }
    } catch {
      /* no usage yet */
    }
    let effort: string | null = null
    try {
      effort = pi.getThinkingLevel() ?? c?.thinkingLevel ?? null
    } catch {
      effort = c?.thinkingLevel ?? null
    }
    let name: string | null = null
    try {
      name = pi.getSessionName?.() || null
    } catch {
      /* optional */
    }
    return {
      type: "state",
      leafId: leaf(),
      model: model ? { provider: model.provider, id: model.id, name: model.name ?? model.id, reasoning: model.reasoning === true } : null,
      effort,
      efforts: efforts(model),
      working,
      pending,
      usage,
      name,
    }
  }

  function sendOpening(): void {
    const c = ctx
    if (!c) return
    let file: string | null = null
    let id: string | null = null
    try {
      file = c.sessionManager.getSessionFile() ?? null
      id = c.sessionManager.getSessionId() ?? null
    } catch {
      /* ephemeral session */
    }
    write({
      type: "hello",
      agent: "pi",
      terminalId,
      pid,
      extension: EXTENSION_VERSION,
      reason,
      session: { id, file, name: null, cwd: c.cwd ?? null },
    })
    try {
      write({ type: "models", list: modelList(c) })
    } catch {
      /* the registry may not be ready */
    }
    write(stateMessage())
    flushReply(true)
  }

  function scheduleState(): void {
    if (stateTimer || !active) return
    stateTimer = setImmediate(() => {
      stateTimer = null
      write(stateMessage())
    })
  }

  /** Tell the backend to read the session file, after pi has written to it (it writes after the event handlers run). */
  function scheduleEntries(replyDone: boolean): void {
    hintReplyDone = hintReplyDone || replyDone
    if (hintTimer || !active) return
    hintTimer = setImmediate(() => {
      hintTimer = null
      const done = hintReplyDone
      hintReplyDone = false
      write({ type: "entries", leafId: leaf(), replyDone: done })
      write(stateMessage())
    })
  }

  function flushReply(force = false): void {
    if (replyTimer) clearTimeout(replyTimer)
    replyTimer = null
    const message = replyMessage
    if (!message || (!connected && !force)) return
    lastReplyAt = Date.now()
    const blocks: Json[] = []
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type === "text" && typeof block.text === "string" && block.text !== "") blocks.push({ kind: "text", text: block.text })
      else if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking !== "") blocks.push({ kind: "thinking", text: block.thinking })
    }
    if (blocks.length > 0) write({ type: "reply", blocks }, true)
  }

  /** At most one reply message every REPLY_EVERY_MS; pi can produce thousands of updates a minute. */
  function scheduleReply(): void {
    if (replyTimer || !active) return
    const wait = Math.max(0, lastReplyAt + REPLY_EVERY_MS - Date.now())
    if (wait === 0) flushReply()
    else {
      replyTimer = setTimeout(() => flushReply(), wait)
      replyTimer.unref()
    }
  }

  // ---- what is received ---------------------------------------------------------------------

  function onLine(line: string): void {
    let message: any
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (!message || typeof message !== "object") return
    if (message.type === "refused") {
      nextRetryMs = REFUSED_BACKOFF_MS // a version this backend does not know: ask again rarely, quietly
      socket?.destroy()
      return
    }
    if (message.v !== WIRE) return
    if (message.type === "welcome") {
      backoff = BACKOFF_MIN_MS
      return
    }
    if (message.type === "action" && typeof message.id === "string") void runAction(message)
  }

  async function runAction(message: any): Promise<void> {
    try {
      await perform(message)
      write({ type: "result", id: message.id, ok: true })
    } catch (error) {
      write({ type: "result", id: message.id, ok: false, error: error instanceof Error ? error.message : "pi could not do that." })
    }
  }

  async function perform(message: any): Promise<void> {
    const c = ctx
    if (!c) throw new Error("pi has no session yet.")
    switch (message.op) {
      case "send": {
        if (typeof message.text !== "string" || message.text.trim() === "") throw new Error("There is nothing to send.")
        // While the agent works a message must say how it is delivered; Enter in pi's own box means steer.
        pi.sendUserMessage(message.text, c.isIdle() ? undefined : { deliverAs: "steer" })
        return
      }
      case "stop":
        c.abort()
        return
      case "set_model": {
        const text = String(message.model ?? "")
        const slash = text.indexOf("/")
        const model = slash > 0 ? c.modelRegistry.find(text.slice(0, slash), text.slice(slash + 1)) : undefined
        if (!model) throw new Error(`pi does not know the model “${text}”.`)
        const ok = await pi.setModel(model)
        if (!ok) throw new Error(`No API key is set up for ${model.provider}, so pi cannot switch to that model.`)
        scheduleState()
        return
      }
      case "set_effort": {
        const level = String(message.effort ?? "")
        const allowed = efforts(c.model)
        if (!allowed.includes(level)) {
          throw new Error(`This model does not take the effort “${level}”. It takes: ${allowed.join(", ") || "none"}.`)
        }
        pi.setThinkingLevel(level)
        scheduleState()
        return
      }
      case "clear_input": {
        if (c.hasUI && c.ui?.setEditorText) c.ui.setEditorText("")
        return
      }
      default:
        throw new Error("pi does not know that action.")
    }
  }

  // ---- pi's events --------------------------------------------------------------------------

  /** Subscribe so that nothing a handler does can reach pi. */
  function on(event: string, handler: (event: any, c: PiCtx) => void): void {
    pi.on(event, (e, c) => {
      try {
        if (c) ctx = c
        handler(e ?? {}, c)
      } catch {
        /* never into pi */
      }
      return undefined
    })
  }

  on("session_start", (e, c) => {
    // Only the interactive pi has a chat. `pi -p`, JSON and RPC runs (a sub-agent started inside a pi's terminal inherits its
    // HC_TERMINAL_ID) make no connection at all.
    if (c.mode !== "tui") return
    reason = typeof e.reason === "string" ? e.reason : "startup"
    working = !c.isIdle()
    pending = []
    active = true
    connect()
  })
  on("session_shutdown", () => stop())

  on("agent_start", () => {
    working = true
    scheduleState()
  })
  on("agent_settled", () => {
    working = false
    pending = []
    replyMessage = null
    scheduleState()
  })
  on("turn_end", () => scheduleState())

  on("input", (e) => {
    if ((e.streamingBehavior === "steer" || e.streamingBehavior === "followUp") && typeof e.text === "string") {
      pending = [...pending, { id: `p${++pendingSeq}`, text: e.text, mode: e.streamingBehavior }]
      scheduleState()
    }
  })

  on("message_start", (e) => {
    const m = e.message
    if (m?.role === "assistant") {
      replyMessage = m
      lastReplyAt = 0
    } else if (m?.role === "user" && pending.length > 0) {
      const text = messageText(m.content).trim()
      const at = pending.findIndex((p) => p.text.trim() === text)
      if (at >= 0) {
        pending = pending.filter((_, i) => i !== at)
        scheduleState()
      }
    }
  })
  on("message_update", (e) => {
    if (e.message?.role === "assistant") replyMessage = e.message
    scheduleReply()
  })
  on("message_end", (e) => {
    const assistant = e.message?.role === "assistant"
    if (assistant) {
      replyMessage = null
      if (replyTimer) clearTimeout(replyTimer)
      replyTimer = null
    }
    scheduleEntries(assistant)
  })

  on("tool_execution_start", (e) => {
    write({ type: "tool", phase: "start", callId: String(e.toolCallId), name: String(e.toolName ?? "tool") })
  })
  on("tool_execution_end", (e) => {
    write({ type: "tool", phase: "end", callId: String(e.toolCallId), name: String(e.toolName ?? "tool"), isError: e.isError === true })
  })

  on("session_compact", () => scheduleEntries(false))
  on("session_compact_failed", (e) => {
    const text = typeof e.errorMessage === "string" && e.errorMessage ? e.errorMessage : "Compaction failed."
    write({ type: "notice", level: "error", text })
  })
  on("session_tree", () => scheduleEntries(false))
  on("session_info_changed", () => scheduleState())
  // After either, send the current values: pi may clamp the level by itself, and re-selecting the
  // same model fires nothing at all.
  on("model_select", () => scheduleState())
  on("thinking_level_select", () => scheduleState())
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
    .join("\n")
}
