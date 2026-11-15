import { PROTOCOL_VERSION, encodeMessage } from "@herdr-web/protocol"
import type { ServerMessage } from "@herdr-web/protocol"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { socketUrl } from "@/lib/backend"
import { backoffMs, LiveClient, type LiveHandlers, type SocketLike } from "@/lib/live"
import { connected } from "./fixtures"

class FakeSocket implements SocketLike {
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []
  closed = false
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
  }
  open(): void {
    this.readyState = 1
    this.onopen?.()
  }
  receive(m: ServerMessage | string | ArrayBuffer): void {
    this.onmessage?.({ data: typeof m === "string" || m instanceof ArrayBuffer ? m : encodeMessage(m) })
  }
  drop(): void {
    this.readyState = 3
    this.onclose?.({ code: 1006 })
  }
}

const hello: ServerMessage = { type: "hello", protocol: PROTOCOL_VERSION, build: "b1" }
const snapshot: ServerMessage = { type: "snapshot", connection: connected, terminals: [], machines: [], layouts: [] }

let sockets: FakeSocket[]
let messages: ServerMessage[]
let links: string[]
let signedOut: number
let session: boolean | null

beforeEach(() => {
  vi.useFakeTimers()
  sockets = []
  messages = []
  links = []
  signedOut = 0
  session = true
})
afterEach(() => vi.useRealTimers())

function make(over: Partial<ConstructorParameters<typeof LiveClient>[0]> = {}) {
  const handlers: LiveHandlers = {
    onMessage: (m) => messages.push(m),
    onLink: (l) => links.push(l),
    onSignedOut: () => signedOut++,
  }
  return new LiveClient(
    { url: "ws://x/api/ws", createSocket: (url) => { const s = new FakeSocket(url); sockets.push(s); return s }, checkSession: async () => session, random: () => 0, ...over },
    handlers,
  )
}
const last = () => sockets.at(-1)!

describe("backoffMs", () => {
  it("doubles from 0.5 s to a cap of 10 s, with up to 25% jitter", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map((n) => backoffMs(n, () => 0))).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000, 10000])
    expect(backoffMs(0, () => 1)).toBe(625)
    expect(backoffMs(9, () => 1)).toBe(12500)
  })
})

describe("socketUrl", () => {
  it("turns the backend address into the main socket's", () => {
    expect(socketUrl("http://localhost:7420")).toBe("ws://localhost:7420/api/ws")
    expect(socketUrl("https://box.ts.net/bridge")).toBe("wss://box.ts.net/bridge/api/ws")
  })
})

