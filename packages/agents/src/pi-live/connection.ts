// A client of one pi's pi-live socket (the contract is pi-live's docs/protocol.md): says hello as a
// chat client, reads the welcome as the first picture, and from then on feeds a PiThread with what
// pi says. Finding sockets, linking them to terminals and reconnecting belong to the caller.
import net from "node:net"
import type { Duplex } from "node:stream"
import { PiThread, type PiThreadOptions } from "../pi/thread.js"
import { ActionError } from "../thread.js"
import {
  PI_LIVE_MAX_LINE_BYTES,
  PI_LIVE_MAX_SEND_BYTES,
  PI_LIVE_PROTOCOL,
  PiLiveActionResultSchema,
  PiLiveChatMessageSchema,
  PiLiveGoodbyeSchema,
  PiLiveWelcomeSchema,
  type PiLiveSession,
  type ThreadAction,
} from "./wire.js"

export const NO_CHAT = "Update pi-ask-user to chat with this pi."
export const NO_CONTROL = "Control is off for this pi."
export const TOO_LONG = "That message is too long to send to pi (over 1 MiB). Shorten it."

export interface PiLiveOptions {
  /** The herdr-core terminal this pi runs in, as the caller linked it. */
  terminalId: string
  /** `client.name` in the hello. Default "herdr-web". */
  clientName?: string
  log?: (line: string) => void
  /** How long pi may take to answer the hello with its welcome. Default 10 s. */
  welcomeTimeoutMs?: number
  /** The longest line read from pi. Default PI_LIVE_MAX_LINE_BYTES; a longer one closes the connection. */
  maxLineBytes?: number
  thread?: Partial<Pick<PiThreadOptions, "actionTimeoutMs" | "entryWaitMs">>
}

export interface PiLiveReady {
  thread: PiThread
  session: PiLiveSession
  /** pi-live's package version, when it says. */
  version: string | null
  features: string[]
  /** Whether this pi-live can send chat (`"chat"` in `welcome.features`). When not, the thread has rows and nothing live. */
  chat: boolean
  /** Whether clients may act (`welcome.control`). */
  control: boolean
  /** The sentence for a pi that cannot be chatted with (no chat, or control off); null when it can. The thread refuses every action with it. */
  disabled: string | null
}

export interface PiLiveEnd {
  /**
   * Why pi-live ended the session, from its `goodbye`: "quit", "reload", "new", "resume" or "fork". Anything but "quit" means the
   * same pi is about to open a new session. A goodbye without a reason counts as "quit". Null: the connection ended without a goodbye.
   */
  shutdown: string | null
  /** One line for logs. */
  why: string
}

export interface PiLiveConnection {
  /** Resolves once the welcome has been read and the thread holds its first picture. Rejects when the connection ended before that. */
  readonly ready: Promise<PiLiveReady>
  /** Resolves when the connection has ended, for any reason. */
  readonly closed: Promise<PiLiveEnd>
  /** End the connection (and the thread). */
  close(): void
}

/** Connect to the socket a pi's session file names. */
export function connectPiLive(socketPath: string, options: PiLiveOptions): PiLiveConnection {
  return openPiLive(net.connect(socketPath), options)
}

