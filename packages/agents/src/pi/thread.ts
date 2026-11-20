// A pi agent as a thread: history from its session file, live state from the extension's messages.
import path from "node:path"
import {
  EMPTY_LIVE,
  PAGE_SIZE,
  type Capabilities,
  type Identity,
  type Live,
  type Row,
  type ThreadChange,
  type ThreadSnapshot,
} from "../rows.js"
import { ActionError, type Page, type Thread } from "../thread.js"
import type { BackendMessage, ExtensionMessage, Hello, PiState, WireModel } from "../wire.js"
import { WIRE_VERSION } from "../wire.js"
import { buildRows } from "./rows.js"
import { SessionLog } from "./session-log.js"

export interface PiThreadOptions {
  /** Write one message to the extension. */
  send(message: BackendMessage): void
  /** How long an action waits for the extension's answer. */
  actionTimeoutMs?: number
  /** After an `entries` message, how long to wait for pi's write to reach the file. */
  entryWaitMs?: number
  log?: (line: string) => void
}

const RETRY_EVERY_MS = 30

export class PiThread implements Thread {
  readonly kind = "pi"
  readonly terminalId: string
  closed = false

  private readonly log: SessionLog
  private state: PiState | null = null
  private models: WireModel[] = []
  private reply: Live["reply"] = null
  private tools = new Map<string, { name: string; argument?: string }>()
  private notice: Live["notice"] = null
  private leafId: string | null = null

  private rows: Row[] = []
  private rowJson: string[] = []
  private resultEntries: ReturnType<typeof buildRows>["resultEntry"] = new Map()

  private seq = 1
  private published: { identity: string; capabilities: string; live: string }
  private listeners = new Set<(change: ThreadChange) => void>()
  private closeListeners: (() => void)[] = []

