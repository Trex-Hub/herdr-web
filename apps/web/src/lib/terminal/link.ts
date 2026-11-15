import {
  Tag,
  TerminalClose,
  encodeTerminalMessage,
  parseTerminalServerMessage,
  splitTagged,
  tagMessage,
  type Display,
} from "@herdr-web/protocol"
import { backoffMs } from "../live"

/** The slice of WebSocket the link uses; tests pass a fake. */
export interface TerminalSocketLike {
  binaryType: string
  readonly readyState: number
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number; reason: string }) => void) | null
  onerror: (() => void) | null
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
}

export type LinkState =
  | { kind: "connecting" }
  | { kind: "live" }
  /** The socket dropped while the terminal is live; attaching again by itself. */
  | { kind: "reconnecting"; why: string | null }
  /** Several attempts in a row never got as far as attaching; still retrying, at the slow end of the backoff. */
  | { kind: "unreachable"; why: string | null }
  /** The terminal ended; nothing more will come. */
  | { kind: "ended"; reason: string; exitCode: number | null; signal: number | null }
  /** The bridge refused for good (no such terminal, protocol error); not retried. */
  | { kind: "gone"; why: string }

export interface AttachRequest {
  cols: number
  rows: number
  history: number
  display: Display
}

export interface LinkHandlers {
  onState(state: LinkState): void
  /** Attached (again). `again` is true for every attach after the first: the paint that follows replaces what was on screen. */
  onAttached(info: { cols: number; rows: number; automaticInput: boolean; again: boolean }): void
  /** Output bytes. Call `parsed` once the emulator has parsed them; that is what lets core send more. */
  onOutput(bytes: Uint8Array, parsed: () => void): void
}

export interface LinkOptions {
  url: string
  /** What to attach with, asked again on every attach. */
  attach: () => AttachRequest
  createSocket?: (url: string) => TerminalSocketLike
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
  random?: () => number
  /** Report consumed bytes once this many are owed, or after `flushMs`. */
  flushBytes?: number
  flushMs?: number
}

const OPEN = 1

/** Attempts in a row that fail before the view says it cannot connect rather than that it is reconnecting. */
export const UNREACHABLE_AFTER = 5

/** Our own close code for a message from the bridge that makes no sense (browsers accept 1000 and 3000 to 4999 only). Retried. */
const BAD_MESSAGE = 4400

/** Closes after which attaching again cannot help. */
const FINAL = new Set<number>([TerminalClose.ENDED, TerminalClose.PROTOCOL, TerminalClose.NOT_FOUND, TerminalClose.FINISHED, TerminalClose.NO_ATTACH])

/**
 * One terminal view's socket to the bridge. It attaches, hands output to the emulator and
 * reports back what the emulator parsed, and attaches again by itself (with backoff) when the
 * socket drops while the terminal is live. Typed input is never held back: while there is no
 * attach, it is dropped, so nothing typed into a dead line runs later.
 */
export class TerminalLink {
  private socket: TerminalSocketLike | null = null
  private attached = false
  private everAttached = false
  private attempt = 0
  /** Attempts since the last attach that ended without one. */
  private failures = 0
  private stopped = true
  private done = false
  private timer: unknown = null
  private flushTimer: unknown = null
  private epoch = 0
  private owed = 0
  private lastWhy: string | null = null
  private readonly opts: Required<Omit<LinkOptions, "createSocket">> & Pick<LinkOptions, "createSocket">

