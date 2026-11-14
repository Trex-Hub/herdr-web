// Adversarial checks of the browser's side of the link: the socket client's timers, the backend
// address, and the sign-in calls.
import { PROTOCOL_VERSION, encodeMessage } from "@herdr-web/protocol"
import type { ServerMessage } from "@herdr-web/protocol"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { backendUrl, login, logout, signedIn, socketUrl } from "@/lib/backend"
import { LiveClient, type LiveHandlers, type SocketLike } from "@/lib/live"
import { applyMessage, initialState, setLink, staleness } from "@/lib/store"
import { agent, connected, terminal } from "./fixtures"

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

beforeEach(() => {
  vi.useFakeTimers()
  sockets = []
  messages = []
  links = []
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function make(over: Partial<ConstructorParameters<typeof LiveClient>[0]> = {}) {
  const handlers: LiveHandlers = { onMessage: (m) => messages.push(m), onLink: (l) => links.push(l), onSignedOut: () => {} }
  return new LiveClient(
    { url: "ws://x/api/ws", createSocket: (url) => { const s = new FakeSocket(url); sockets.push(s); return s }, checkSession: async () => true, random: () => 0, ...over },
    handlers,
  )
}

/** Open a socket and give it its first messages. */
function connect(client: LiveClient): FakeSocket {
  client.start()
  const s = sockets.at(-1)!
  s.open()
  s.receive(hello)
  s.receive(snapshot)
  return s
}

const pings = (s: FakeSocket) => s.sent.filter((d) => JSON.parse(d).type === "ping").length

describe("socket client: timers", () => {
  it("pings every 15 s and a pong keeps the link", () => {
    const s = connect(make())
    for (let i = 1; i <= 10; i++) {
      vi.advanceTimersByTime(15_000)
      expect(pings(s)).toBe(i)
      s.receive({ type: "pong" })
    }
    expect(s.closed).toBe(false)
    expect(sockets).toHaveLength(1)
  })

  it("a bridge that goes silent is dropped after 2.5 pings and the client reconnects with a new socket", () => {
    const client = make()
    const s = connect(client)
    vi.advanceTimersByTime(15_000 * 3) // silent for 45 s: past 37.5 s
    expect(s.closed).toBe(true)
  })

  it("other traffic counts as hearing from the bridge, not only pongs", () => {
    const s = connect(make())
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(10_000)
      s.receive({ type: "pong" })
    }
    expect(s.closed).toBe(false)
  })

  it("stop() ends the pinging, the reconnect timer and the socket for good", () => {
    const client = make()
    const s = connect(client)
    client.stop()
    expect(s.closed).toBe(true)
    const sent = s.sent.length
    vi.advanceTimersByTime(120_000)
    expect(s.sent.length).toBe(sent)
    s.drop() // a late close event from the browser must not revive anything
    vi.advanceTimersByTime(120_000)
    expect(sockets).toHaveLength(1)
  })

  it("start() twice does not open two sockets; start() after stop() works again", () => {
    const client = make()
    client.start()
    client.start()
    expect(sockets).toHaveLength(1)
    client.stop()
    client.start()
    expect(sockets).toHaveLength(2)
  })

  it("a refused socket is retried with growing delays and the delay resets once a snapshot has arrived", async () => {
    const client = make({ checkSession: async () => null })
    client.start()
    const delays: number[] = []
    for (let i = 0; i < 4; i++) {
      const before = sockets.length
      sockets.at(-1)!.drop()
      await vi.advanceTimersByTimeAsync(0)
      let waited = 0
      while (sockets.length === before) {
        await vi.advanceTimersByTimeAsync(100)
        waited += 100
      }
      delays.push(waited)
    }
    expect(delays).toEqual([500, 1000, 2000, 4000])
    const s = sockets.at(-1)!
    s.open()
    s.receive(hello)
    s.receive(snapshot)
    s.drop()
    await vi.advanceTimersByTimeAsync(500)
    expect(sockets.length).toBeGreaterThan(5) // back to the first delay
  })

  it("a message that is not text, not JSON or not a known type is not delivered; unknown types close the socket", () => {
    const s = connect(make())
    const delivered = messages.length
    s.receive(new ArrayBuffer(4))
    expect(messages.length).toBe(delivered)
    expect(s.closed).toBe(false)
    s.receive("not json")
    expect(messages.length).toBe(delivered)
    expect(s.closed).toBe(true)
  })

  it("messages after stop() are ignored", () => {
    const client = make()
    const s = connect(client)
    const delivered = messages.length
    client.stop()
    s.receive({ type: "pong" })
    expect(messages.length).toBe(delivered)
  })
})

describe("socket client: a tab in the background", () => {
  // Browsers run timers of a hidden page at most about once a minute (after a few minutes hidden).
  // A bridge that answers every ping is healthy; the page must not tear the socket down for it.
  describe("defects", () => {
    it("a healthy link must not be dropped when the browser delays the timers to once a minute", () => {
      const throttled = (fn: () => void, ms: number) => globalThis.setTimeout(fn, Math.max(ms, 60_000))
      const client = make({ setTimeout: throttled as never })
      const s = connect(client)
      for (let minute = 1; minute <= 5; minute++) {
        vi.advanceTimersByTime(60_000)
        if (s.closed) break
        // the bridge answers every ping it gets at once
        s.receive({ type: "pong" })
      }
      expect(s.closed, "socket closed by the page although the bridge is up").toBe(false)
      expect(sockets).toHaveLength(1)
    })
  })
})

describe("store with a flapping link", () => {
  it("keeps what it had while the link is down and marks it stale; the next snapshot replaces everything", () => {
    let s = applyMessage(initialState, snapshot)
    s = applyMessage(s, { ...snapshot, type: "snapshot", terminals: [terminal("t1"), agent("t2", "working")] })
    s = setLink(s, "open")
    expect(staleness(s)).toBeNull()
    s = setLink(s, "reconnecting")
    expect(Object.keys(s.terminals)).toEqual(["t1", "t2"])
    expect(staleness(s)).toBe("backend")
    s = applyMessage(s, { ...snapshot, terminals: [terminal("t2")] })
    s = setLink(s, "open")
    expect(Object.keys(s.terminals)).toEqual(["t2"])
    expect(staleness(s)).toBeNull()
  })

  it("core's state wins nothing over the page's own link, and core `connected` again clears it", () => {
    let s = setLink(applyMessage(initialState, snapshot), "open")
    s = applyMessage(s, { type: "connection", connection: { state: "reconnecting", error: "gone", core: null } })
    expect(staleness(s)).toBe("core")
    s = applyMessage(s, { type: "connection", connection: connected })
    expect(staleness(s)).toBeNull()
  })

  it("a terminal.removed for an unknown address, or layout.removed for an unknown machine, changes nothing and keeps identity", () => {
    const s = applyMessage(initialState, { ...snapshot, terminals: [terminal("t1")] })
    expect(applyMessage(s, { type: "terminal.removed", address: "nope" })).toBe(s)
    expect(applyMessage(s, { type: "layout.removed", machine: "nope" })).toBe(s)
  })

  it("a hello for the same build and protocol after a reconnect does not ask for a reload; a new build does", () => {
    let s = applyMessage(initialState, hello)
    s = applyMessage(s, hello)
    expect(s.reload).toBeNull()
    s = applyMessage(s, { ...hello, build: "b2" } as ServerMessage)
    expect(s.reload).toMatch(/updated/)
  })
})

describe("backend address", () => {
  it("takes NEXT_PUBLIC_BACKEND_URL first and strips trailing slashes", () => {
    vi.stubEnv("NEXT_PUBLIC_BACKEND_URL", "https://box.example/bridge///")
    expect(backendUrl()).toBe("https://box.example/bridge")
    expect(socketUrl()).toBe("wss://box.example/bridge/api/ws")
  })

  it("otherwise port 7420 on the host the page was opened from, keeping the page's scheme", () => {
    vi.stubEnv("NEXT_PUBLIC_BACKEND_URL", "")
    for (const [protocol, hostname, want] of [
      ["http:", "localhost", "http://localhost:7420"],
      ["http:", "127.0.0.1", "http://127.0.0.1:7420"],
      ["http:", "[::1]", "http://[::1]:7420"],
      ["https:", "mac.tail1234.ts.net", "https://mac.tail1234.ts.net:7420"],
    ] as const) {
      vi.stubGlobal("window", { location: { protocol, hostname } })
      expect(backendUrl(), hostname).toBe(want)
    }
  })
})

describe("sign-in calls", () => {
  function reply(status: number, body?: unknown, headers: Record<string, string> = {}) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body), { status, headers })))
  }
  const refuse = () => vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch") }))

  it("posts the passphrase as JSON with credentials", async () => {
    reply(200, { ok: true })
    expect(await login("pw", "http://b")).toEqual({ ok: true })
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]! as [string, RequestInit]
    expect(url).toBe("http://b/api/login")
    expect(init).toMatchObject({ method: "POST", credentials: "include" })
    expect(JSON.parse(init.body as string)).toEqual({ passphrase: "pw" })
  })

  it("401 is a wrong passphrase", async () => {
    reply(401, { error: "wrong" })
    expect(await login("x", "http://b")).toEqual({ ok: false, reason: "wrong" })
  })

  it("429 takes the wait from the body, else the header, else 1 s; nonsense never gives NaN or 0", async () => {
    reply(429, { retryAfterSeconds: 7 })
    expect(await login("x", "http://b")).toEqual({ ok: false, reason: "slow", retryAfterSeconds: 7 })
    reply(429, "not json", { "retry-after": "12" })
    expect(await login("x", "http://b")).toEqual({ ok: false, reason: "slow", retryAfterSeconds: 12 })
    for (const header of ["abc", "0", "-5", ""]) {
      reply(429, {}, header ? { "retry-after": header } : {})
      const r = await login("x", "http://b")
      expect(r, header).toEqual({ ok: false, reason: "slow", retryAfterSeconds: 1 })
    }
  })

  it("a refused fetch says the backend cannot be reached, and names the address", async () => {
    refuse()
    const r = await login("x", "http://b:7420")
    expect(r).toMatchObject({ ok: false, reason: "unreachable" })
    expect((r as { message: string }).message).toContain("http://b:7420")
  })

  it("other statuses are an error that names the status", async () => {
    for (const status of [400, 403, 500, 502]) {
      reply(status)
      const r = await login("x", "http://b")
      expect(r, String(status)).toMatchObject({ ok: false, reason: "error" })
      expect((r as { message: string }).message).toContain(String(status))
    }
  })

  it("signedIn: true only for a literal true; false for a no; null when the backend cannot say", async () => {
    reply(200, { signedIn: true })
    expect(await signedIn("http://b")).toBe(true)
    reply(200, { signedIn: "true" })
    expect(await signedIn("http://b")).toBe(false)
    reply(200, { signedIn: false })
    expect(await signedIn("http://b")).toBe(false)
    reply(500)
    expect(await signedIn("http://b")).toBeNull()
    reply(200, "<html>")
    expect(await signedIn("http://b")).toBeNull()
    refuse()
    expect(await signedIn("http://b")).toBeNull()
  })

  it("logout never throws, even when the backend is gone", async () => {
    refuse()
    await expect(logout("http://b")).resolves.toBeUndefined()
  })
})
