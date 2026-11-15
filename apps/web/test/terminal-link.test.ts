import { Tag, tagMessage, TerminalClose } from "@herdr-web/protocol"
import { describe, expect, it } from "vitest"
import { TerminalLink, type LinkState, type TerminalSocketLike } from "../src/lib/terminal/link"

class FakeSocket implements TerminalSocketLike {
  binaryType = "blob"
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: ((e: { code: number; reason: string }) => void) | null = null
  onerror: (() => void) | null = null
  sent: Array<string | Uint8Array> = []
  closedWith: number | undefined
  send(d: string | Uint8Array) {
    this.sent.push(d)
  }
  close(code?: number) {
    this.closedWith = code
    this.readyState = 3
  }
  // test helpers
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  text(m: unknown) {
    this.onmessage?.({ data: typeof m === "string" ? m : JSON.stringify(m) })
  }
  out(bytes: string | Uint8Array) {
    const b = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes
    const msg = tagMessage(Tag.OUTPUT, b)
    this.onmessage?.({ data: msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.byteLength) })
  }
  drop(code = 1006, reason = "") {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
  get texts() {
    return this.sent.filter((s): s is string => typeof s === "string").map((s) => JSON.parse(s))
  }
  get binaries() {
    return this.sent.filter((s): s is Uint8Array => typeof s !== "string")
  }
}

const display = { fg: null, bg: null, cursor: null, cell: null }

function setup(extra: { flushBytes?: number } = {}) {
  const sockets: FakeSocket[] = []
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = []
  const states: LinkState[] = []
  const attaches: Array<{ cols: number; rows: number; again: boolean }> = []
  const outputs: Array<{ bytes: string; parsed: () => void }> = []
  const link = new TerminalLink(
    {
      url: "ws://x/api/terminal/t7",
      attach: () => ({ cols: 80, rows: 24, history: 10000, display }),
      createSocket: () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
      setTimeout: (fn, ms) => {
        const t = { fn, ms, live: true }
        timers.push(t)
        return t
      },
      clearTimeout: (h) => {
        ;(h as { live: boolean }).live = false
      },
      random: () => 0,
      ...extra,
    },
    {
      onState: (s) => states.push(s),
      onAttached: (i) => attaches.push({ cols: i.cols, rows: i.rows, again: i.again }),
      onOutput: (b, parsed) => outputs.push({ bytes: new TextDecoder().decode(b), parsed }),
    },
  )
  const fire = (ms?: number) => {
    const t = timers.find((x) => x.live && (ms === undefined || x.ms === ms))
    if (!t) throw new Error("no timer")
    t.live = false
    t.fn()
  }
  const attach = (s: FakeSocket) => {
    s.open()
    s.text({ type: "attached", cols: 80, rows: 24, automaticInput: true })
  }
  return { link, sockets, states, attaches, outputs, timers, fire, attach }
}

describe("attaching", () => {
  it("sends attach first thing when the socket opens, and is live once told so", () => {
    const { link, sockets, states, attach, attaches } = setup()
    link.start()
    expect(states).toEqual([{ kind: "connecting" }])
    const s = sockets[0]!
    expect(s.binaryType).toBe("arraybuffer")
    s.open()
    expect(s.texts).toEqual([{ type: "attach", cols: 80, rows: 24, history: 10000, display }])
    expect(link.live).toBe(false)
    attach(s)
    expect(link.live).toBe(true)
    expect(states.at(-1)).toEqual({ kind: "live" })
    expect(attaches).toEqual([{ cols: 80, rows: 24, again: false }])
  })
})

describe("input", () => {
  it("tags human input 1 and automatic replies 2, and drops both unless attached", () => {
    const { link, sockets, attach } = setup()
    link.start()
    const s = sockets[0]!
    s.open()
    expect(link.sendInput(Uint8Array.from([0x61]))).toBe(false) // not attached yet
    expect(s.binaries).toEqual([])
    s.text({ type: "attached", cols: 80, rows: 24, automaticInput: true })
    expect(link.sendInput(Uint8Array.from([0x61, 0x62]))).toBe(true)
    expect(link.sendAutomatic(Uint8Array.from([0x1b, 0x5b, 0x63]))).toBe(true)
    expect(link.sendInput(new Uint8Array())).toBe(false)
    expect(s.binaries.map((b) => [...b])).toEqual([
      [Tag.INPUT, 0x61, 0x62],
      [Tag.AUTOMATIC, 0x1b, 0x5b, 0x63],
    ])
  })

  it("sends resize, focus and display only while attached", () => {
    const { link, sockets, attach } = setup()
    link.start()
    const s = sockets[0]!
    s.open()
    link.resize(100, 30)
    s.text({ type: "attached", cols: 80, rows: 24, automaticInput: true })
    link.resize(120, 40)
    link.focus(true)
    link.display({ ...display, fg: "#ffffff" })
    expect(s.texts.slice(1)).toEqual([
      { type: "resize", cols: 120, rows: 40 },
      { type: "focus", focused: true },
      { type: "display", display: { ...display, fg: "#ffffff" } },
    ])
  })
})

