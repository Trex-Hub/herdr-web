// The one entry point for the backend: hand over each connection accepted on the agents socket.
import type { Duplex } from "node:stream"
import type { Thread } from "../thread.js"
import {
  ExtensionMessageSchema,
  HelloSchema,
  MAX_LINE_BYTES,
  WIRE_VERSION,
  encodeLine,
  type BackendMessage,
} from "../wire.js"
import { PiThread, type PiThreadOptions } from "./thread.js"

export interface AcceptOptions {
  /** Where one-line problems go: a refused version, a line that did not parse. */
  log?: (line: string) => void
  /** How long a new connection may take to say hello and send its first state. */
  helloTimeoutMs?: number
  thread?: Partial<Pick<PiThreadOptions, "actionTimeoutMs" | "entryWaitMs">>
}

export interface AgentConnection {
  /**
   * Resolves with the thread once the extension has said who it is and sent its state, so the
   * first snapshot is complete. Rejects when the connection was refused or ended before that.
   */
  readonly identified: Promise<Thread>
  /** Resolves when the connection has ended, for any reason. */
  readonly closed: Promise<void>
  /** End the connection (and the thread). */
  close(): void
}

export function acceptAgentConnection(socket: Duplex, options: AcceptOptions = {}): AgentConnection {
  const log = options.log ?? (() => {})
  let thread: PiThread | null = null
  let done = false
  let refusing = false
  let buffered: Buffer = Buffer.alloc(0)
  let resolveIdentified!: (t: Thread) => void
  let rejectIdentified!: (e: Error) => void
  let resolveClosed!: () => void
  const identified = new Promise<Thread>((res, rej) => {
    resolveIdentified = res
    rejectIdentified = rej
  })
  const closed = new Promise<void>((res) => {
    resolveClosed = res
  })
  identified.catch(() => {}) // a caller that only waits on `closed` must not trip over this
  let ready = false
  const helloTimer = setTimeout(() => {
    log("agents: a connection did not say hello in time; closing it")
    end("no hello")
  }, options.helloTimeoutMs ?? 5000)

  const send = (message: BackendMessage): void => {
    if (!done) socket.write(encodeLine(message))
  }

  function end(why: string): void {
    if (done) return
    done = true
    clearTimeout(helloTimer)
    if (!ready) rejectIdentified(new Error(`agent connection ended before it was ready: ${why}`))
    thread?.close()
    socket.destroy()
    resolveClosed()
  }

  function refuse(reason: string): void {
    refusing = true
    log(`agents: refused a connection: ${reason}`)
    try {
      send({ v: WIRE_VERSION, type: "refused", reason })
    } catch {
      /* the peer is gone */
    }
    // Let the refusal reach the peer before the socket goes.
    socket.end(() => end("refused"))
    setTimeout(() => end("refused"), 200).unref()
  }

  function onLine(line: string): void {
    if (refusing) return
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      if (!thread) return refuse("the first line was not JSON")
      log("agents: ignored a line that was not JSON")
      return
    }
    if (!thread) {
      const v = (value as { v?: unknown } | null)?.v
      if (v !== WIRE_VERSION) {
        return refuse(`the extension speaks wire version ${String(v)}, this backend speaks ${WIRE_VERSION}`)
      }
      const hello = HelloSchema.safeParse(value)
      if (!hello.success) return refuse(`the first line was not a valid hello (${hello.error.issues[0]?.path.join(".") || "shape"})`)
      thread = new PiThread(hello.data, { send, log, ...options.thread })
      send({ v: WIRE_VERSION, type: "welcome" })
      return
    }
    const v = (value as { v?: unknown } | null)?.v
    if (v !== WIRE_VERSION) {
      log(`agents: ignored a line with wire version ${String(v)} from terminal ${thread.terminalId}`)
      return
    }
    const parsed = ExtensionMessageSchema.safeParse(value)
    if (!parsed.success) {
      log(`agents: ignored an invalid ${String((value as { type?: unknown } | null)?.type)} message from terminal ${thread.terminalId}`)
      return
    }
    thread.handle(parsed.data)
    if (!ready && parsed.data.type === "state") {
      ready = true
      clearTimeout(helloTimer)
      resolveIdentified(thread)
    }
  }

  socket.on("data", (chunk: Buffer | string) => {
    if (done) return
    buffered = Buffer.concat([buffered, typeof chunk === "string" ? Buffer.from(chunk) : chunk])
    for (;;) {
      const at = buffered.indexOf(0x0a)
      if (at < 0) break
      const line = buffered.subarray(0, at).toString("utf8")
      buffered = buffered.subarray(at + 1)
      if (line.trim() !== "") onLine(line)
      if (done) return
    }
    if (buffered.length > MAX_LINE_BYTES) {
      log(`agents: a line was longer than ${MAX_LINE_BYTES} bytes; closing the connection`)
      end("line too long")
    }
  })
  socket.on("close", () => end("closed"))
  socket.on("error", () => end("error"))

  return { identified, closed, close: () => end("closed by the backend") }
}
