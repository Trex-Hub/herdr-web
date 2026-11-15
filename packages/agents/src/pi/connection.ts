// The one entry point for the backend: hand over each connection accepted on the agents socket.
import type { Duplex } from "node:stream"
import type { z } from "zod"
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
  /**
   * Asked once a hello has been read and before anything is opened: a sentence refuses the connection with it (the extension
   * then waits a long time before it asks again), null lets it in.
   */
  admit?: (hello: z.infer<typeof HelloSchema>) => string | null
}

let accepted = 0

export interface AgentConnection {
  /** 1, 2, 3, … in the order connections were accepted: of two for one terminal, the higher is the newer. */
  readonly order: number
  /** The process id the extension said it runs in, once its hello was read. */
  readonly pid: number | null
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
  const order = ++accepted
  let thread: PiThread | null = null
  let pid: number | null = null
  let done = false
  let refusing = false
  // Chunks of a line still being received: joined only when its newline comes.
  let chunks: Buffer[] = []
  let chunked = 0
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
      const refusal = options.admit?.(hello.data) ?? null
      if (refusal !== null) return refuse(refusal)
      try {
        thread = new PiThread(hello.data, { send, log, ...options.thread })
      } catch (error) {
        return refuse(`the session could not be opened (${error instanceof Error ? error.message : String(error)})`)
      }
      pid = hello.data.pid
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
    let data = typeof chunk === "string" ? Buffer.from(chunk) : chunk
    try {
      for (;;) {
        const at = data.indexOf(0x0a)
        if (at < 0) break
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
      }
      if (chunked > MAX_LINE_BYTES) {
        log(`agents: a line was longer than ${MAX_LINE_BYTES} bytes; closing the connection`)
        end("line too long")
      }
    } catch (error) {
      // Whatever a connection does, it must not take the backend down with it.
      log(`agents: closing a connection after an error: ${error instanceof Error ? error.message : String(error)}`)
      end("error")
    }
  })
  socket.on("close", () => end("closed"))
  socket.on("error", () => end("error"))

  return { order, get pid() { return pid }, identified, closed, close: () => end("closed by the backend") }
}