describe("flow control", () => {
  it("reports consumed bytes only when the emulator says it parsed them, batched", () => {
    const { link, sockets, attach, outputs, fire, timers } = setup({ flushBytes: 1000 })
    link.start()
    const s = sockets[0]!
    attach(s)
    s.out("hello")
    expect(outputs.map((o) => o.bytes)).toEqual(["hello"])
    expect(s.texts.filter((t) => t.type === "consumed")).toEqual([]) // nothing yet: not parsed
    outputs[0]!.parsed()
    s.out("world!")
    outputs[1]!.parsed()
    expect(s.texts.filter((t) => t.type === "consumed")).toEqual([]) // owed, waiting for the short timer
    expect(timers.some((t) => t.live)).toBe(true)
    fire(8)
    expect(s.texts.filter((t) => t.type === "consumed")).toEqual([{ type: "consumed", bytes: 11 }])
  })

  it("flushes at once when enough is owed", () => {
    const { link, sockets, attach, outputs } = setup({ flushBytes: 10 })
    link.start()
    const s = sockets[0]!
    attach(s)
    s.out("0123456789ab")
    outputs[0]!.parsed()
    expect(s.texts.filter((t) => t.type === "consumed")).toEqual([{ type: "consumed", bytes: 12 }])
  })

  it("ignores a parsed callback that belongs to a socket that is gone", () => {
    const { link, sockets, attach, outputs, fire } = setup({ flushBytes: 1 })
    link.start()
    const first = sockets[0]!
    attach(first)
    first.out("abc")
    first.drop(1006)
    fire() // reconnect timer
    const second = sockets[1]!
    attach(second)
    outputs[0]!.parsed() // the old write finishing late
    expect(second.texts.filter((t) => t.type === "consumed")).toEqual([])
  })

  it("never sends a consumed that is not for bytes of this socket", () => {
    const { link, sockets, attach, outputs } = setup({ flushBytes: 1 })
    link.start()
    const s = sockets[0]!
    attach(s)
    s.out("x")
    outputs[0]!.parsed()
    expect(s.texts.filter((t) => t.type === "consumed")).toHaveLength(1)
  })
})