/** Speak pi-live on a socket that is already made (or being connected). */
export function openPiLive(socket: Duplex, options: PiLiveOptions): PiLiveConnection {
  const log = options.log ?? (() => {})
  const maxLine = options.maxLineBytes ?? PI_LIVE_MAX_LINE_BYTES
  let thread: PiThread | null = null
  let chat = false
  let done = false
  let shutdown: string | null = null
  let chunks: Buffer[] = []
  let chunked = 0
  let resolveReady!: (r: PiLiveReady) => void
  let rejectReady!: (e: Error) => void
  let resolveClosed!: (e: PiLiveEnd) => void
  const ready = new Promise<PiLiveReady>((res, rej) => {
    resolveReady = res
    rejectReady = rej
  })
  const closed = new Promise<PiLiveEnd>((res) => {
    resolveClosed = res
  })
  ready.catch(() => {}) // a caller that only waits on `closed` must not trip over this
  const welcomeTimer = setTimeout(() => {
    log("pi-live: a pi did not send its welcome in time; closing the connection")
    end("no welcome")
  }, options.welcomeTimeoutMs ?? 10_000)

  function write(message: object): void {
    const line = JSON.stringify(message) + "\n"
    if (Buffer.byteLength(line) > PI_LIVE_MAX_SEND_BYTES) throw new ActionError(TOO_LONG)
    if (!done) socket.write(line)
  }

  function end(why: string): void {
    if (done) return
    done = true
    clearTimeout(welcomeTimer)
    if (!thread) rejectReady(new Error(`pi-live connection ended before the welcome: ${why}`))
    thread?.close()
    socket.destroy()
    resolveClosed({ shutdown, why })
  }

  function onWelcome(value: unknown): void {
    const parsed = PiLiveWelcomeSchema.safeParse(value)
    if (!parsed.success) {
      log(`pi-live: the welcome was not valid (${parsed.error.issues[0]?.path.join(".") || "shape"}); closing the connection`)
      return end("bad welcome")
    }
    const welcome = parsed.data
    if (welcome.protocol !== PI_LIVE_PROTOCOL) {
      log(`pi-live: a pi speaks protocol ${welcome.protocol}, this client speaks ${PI_LIVE_PROTOCOL}; closing the connection`)
      return end("protocol")
    }
    const features = welcome.features ?? []
    chat = features.includes("chat")
    if (chat && !welcome.chat) {
      log("pi-live: the welcome says chat but carries none; closing the connection")
      return end("bad welcome")
    }
    const control = welcome.control !== false
    const disabled = !chat ? NO_CHAT : !control ? NO_CONTROL : null
    clearTimeout(welcomeTimer)
    const sendAction = ({ id, ...action }: ThreadAction): void => write({ ...action, reqId: id })
    thread = new PiThread(
      {
        terminalId: options.terminalId,
        session: {
          id: welcome.session.id,
          file: welcome.session.file ?? null,
          name: welcome.session.name ?? null,
          cwd: welcome.session.cwd ?? null,
        },
      },
      { send: sendAction, log, disabled, ...options.thread },
    )
    // The first picture, in the order the thread wants it: state (which says whether it is working), then what is live.
    if (welcome.chat) {
      thread.handle({ type: "state", ...welcome.chat.state })
      thread.handle({ type: "models", list: welcome.chat.models })
      if (welcome.chat.reply.blocks.length > 0) thread.handle({ type: "reply", blocks: welcome.chat.reply.blocks })
      for (const tool of welcome.chat.tools) thread.handle({ type: "tool", phase: "start", ...tool })
    }
    resolveReady({ thread, session: welcome.session, version: welcome.version ?? null, features, chat, control, disabled })
  }

  function onLine(line: string): void {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      log("pi-live: ignored a line that was not JSON")
      return
    }
    const type = typeof value === "object" && value !== null ? (value as { type?: unknown }).type : undefined
    if (typeof type !== "string") return
    if (!thread) {
      if (type === "welcome") onWelcome(value)
      else if (type === "error") log(`pi-live: pi said: ${String((value as { message?: unknown }).message)}`)
      return
    }
    switch (type) {
      case "action_result": {
        const result = PiLiveActionResultSchema.safeParse(value)
        if (result.success) thread.settle(result.data.reqId, result.data.ok ? null : result.data.error)
        else log("pi-live: ignored an invalid action_result")
        return
      }
      case "goodbye": {
        const goodbye = PiLiveGoodbyeSchema.safeParse(value)
        shutdown = goodbye.success ? (goodbye.data.shutdown ?? "quit") : "quit"
        return
      }
      case "error":
        log(`pi-live: pi said: ${String((value as { message?: unknown }).message)}`)
        return
      case "state":
      case "models":
      case "reply":
      case "tool":
      case "entries":
      case "notice": {
        if (!chat) return
        const message = PiLiveChatMessageSchema.safeParse(value)
        if (message.success) thread.handle(message.data)
        else log(`pi-live: ignored an invalid ${type} message`)
        return
      }
      // commands, items, item_*, answer_result, pong and what a later pi-live adds are not read here.
    }
  }

  socket.on("data", (chunk: Buffer | string) => {
    if (done) return
    let data = typeof chunk === "string" ? Buffer.from(chunk) : chunk
    try {
      for (;;) {
        const at = data.indexOf(0x0a)
        if (at < 0) break
        if (chunked + at > maxLine) return tooLong()
        chunks.push(data.subarray(0, at))
        const line = Buffer.concat(chunks).toString("utf8")
        chunks = []
        chunked = 0
        data = data.subarray(at + 1)
        if (line.trim() !== "") onLine(line)
        if (done) return
      }
      if (data.length > 0) {
        chunks.push(data)
        chunked += data.length
        if (chunked > maxLine) tooLong()
      }
    } catch (error) {
      // Whatever a connection does, it must not take the backend down with it.
      log(`pi-live: closing a connection after an error: ${error instanceof Error ? error.message : String(error)}`)
      end("error")
    }
  })

  function tooLong(): void {
    chunks = []
    chunked = 0
    log(`pi-live: a line from pi was longer than ${maxLine} bytes; closing the connection`)
    end("line too long")
  }

  socket.on("close", () => end(shutdown !== null ? `pi said goodbye (${shutdown})` : "closed"))
  socket.on("error", () => end("error"))

  try {
    write({ type: "hello", protocol: PI_LIVE_PROTOCOL, client: { name: options.clientName ?? "herdr-web" }, chat: true })
  } catch (error) {
    end(String(error))
  }

  return { ready, closed, close: () => end("closed by the backend") }
}
