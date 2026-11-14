import { encodeMessage, parseServerMessage } from "@herdr-web/protocol"
import type { ServerMessage } from "@herdr-web/protocol"

/** The slice of WebSocket the client uses; tests pass a fake. */
export interface SocketLike {
  readonly readyState: number
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number }) => void) | null
  onerror: (() => void) | null
  send(data: string): void
  close(): void
}

export interface LiveHandlers {
  onMessage(message: ServerMessage): void
  onLink(link: "connecting" | "open" | "reconnecting"): void
  /** The socket could not be opened and the backend says nobody is signed in. */
  onSignedOut(): void
}

export interface LiveOptions {
  url: string
  createSocket?: (url: string) => SocketLike
  /** Called after a socket that never opened; true / false / null as `signedIn`. */
  checkSession?: () => Promise<boolean | null>
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
  random?: () => number
  /** Ping every this long; give up on a socket that has said nothing for 2.5 times as long. */
  pingMs?: number
}

const OPEN = 1

/** Delay before reconnect attempt `attempt` (0, 1, 2, ...): 0.5 s doubling to 10 s, with up to 25% jitter. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(500 * 2 ** attempt, 10_000)
  return Math.round(base * (1 + 0.25 * random()))
}

/**
 * The one main-socket client: connects, hands every valid message to the store, reconnects by
 * itself with backoff. Every new socket starts with a snapshot, so nothing is resumed.
 */
export class LiveClient {
  private socket: SocketLike | null = null
  private attempt = 0
  private stopped = true
  private timer: unknown = null
  private pinger: unknown = null
  private lastHeard = 0
  private opened = false
  private everOpened = false
  private readonly opts: Required<Omit<LiveOptions, "checkSession">> & Pick<LiveOptions, "checkSession">

  constructor(
    options: LiveOptions,
    private readonly handlers: LiveHandlers,
  ) {
    this.opts = {
      createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
      random: Math.random,
      pingMs: 15_000,
      ...options,
    }
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) this.opts.clearTimeout(this.timer)
    this.timer = null
    this.stopPing()
    const s = this.socket
    this.socket = null
    if (s) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null
      s.close()
    }
  }

  private connect(): void {
    this.handlers.onLink(this.everOpened ? "reconnecting" : "connecting")
    this.opened = false
    let socket: SocketLike
    try {
      socket = this.opts.createSocket(this.opts.url)
    } catch {
      this.retryLater()
      return
    }
    this.socket = socket
    socket.onopen = () => {
      this.opened = true
      this.everOpened = true
      this.lastHeard = Date.now()
      this.startPing()
      // The link counts as open once the snapshot arrives (see onmessage), not at the handshake.
    }
    socket.onmessage = (event) => {
      this.lastHeard = Date.now()
      if (typeof event.data !== "string") return
      const parsed = parseServerMessage(event.data)
      if (!parsed.ok) return socket.close() // a bridge we do not understand: start over
      if (parsed.message.type === "snapshot") {
        this.attempt = 0
        this.handlers.onLink("open")
      }
      this.handlers.onMessage(parsed.message)
    }
    socket.onerror = () => {}
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null
      this.stopPing()
      const neverOpened = !this.opened
      this.handlers.onLink("reconnecting")
      if (neverOpened && this.opts.checkSession) {
        // A refused upgrade looks the same as an unreachable backend from here: ask.
        void this.opts.checkSession().then((signedIn) => {
          if (this.stopped) return
          if (signedIn === false) {
            this.stop()
            this.handlers.onSignedOut()
          } else this.retryLater()
        })
      } else this.retryLater()
    }
  }

  private retryLater(): void {
    if (this.stopped) return
    const delay = backoffMs(this.attempt++, this.opts.random)
    this.timer = this.opts.setTimeout(() => {
      this.timer = null
      if (!this.stopped) this.connect()
    }, delay)
  }

  private startPing(): void {
    this.stopPing()
    const tick = () => {
      const s = this.socket
      if (!s || this.stopped) return
      if (Date.now() - this.lastHeard > this.opts.pingMs * 2.5) {
        s.close() // silent for too long: the link is dead even if the browser has not noticed
      } else if (s.readyState === OPEN) {
        s.send(encodeMessage({ type: "ping" }))
      }
      this.pinger = this.opts.setTimeout(tick, this.opts.pingMs)
    }
    this.pinger = this.opts.setTimeout(tick, this.opts.pingMs)
  }

  private stopPing(): void {
    if (this.pinger !== null) this.opts.clearTimeout(this.pinger)
    this.pinger = null
  }
}