  private waiting: { leafId: string; replyDone: boolean; until: number; timer: ReturnType<typeof setTimeout> } | null = null
  private nextAction = 1
  private actions = new Map<string, { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()

  constructor(
    private readonly hello: Hello,
    private readonly options: PiThreadOptions,
  ) {
    this.terminalId = hello.terminalId
    this.log = new SessionLog(readableFile(hello.session.file))
    this.rebuildRows()
    this.published = { identity: json(this.identity()), capabilities: json(this.capabilities()), live: json(this.live()) }
  }

  // ---- reading ----------------------------------------------------------------------------

  snapshot(): ThreadSnapshot {
    return this.makeSnapshot(this.seq)
  }

  private makeSnapshot(seq: number): ThreadSnapshot {
    return {
      seq,
      identity: this.identity(),
      rows: this.rows.slice(-PAGE_SIZE),
      hasMore: this.rows.length > PAGE_SIZE,
      live: this.live(),
      capabilities: this.capabilities(),
    }
  }

  subscribe(listener: (change: ThreadChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async page(beforeRowId: string, limit: number = PAGE_SIZE): Promise<Page> {
    const index = this.rows.findIndex((r) => r.id === beforeRowId)
    if (index < 0) throw new ActionError("That part of the conversation is no longer there. Reload the thread.")
    const size = Math.max(1, Math.min(limit, 500))
    const start = Math.max(0, index - size)
    return { rows: this.rows.slice(start, index), hasMore: start > 0 }
  }

  async toolResult(rowId: string): Promise<string> {
    const entry = this.resultEntries.get(rowId)
    if (!entry) throw new ActionError("That tool call has no result to show.")
    const message = entry.message as Record<string, unknown>
    if (message.role === "bashExecution") return typeof message.output === "string" ? message.output : ""
    const content = message.content
    if (typeof content === "string") return content
    if (!Array.isArray(content)) return ""
    return content
      .map((b: unknown) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
      .filter((s) => s !== "")
      .join("\n")
  }

  // ---- the extension's messages -------------------------------------------------------------

  /** Take one validated message from the extension. */
  handle(message: ExtensionMessage): void {
    if (this.closed) return
    let rowsDirty = false
    let replyDone = false
    switch (message.type) {
      case "hello":
        return // a second hello on one connection is ignored; a new session is a new connection
      case "state": {
        const was = this.state
        this.state = message
        if (message.leafId !== this.leafId) {
          this.leafId = message.leafId
          rowsDirty = true
        }
        if (was?.working !== message.working) {
          rowsDirty = true // an unanswered tool call is running or interrupted
          if (message.working) this.notice = null
          else {
            this.reply = null
            this.tools.clear()
          }
        }
        if (was?.name !== message.name) rowsDirty = true
        break
      }
      case "models":
        this.models = message.list
        break
      case "reply":
        this.reply = message.blocks.length > 0 ? { blocks: message.blocks } : null
        break
      case "tool":
        if (message.phase === "start") this.tools.set(message.callId, { name: message.name, ...(message.argument !== undefined ? { argument: message.argument } : {}) })
        else this.tools.delete(message.callId)
        break
      case "notice":
        this.notice = { level: message.level, text: message.text }
        break
      case "entries": {
        rowsDirty = true
        if (message.leafId !== null) this.leafId = message.leafId
        replyDone = message.replyDone
        if (message.leafId !== null) replyDone = this.expect(message.leafId, message.replyDone)
        break
      }
      case "result": {
        const action = this.actions.get(message.id)
        if (action) {
          this.actions.delete(message.id)
          clearTimeout(action.timer)
          if (message.ok) action.resolve()
          else action.reject(new ActionError(message.error))
        }
        return
      }
    }
    if (replyDone && !this.waiting) this.reply = null
    this.publish(rowsDirty)
  }

  /** The extension reports after pi wrote, but a slow disk or a pending first write may still be behind it. */
  private expect(leafId: string, replyDone: boolean): boolean {
    if (this.waiting) {
      clearTimeout(this.waiting.timer)
      replyDone = replyDone || this.waiting.replyDone
      this.waiting = null
    }
    this.log.refresh()
    if (this.log.entries.has(leafId)) return replyDone
    const until = Date.now() + (this.options.entryWaitMs ?? 1500)
    this.waiting = { leafId, replyDone, until, timer: setTimeout(() => this.retry(), RETRY_EVERY_MS) }
    return replyDone
  }

  private retry(): void {
    const waiting = this.waiting
    if (!waiting || this.closed) return
    this.log.refresh()
    if (this.log.entries.has(waiting.leafId) || Date.now() >= waiting.until) {
      this.waiting = null
      if (waiting.replyDone) this.reply = null
      this.publish(true)
      return
    }
    waiting.timer = setTimeout(() => this.retry(), RETRY_EVERY_MS)
  }

  // ---- publishing ---------------------------------------------------------------------------

  private publish(rowsDirty: boolean): void {
    const change: Extract<ThreadChange, { type: "update" }> = { type: "update", seq: this.seq + 1 }
    let reset = false

    if (rowsDirty) {
      const old = this.rows
      const oldJson = this.rowJson
      this.rebuildRows()
      const diff = diffRows(old, oldJson, this.rows, this.rowJson)
      if (diff === "reset") reset = true
      else if (diff.length > 0) change.rows = diff
    }
    const identity = json(this.identity())
    if (identity !== this.published.identity) {
      this.published.identity = identity
      change.identity = this.identity()
    }
    const capabilities = json(this.capabilities())
    if (capabilities !== this.published.capabilities) {
      this.published.capabilities = capabilities
      change.capabilities = this.capabilities()
    }
    const live = json(this.live())
    if (live !== this.published.live) {
      this.published.live = live
      change.live = this.live()
    }

    if (reset) {
      this.seq++
      this.emit({ type: "reset", seq: this.seq, snapshot: this.makeSnapshot(this.seq) })
    } else if (change.rows || change.live || change.capabilities || change.identity) {
      this.seq++
      this.emit(change)
    }
  }

  private emit(change: ThreadChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change)
      } catch (error) {
        this.options.log?.(`agents: a thread listener threw: ${String(error)}`)
      }
    }
  }

  private rebuildRows(): void {
    this.log.refresh()
    const { path } = this.log.branch(this.leafId)
    const built = buildRows(path, this.log.broken, this.state?.working ?? false, this.log.unreadable)
    this.rows = built.rows
    this.rowJson = built.rows.map(json)
    this.resultEntries = built.resultEntry
  }

  private identity(): Identity {
    const title = this.state?.name ?? this.log.name ?? this.hello.session.name ?? this.firstUserText()
    return {
      agent: "pi",
      terminalId: this.terminalId,
      sessionId: this.log.header?.id ?? this.hello.session.id,
      sessionFile: this.hello.session.file,
      title,
      cwd: this.hello.session.cwd ?? this.log.header?.cwd ?? null,
    }
  }

  private firstUserText(): string | null {
    const first = this.rows.find((r) => r.kind === "user")
    if (!first || first.kind !== "user") return null
    const line = first.text.trim().split("\n")[0] ?? ""
    return line === "" ? null : line.length > 80 ? `${line.slice(0, 79)}…` : line
  }

  private live(): Live {
    return {
      ...EMPTY_LIVE,
      working: this.state?.working ?? false,
      reply: this.reply,
      tools: [...this.tools].map(([callId, { name, argument }]) => ({ callId, name, ...(argument !== undefined ? { argument } : {}) })),
      pending: this.state?.pending ?? [],
      usage: this.state?.usage ?? null,
      notice: this.notice,
    }
  }

  private capabilities(): Capabilities {
    const model = this.state?.model
    return {
      send: true,
      stop: true,
      models:
        this.models.length > 0
          ? { list: this.models.map((m) => ({ id: `${m.provider}/${m.id}`, name: m.name, reasoning: m.reasoning })), current: model ? `${model.provider}/${model.id}` : null }
          : null,
      efforts: this.state && this.state.efforts.length > 0 ? { list: this.state.efforts, current: this.state.effort } : null,
    }
  }

  // ---- actions ------------------------------------------------------------------------------

  send(text: string): Promise<void> {
    if (text.trim() === "") return Promise.reject(new ActionError("There is nothing to send."))
    return this.request({ op: "send", text })
  }

  stop(): Promise<void> {
    return this.request({ op: "stop" })
  }

  setModel(id: string): Promise<void> {
    if (this.models.length > 0 && !this.models.some((m) => `${m.provider}/${m.id}` === id)) {
      return Promise.reject(new ActionError(`pi does not offer the model “${id}”.`))
    }
    return this.request({ op: "set_model", model: id })
  }

  setEffort(level: string): Promise<void> {
    const list = this.state?.efforts ?? []
    if (list.length > 0 && !list.includes(level)) {
      return Promise.reject(new ActionError(`This model does not take the effort “${level}”. It takes: ${list.join(", ")}.`))
    }
    return this.request({ op: "set_effort", effort: level })
  }

  clearInput(): Promise<void> {
    return this.request({ op: "clear_input" })
  }

  private request(op: { op: "send"; text: string } | { op: "stop" } | { op: "set_model"; model: string } | { op: "set_effort"; effort: string } | { op: "clear_input" }): Promise<void> {
    if (this.closed) return Promise.reject(new ActionError("The agent is no longer connected."))
    const id = `a${this.nextAction++}`
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.actions.delete(id)
        reject(new ActionError("pi did not answer in time. It may be busy or gone."))
      }, this.options.actionTimeoutMs ?? 10_000)
      this.actions.set(id, { resolve, reject, timer })
      try {
        this.options.send({ v: WIRE_VERSION, type: "action", id, ...op })
      } catch {
        this.actions.delete(id)
        clearTimeout(timer)
        reject(new ActionError("The agent is no longer connected."))
      }
    })
  }

  // ---- ending -------------------------------------------------------------------------------

  onClose(listener: () => void): void {
    if (this.closed) listener()
    else this.closeListeners.push(listener)
  }

  /** The connection ended, or the backend is done with it. */
  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.waiting) clearTimeout(this.waiting.timer)
    this.waiting = null
    for (const [, action] of this.actions) {
      clearTimeout(action.timer)
      action.reject(new ActionError("The agent is no longer connected."))
    }
    this.actions.clear()
    this.listeners.clear()
    for (const listener of this.closeListeners.splice(0)) listener()
  }
}

/** Only an absolute path to a `.jsonl` file is read: a hello names the file, and what it names is not trusted. */
function readableFile(file: string | null): string | null {
  return file !== null && path.isAbsolute(file) && file.endsWith(".jsonl") ? file : null
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

/** "reset" when the old rows are not a prefix of the new ones (the branch moved); else the upserts. */
function diffRows(old: Row[], oldJson: string[], next: Row[], nextJson: string[]): Row[] | "reset" {
  if (next.length < old.length) return "reset"
  const out: Row[] = []
  for (let i = 0; i < old.length; i++) {
    if (old[i]!.id !== next[i]!.id) return "reset"
    if (oldJson[i] !== nextJson[i]) out.push(next[i]!)
  }
  for (let i = old.length; i < next.length; i++) out.push(next[i]!)
  return out
}