describe("when the socket drops", () => {
  it("attaches again by itself with backoff, marks the next attach as `again`, and sends nothing meanwhile", () => {
    const { link, sockets, states, attaches, attach, fire, timers } = setup()
    link.start()
    attach(sockets[0]!)
    sockets[0]!.drop(1006)
    expect(states.at(-1)).toEqual({ kind: "reconnecting", why: null })
    expect(link.sendInput(Uint8Array.from([0x78]))).toBe(false) // typed into a dead line: dropped
    expect(timers.at(-1)!.ms).toBe(500)
    fire()
    expect(sockets).toHaveLength(2)
    attach(sockets[1]!)
    expect(states.at(-1)).toEqual({ kind: "live" })
    expect(attaches.map((a) => a.again)).toEqual([false, true])
    expect(sockets[1]!.binaries).toEqual([]) // what was typed while down never arrives
  })

  it("backs off further while it keeps failing, and starts over after a good attach", () => {
    const { link, sockets, fire, timers, attach } = setup()
    link.start()
    sockets[0]!.drop(1006)
    expect(timers.at(-1)!.ms).toBe(500)
    fire()
    sockets[1]!.drop(1006)
    expect(timers.at(-1)!.ms).toBe(1000)
    fire()
    sockets[2]!.drop(1006)
    expect(timers.at(-1)!.ms).toBe(2000)
    fire()
    attach(sockets[3]!)
    sockets[3]!.drop(1006)
    expect(timers.at(-1)!.ms).toBe(500)
  })

  it("after five failed attempts in a row it says it cannot connect, keeps retrying at the slow end, and goes back to normal after an attach", () => {
    const { link, sockets, states, fire, timers, attach } = setup()
    link.start()
    for (let i = 0; i < 4; i++) {
      sockets[i]!.drop(1006)
      expect(states.at(-1)).toMatchObject({ kind: "reconnecting" })
      fire()
    }
    sockets[4]!.drop(1006)
    expect(states.at(-1)).toEqual({ kind: "unreachable", why: null })
    expect(timers.at(-1)!.ms).toBeGreaterThanOrEqual(8000)
    fire()
    sockets[5]!.drop(1006)
    expect(states.at(-1)).toMatchObject({ kind: "unreachable" })
    expect(timers.at(-1)!.ms).toBeGreaterThanOrEqual(8000)
    fire()
    attach(sockets[6]!)
    expect(states.at(-1)).toEqual({ kind: "live" })
    sockets[6]!.drop(1006)
    expect(states.at(-1)).toMatchObject({ kind: "reconnecting" })
  })

  it("retries after 4502 (core unreachable) and 4413 (too slow), with the reason", () => {
    const { link, sockets, states, fire } = setup()
    link.start()
    sockets[0]!.drop(TerminalClose.CORE_UNAVAILABLE, "core cannot be reached")
    expect(states.at(-1)).toEqual({ kind: "reconnecting", why: "core cannot be reached" })
    fire()
    sockets[1]!.drop(TerminalClose.TOO_SLOW, "behind")
    expect(states.at(-1)).toMatchObject({ kind: "reconnecting" })
  })

  it("stops for good on 4404 and on a protocol close", () => {
    for (const code of [TerminalClose.NOT_FOUND, TerminalClose.PROTOCOL]) {
      const { link, sockets, states, timers } = setup()
      link.start()
      sockets[0]!.drop(code, "no such terminal")
      expect(states.at(-1)).toEqual({ kind: "gone", why: "no such terminal" })
      expect(timers.filter((t) => t.live)).toEqual([])
    }
  })
})

describe("the terminal ending", () => {
  it("reports how, does not reconnect, and a late close changes nothing", () => {
    const { link, sockets, states, attach, timers } = setup()
    link.start()
    const s = sockets[0]!
    attach(s)
    s.text({ type: "ended", reason: "exited", exitCode: 3, signal: null })
    s.drop(TerminalClose.ENDED, "exited")
    expect(states.at(-1)).toEqual({ kind: "ended", reason: "exited", exitCode: 3, signal: null })
    expect(timers.filter((t) => t.live)).toEqual([])
    expect(sockets).toHaveLength(1)
  })

  it("also when the close is 4410 after an `ended`", () => {
    const { link, sockets, states, attach } = setup()
    link.start()
    const s = sockets[0]!
    attach(s)
    s.text({ type: "ended", reason: "killed", exitCode: null, signal: 9 })
    s.drop(TerminalClose.FINISHED, "finished")
    expect(states.at(-1)).toEqual({ kind: "ended", reason: "killed", exitCode: null, signal: 9 })
  })
})

describe("bad data from the bridge", () => {
  it("drops the socket and tries again for an invalid text message, binary before attached, or the wrong tag", () => {
    for (const bad of [(s: FakeSocket) => s.text("{"), (s: FakeSocket) => s.text({ type: "nope" }), (s: FakeSocket) => s.out("x")]) {
      const { link, sockets, states } = setup()
      link.start()
      const s = sockets[0]!
      s.open()
      bad(s)
      expect(s.closedWith).toBe(4400)
      expect(states.at(-1)).toMatchObject({ kind: "reconnecting" })
    }
  })
})

describe("stop", () => {
  it("closes the socket, and nothing it says afterwards matters", () => {
    const { link, sockets, states, attach, timers, outputs } = setup()
    link.start()
    const s = sockets[0]!
    attach(s)
    const before = states.length
    link.stop()
    expect(s.closedWith).toBe(1000)
    s.out("late")
    s.drop(1006)
    expect(outputs).toEqual([])
    expect(states).toHaveLength(before)
    expect(timers.filter((t) => t.live)).toEqual([])
    expect(link.sendInput(Uint8Array.from([1]))).toBe(false)
  })

  it("can be started again", () => {
    const { link, sockets } = setup()
    link.start()
    link.stop()
    link.start()
    expect(sockets).toHaveLength(2)
  })
})
