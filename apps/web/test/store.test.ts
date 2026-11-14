import { PROTOCOL_VERSION } from "@herdr-web/protocol"
import type { ServerMessage } from "@herdr-web/protocol"
import { describe, expect, it } from "vitest"
import { applyMessage, initialState, setLink, staleness, Store, type LiveState } from "@/lib/store"
import { connected, layout, machine, term, terminal } from "./fixtures"

const snapshot = (over: Partial<Extract<ServerMessage, { type: "snapshot" }>> = {}): ServerMessage => ({
  type: "snapshot",
  connection: connected,
  terminals: [terminal("t1"), terminal("t2", { state: "finished" })],
  machines: [machine("cachyos")],
  layouts: [layout(null, [{ id: "s1", tabs: [{ id: "tb1", panes: [term("t1")] }] }]), layout("cachyos", [])],
  ...over,
})
const apply = (state: LiveState, ...messages: ServerMessage[]) => messages.reduce(applyMessage, state)

describe("store: snapshot", () => {
  it("starts empty and not ready", () => {
    expect(initialState).toMatchObject({ ready: false, link: "connecting", connection: null, terminals: {}, machines: [], layouts: {} })
  })

  it("a snapshot fills everything, finished terminals included, layouts keyed by machine", () => {
    const s = apply(initialState, snapshot())
    expect(s.ready).toBe(true)
    expect(Object.keys(s.terminals)).toEqual(["t1", "t2"])
    expect(s.machines.map((m) => m.name)).toEqual(["cachyos"])
    expect(Object.keys(s.layouts).sort()).toEqual(["", "cachyos"])
    expect(s.connection).toEqual(connected)
  })

  it("a second snapshot replaces what was there (no resume, no merge)", () => {
    const first = apply(initialState, snapshot())
    const second = apply(first, snapshot({ terminals: [terminal("t9")], machines: [], layouts: [] }))
    expect(Object.keys(second.terminals)).toEqual(["t9"])
    expect(second.machines).toEqual([])
    expect(second.layouts).toEqual({})
  })
})

describe("store: changes", () => {
  const base = apply(initialState, snapshot())

  it("terminal adds a terminal and replaces a changed one", () => {
    const added = apply(base, { type: "terminal", terminal: terminal("t3") })
    expect(Object.keys(added.terminals)).toEqual(["t1", "t2", "t3"])
    const changed = apply(added, { type: "terminal", terminal: terminal("t1", { title: "hello" }) })
    expect(changed.terminals["t1"]?.title).toBe("hello")
    expect(base.terminals["t1"]?.title).toBe("") // the old state is untouched
  })

  it("terminal.removed drops it, and an unknown address changes nothing", () => {
    expect(Object.keys(apply(base, { type: "terminal.removed", address: "t1" }).terminals)).toEqual(["t2"])
    expect(apply(base, { type: "terminal.removed", address: "t404" })).toBe(base)
  })

  it("machines replaces the list", () => {
    const s = apply(base, { type: "machines", machines: [machine("cachyos", "unreachable", "timed out"), machine("devserver")] })
    expect(s.machines.map((m) => [m.name, m.state])).toEqual([["cachyos", "unreachable"], ["devserver", "connected"]])
  })

  it("layout replaces one machine's layout and leaves the others", () => {
    const before = base.layouts[""]
    const s = apply(base, { type: "layout", layout: layout("cachyos", [{ id: "sp", tabs: [] }]) })
    expect(s.layouts["cachyos"]?.spaces.map((x) => x.id)).toEqual(["sp"])
    expect(s.layouts[""]).toBe(before)
  })

  it("layout.removed drops one machine's layout; the core's own is key null", () => {
    expect(Object.keys(apply(base, { type: "layout.removed", machine: "cachyos" }).layouts)).toEqual([""])
    expect(Object.keys(apply(base, { type: "layout.removed", machine: null }).layouts)).toEqual(["cachyos"])
    expect(apply(base, { type: "layout.removed", machine: "nope" })).toBe(base)
  })

  it("connection replaces the backend's state, keeping the data", () => {
    const s = apply(base, { type: "connection", connection: { state: "reconnecting", error: "cannot connect", core: null } })
    expect(s.connection?.state).toBe("reconnecting")
    expect(Object.keys(s.terminals)).toEqual(["t1", "t2"])
  })

  it("pong changes nothing", () => {
    expect(apply(base, { type: "pong" })).toBe(base)
  })

  it("snapshot then a run of changes ends where core is", () => {
    const s = apply(
      initialState,
      snapshot(),
      { type: "terminal", terminal: terminal("t3") },
      { type: "terminal", terminal: terminal("t3", { labels: { "herdr.seen": "1" } }) },
      { type: "terminal.removed", address: "t1" },
      { type: "terminal", terminal: terminal("t2", { state: "live" }) },
    )
    expect(Object.values(s.terminals).map((t) => [t.address, t.state, t.labels["herdr.seen"] ?? null])).toEqual([["t2", "live", null], ["t3", "live", "1"]])
  })
})

describe("store: version and build", () => {
  it("a hello with this protocol version and a first build is fine and remembers the build", () => {
    const s = apply(initialState, { type: "hello", protocol: PROTOCOL_VERSION, build: "abc" })
    expect(s).toMatchObject({ reload: null, loadedBuild: "abc" })
  })

  it("a different protocol version asks for a reload", () => {
    expect(apply(initialState, { type: "hello", protocol: PROTOCOL_VERSION + 1, build: "abc" }).reload).toMatch(/protocol/)
  })

  it("the same build after a reconnect is fine; another build asks for a reload", () => {
    const first = apply(initialState, { type: "hello", protocol: PROTOCOL_VERSION, build: "abc" })
    expect(apply(first, { type: "hello", protocol: PROTOCOL_VERSION, build: "abc" })).toBe(first)
    expect(apply(first, { type: "hello", protocol: PROTOCOL_VERSION, build: "def" }).reload).toMatch(/updated/)
  })
})

describe("store: staleness", () => {
  const ready = apply(initialState, snapshot())
  it("is current when the link is open and the backend is connected to core", () => {
    expect(staleness(setLink(ready, "open"))).toBeNull()
  })
  it("blames the backend link first", () => {
    expect(staleness(setLink(ready, "reconnecting"))).toBe("backend")
    expect(staleness(setLink(initialState, "connecting"))).toBe("backend")
    const coreDown = apply(setLink(ready, "reconnecting"), { type: "connection", connection: { state: "reconnecting", error: null, core: null } })
    expect(staleness(coreDown)).toBe("backend")
  })
  it("blames core when only the backend's connection to it is down", () => {
    const s = apply(setLink(ready, "open"), { type: "connection", connection: { state: "reconnecting", error: "x", core: null } })
    expect(staleness(s)).toBe("core")
  })
  it("setLink returns the same state when nothing changes", () => {
    expect(setLink(ready, ready.link)).toBe(ready)
  })
})

describe("Store", () => {
  it("notifies subscribers on change only, and stops after unsubscribe", () => {
    const store = new Store(1)
    let calls = 0
    const off = store.subscribe(() => calls++)
    store.setState((n) => n)
    expect(calls).toBe(0)
    store.setState((n) => n + 1)
    expect([calls, store.getState()]).toEqual([1, 2])
    off()
    store.setState((n) => n + 1)
    expect(calls).toBe(1)
  })
})