describe("LiveClient", () => {
  it("connects, passes valid messages on, and counts the link open at the snapshot", () => {
    make().start()
    expect(links).toEqual(["connecting"])
    last().open()
    last().receive(hello)
    expect(links).toEqual(["connecting"])
    last().receive(snapshot)
    expect(links).toEqual(["connecting", "open"])
    expect(messages.map((m) => m.type)).toEqual(["hello", "snapshot"])
  })

  it("closes a socket that sends something invalid, and ignores binary frames", () => {
    make().start()
    last().open()
    last().receive(new ArrayBuffer(4))
    expect(last().closed).toBe(false)
    last().receive('{"type":"teleport"}')
    expect(last().closed).toBe(true)
    expect(messages).toEqual([])
  })

  it("reconnects after a drop with backoff, and starts again from a snapshot", () => {
    make().start()
    last().open()
    last().receive(snapshot)
    last().drop()
    expect(links.at(-1)).toBe("reconnecting")
    expect(sockets).toHaveLength(1)
    vi.advanceTimersByTime(499)
    expect(sockets).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(2)
    last().drop() // never opened: asks the backend whether we are signed in, then waits longer
    return Promise.resolve().then(async () => {
      await vi.advanceTimersByTimeAsync(999)
      expect(sockets).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(sockets).toHaveLength(3)
      last().open()
      last().receive(hello)
      last().receive(snapshot)
      expect(links.at(-1)).toBe("open")
    })
  })

  it("the backoff starts over once a snapshot has arrived", async () => {
    make().start()
    last().open()
    last().receive(snapshot)
    last().drop()
    await vi.advanceTimersByTimeAsync(500)
    last().open()
    last().receive(snapshot)
    last().drop()
    await vi.advanceTimersByTimeAsync(500) // 0.5 s again, not 1 s
    expect(sockets).toHaveLength(3)
  })

  it("says reconnecting, not connecting, for every attempt after the first success", async () => {
    make().start()
    last().open()
    last().receive(snapshot)
    last().drop()
    await vi.advanceTimersByTimeAsync(500)
    expect(links).toEqual(["connecting", "open", "reconnecting", "reconnecting"])
  })

  it("a socket that never opens while signed out stops retrying and reports it", async () => {
    session = false
    make().start()
    last().drop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(signedOut).toBe(1)
    expect(sockets).toHaveLength(1)
  })

  it("a socket that never opens while still signed in, or with the backend unreachable, keeps retrying", async () => {
    for (const s of [true, null] as const) {
      sockets.length = 0
      session = s
      const client = make()
      client.start()
      last().drop()
      await vi.advanceTimersByTimeAsync(600)
      expect(sockets).toHaveLength(2)
      client.stop()
    }
    expect(signedOut).toBe(0)
  })

  it("a drop after the socket had opened does not ask about the session", async () => {
    const checks = vi.fn(async () => false as boolean | null)
    make({ checkSession: checks }).start()
    last().open()
    last().drop()
    await vi.advanceTimersByTimeAsync(600)
    expect(checks).not.toHaveBeenCalled()
    expect(sockets).toHaveLength(2)
  })

  it("keeps retrying when the socket cannot even be created", async () => {
    let n = 0
    make({ createSocket: (url) => { if (n++ === 0) throw new Error("bad url"); const s = new FakeSocket(url); sockets.push(s); return s } }).start()
    expect(sockets).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(500)
    expect(sockets).toHaveLength(1)
  })

  it("stop closes the socket and nothing reconnects or reports afterwards", async () => {
    const client = make()
    client.start()
    const s = last()
    s.open()
    client.stop()
    expect(s.closed).toBe(true)
    s.drop()
    s.receive(snapshot)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sockets).toHaveLength(1)
    expect(messages).toEqual([])
  })

  it("pings on every tick and drops a socket whose last ping got no answer by the next tick", async () => {
    make({ pingMs: 1000 }).start()
    last().open()
    await vi.advanceTimersByTimeAsync(1000)
    expect(last().sent).toEqual(['{"type":"ping"}'])
    last().receive({ type: "pong" })
    await vi.advanceTimersByTimeAsync(1000) // answered: pinged again
    expect(last().sent).toHaveLength(2)
    expect(last().closed).toBe(false)
    await vi.advanceTimersByTimeAsync(900) // the second ping has had no answer yet, but the next tick has not come
    expect(last().closed).toBe(false)
    await vi.advanceTimersByTimeAsync(100) // next tick: nothing heard since the ping
    expect(last().closed).toBe(true)
  })
})

describe("send", () => {
  it("writes a message on the open socket and says so", () => {
    const client = make()
    client.start()
    expect(client.send({ type: "chat.subscribe", terminal: "t1" })).toBe(false) // not open yet: nothing is queued
    last().open()
    expect(client.send({ type: "chat.subscribe", terminal: "t1" })).toBe(true)
    expect(last().sent).toEqual([JSON.stringify({ type: "chat.subscribe", terminal: "t1" })])
  })
  it("sends nothing after the socket dropped or the client stopped", () => {
    const client = make()
    client.start()
    last().open()
    last().drop()
    expect(client.send({ type: "ping" })).toBe(false)
    client.stop()
    expect(client.send({ type: "ping" })).toBe(false)
  })
})