  constructor(
    options: LinkOptions,
    private readonly handlers: LinkHandlers,
  ) {
    this.opts = {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      random: Math.random,
      flushBytes: 16 * 1024,
      flushMs: 8,
      ...options,
    }
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.done = false
    this.handlers.onState({ kind: "connecting" })
    this.open()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    const s = this.socket
    this.socket = null
    this.attached = false
    if (s) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null
      s.close(1000, "view closed")
    }
  }

  get live(): boolean {
    return this.attached
  }

  /** Human input. Dropped, not queued, unless attached. Returns whether it was sent. */
  sendInput(bytes: Uint8Array): boolean {
    return this.sendBinary(Tag.INPUT, bytes)
  }

  /** The emulator's own replies. */
  sendAutomatic(bytes: Uint8Array): boolean {
    return this.sendBinary(Tag.AUTOMATIC, bytes)
  }

  resize(cols: number, rows: number): void {
    this.sendText({ type: "resize", cols, rows })
  }

  focus(focused: boolean): void {
    this.sendText({ type: "focus", focused })
  }

  display(display: Display): void {
    this.sendText({ type: "display", display })
  }

  private sendBinary(tag: typeof Tag.INPUT | typeof Tag.AUTOMATIC, bytes: Uint8Array): boolean {
    if (!this.attached || !this.socket || this.socket.readyState !== OPEN || bytes.length === 0) return false
    this.socket.send(tagMessage(tag, bytes))
    return true
  }

  private sendText(message: Parameters<typeof encodeTerminalMessage>[0]): void {
    if (!this.attached || !this.socket || this.socket.readyState !== OPEN) return
    this.socket.send(encodeTerminalMessage(message))
  }

  private open(): void {
    const socket = (this.opts.createSocket ?? ((url) => new WebSocket(url) as unknown as TerminalSocketLike))(this.opts.url)
    socket.binaryType = "arraybuffer"
    this.socket = socket
    this.epoch += 1
    this.owed = 0
    socket.onopen = () => {
      if (this.socket !== socket) return
      const a = this.opts.attach()
      socket.send(encodeTerminalMessage({ type: "attach", ...a }))
    }
    socket.onmessage = (event) => {
      if (this.socket !== socket) return
      this.onMessage(socket, event.data)
    }
    socket.onclose = (event) => {
      if (this.socket !== socket) return
      this.onClose(event.code, event.reason)
    }
    socket.onerror = () => {} // a close always follows
  }

  private onMessage(socket: TerminalSocketLike, data: unknown): void {
    if (typeof data === "string") {
      const parsed = parseTerminalServerMessage(data)
      if (!parsed.ok) return this.fail(socket)
      const m = parsed.message
      if (m.type === "attached") {
        const again = this.everAttached
        this.everAttached = true
        this.attached = true
        this.attempt = 0
        this.failures = 0
        this.lastWhy = null
        this.handlers.onState({ kind: "live" })
        this.handlers.onAttached({ cols: m.cols, rows: m.rows, automaticInput: m.automaticInput, again })
      } else {
        this.done = true
        this.handlers.onState({ kind: "ended", reason: m.reason, exitCode: m.exitCode, signal: m.signal })
      }
      return
    }
    if (!(data instanceof ArrayBuffer)) return this.fail(socket)
    const tagged = splitTagged(new Uint8Array(data))
    if (!tagged || tagged.tag !== Tag.OUTPUT || !this.attached) return this.fail(socket)
    const epoch = this.epoch
    this.handlers.onOutput(tagged.bytes, () => this.parsed(epoch, tagged.bytes.length))
  }

  /** The emulator parsed `bytes` of what epoch `epoch` sent. */
  private parsed(epoch: number, bytes: number): void {
    if (epoch !== this.epoch || !this.attached) return // belongs to a socket that is gone
    this.owed += bytes
    if (this.owed >= this.opts.flushBytes) return this.flush()
    if (this.flushTimer === null) this.flushTimer = this.opts.setTimeout(() => this.flush(), this.opts.flushMs)
  }

  private flush(): void {
    if (this.flushTimer !== null) this.opts.clearTimeout(this.flushTimer)
    this.flushTimer = null
    if (this.owed <= 0) return
    const bytes = this.owed
    this.owed = 0
    this.sendText({ type: "consumed", bytes })
  }

  private fail(socket: TerminalSocketLike): void {
    socket.close(BAD_MESSAGE, "bad message")
    this.onClose(BAD_MESSAGE, "bad message")
  }

  private onClose(code: number, reason: string): void {
    this.clearTimers()
    const wasAttached = this.attached
    this.socket = null
    this.attached = false
    if (this.stopped) return
    if (this.done || code === TerminalClose.ENDED) return // the `ended` message said what happened
    if (FINAL.has(code)) {
      this.done = true
      this.handlers.onState({ kind: "gone", why: reason || `closed (${code})` })
      return
    }
    this.lastWhy = reason || null
    if (wasAttached) this.failures = 0 // it was working; this is the first loss
    this.failures += 1
    this.handlers.onState(this.failures >= UNREACHABLE_AFTER ? { kind: "unreachable", why: this.lastWhy } : { kind: "reconnecting", why: this.lastWhy })
    const delay = backoffMs(this.attempt++, this.opts.random)
    this.timer = this.opts.setTimeout(() => {
      this.timer = null
      if (!this.stopped) this.open()
    }, delay)
  }

  private clearTimers(): void {
    if (this.timer !== null) this.opts.clearTimeout(this.timer)
    if (this.flushTimer !== null) this.opts.clearTimeout(this.flushTimer)
    this.timer = this.flushTimer = null
  }
}
