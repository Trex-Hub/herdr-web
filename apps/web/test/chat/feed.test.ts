import type { ClientMessage, ServerMessage } from "@herdr-web/protocol"
import { describe, expect, it } from "vitest"
import { ChatFeed } from "@/lib/chat/feed"
import { assistant, live, snapshot, user } from "./helpers"

function setup() {
  const sent: ClientMessage[] = []
  const feed = new ChatFeed((m) => (sent.push(m), true))
  const snap = (terminal: string, seq: number, rows = [user("u1")]): ServerMessage => ({ type: "chat.snapshot", terminal, snapshot: snapshot(rows, { seq }) })
  const update = (terminal: string, seq: number, rows = [assistant("a1")]): ServerMessage => ({ type: "chat.change", terminal, change: { type: "update", seq, rows } })
  const reset = (terminal: string, seq: number, rows = [user("n1")]): ServerMessage => ({ type: "chat.change", terminal, change: { type: "reset", seq, snapshot: snapshot(rows, { seq }) } })
  const unavailable = (terminal: string): ServerMessage => ({ type: "chat.unavailable", terminal, reason: "The agent has gone." })
  return { feed, sent, snap, update, reset, unavailable }
}
const subscribes = (sent: ClientMessage[]) => sent.filter((m) => m.type === "chat.subscribe").map((m) => (m as { terminal: string }).terminal)

describe("subscribing", () => {
  it("subscribes when watched and the main socket is open, and not before", () => {
    const { feed, sent } = setup()
    feed.watch("t1")
    expect(sent).toEqual([]) // nothing is queued while the socket is down
    feed.setOpen(true)
    expect(sent).toEqual([{ type: "chat.subscribe", terminal: "t1" }])
  })
  it("subscribes at once when the socket is already open, and shares one subscription between views", () => {
    const { feed, sent } = setup()
    feed.setOpen(true)
    const a = feed.watch("t1")
    const b = feed.watch("t1")
    expect(subscribes(sent)).toEqual(["t1"])
    a()
    expect(sent.filter((m) => m.type === "chat.unsubscribe")).toEqual([])
    b()
    expect(sent.at(-1)).toEqual({ type: "chat.unsubscribe", terminal: "t1" })
  })
  it("subscribes again to everything watched after the main socket comes back", () => {
    const { feed, sent, snap } = setup()
    feed.setOpen(true)
    feed.watch("t1")
    feed.watch("t2")
    feed.handle(snap("t1", 4))
    feed.setOpen(false)
    sent.length = 0
    feed.setOpen(true)
    expect(subscribes(sent).sort()).toEqual(["t1", "t2"])
  })
  it("stops listening to a terminal nobody watches: its messages are ignored and what it held is gone", () => {
    const { feed, snap } = setup()
    feed.setOpen(true)
    const stop = feed.watch("t1")
    feed.handle(snap("t1", 1))
    stop()
    expect(feed.entry("t1").store).toBeNull()
    feed.handle(snap("t1", 2))
    expect(feed.entry("t1").store).toBeNull()
  })
})

describe("the thread", () => {
  it("is loading until the snapshot, then ready with a store holding its rows", () => {
    const { feed, snap } = setup()
    feed.setOpen(true)
    feed.watch("t1")
    expect(feed.entry("t1")).toMatchObject({ phase: "loading", store: null })
    feed.handle(snap("t1", 3))
    const entry = feed.entry("t1")
    expect(entry.phase).toBe("ready")
    expect(entry.store!.getState().rows.map((r) => r.id)).toEqual(["u1"])
  })
  it("applies the changes that follow, in order", () => {
    const { feed, snap, update } = setup()
    feed.setOpen(true)
    feed.watch("t1")
    feed.handle(snap("t1", 3))
    feed.handle(update("t1", 4))
    expect(feed.entry("t1").store!.getState().rows.map((r) => r.id)).toEqual(["u1", "a1"])
  })
  it("asks for a new snapshot when a change is missing", () => {
    const { feed, sent, snap, update } = setup()
    feed.setOpen(true)
    feed.watch("t1")
    feed.handle(snap("t1", 3))
    sent.length = 0
    feed.handle(update("t1", 9))
    expect(sent).toEqual([{ type: "chat.subscribe", terminal: "t1" }])
  })
  it("takes a reset as a different thread, whatever its seq (a new session starts counting again)", () => {
    const { feed, snap, reset } = setup()
    feed.setOpen(true)
    feed.watch("t1")
    feed.handle(snap("t1", 40))
    const store = feed.entry("t1").store!
    const generation = store.getState().generation
    feed.handle(reset("t1", 1))
    expect(feed.entry("t1").store).toBe(store)
    expect(store.getState().rows.map((r) => r.id)).toEqual(["n1"])
    expect(store.getState().generation).toBe(generation + 1)
    expect(store.getState().seq).toBe(1)
  })
  it("a snapshot after a reconnect replaces what was held, in the same store", () => {
    const { feed, snap } = setup()
    feed.setOpen(true)
    feed.watch("t1")
    feed.handle(snap("t1", 40))
    const store = feed.entry("t1").store!
    feed.setOpen(false)
    feed.setOpen(true)
    feed.handle(snap("t1", 2, [user("x1"), user("x2")]))
    expect(feed.entry("t1").store).toBe(store)
    expect(store.getState().rows.map((r) => r.id)).toEqual(["x1", "x2"])
  })
})

describe("the agent going away and coming back", () => {
  it("keeps the rows, marks the thread unavailable with the backend's sentence, and a later reset brings it back", () => {
    const { feed, snap, unavailable, reset } = setup()
    feed.setOpen(true)
    feed.watch("t1")
    feed.handle(snap("t1", 3))
    const store = feed.entry("t1").store!
    feed.handle(unavailable("t1"))
    expect(feed.entry("t1")).toMatchObject({ phase: "unavailable", reason: "The agent has gone.", store })
    expect(store.getState().rows.map((r) => r.id)).toEqual(["u1"])
    feed.handle(reset("t1", 1))
    expect(feed.entry("t1")).toMatchObject({ phase: "ready", reason: null, store })
    expect(store.getState().rows.map((r) => r.id)).toEqual(["n1"])
  })
  it("a terminal that never had chat is unavailable with no store", () => {
    const { feed, unavailable } = setup()
    feed.setOpen(true)
    feed.watch("t1")
    feed.handle(unavailable("t1"))
    expect(feed.entry("t1")).toMatchObject({ phase: "unavailable", store: null })
  })
  it("tells its listeners only when something changed", () => {
    const { feed, snap } = setup()
    let n = 0
    feed.subscribe(() => n++)
    feed.setOpen(true)
    feed.watch("t1")
    feed.handle(snap("t1", 3))
    const after = n
    feed.handle({ type: "pong" })
    feed.handle(snap("t9", 1)) // not watched
    expect(n).toBe(after)
  })
})

it("never mixes terminals", () => {
  const { feed, snap, update } = setup()
  feed.setOpen(true)
  feed.watch("t1")
  feed.watch("t2")
  feed.handle(snap("t1", 1, [user("a")]))
  feed.handle(snap("t2", 1, [user("b")]))
  feed.handle(update("t2", 2, [assistant("c")]))
  expect(feed.entry("t1").store!.getState().rows.map((r) => r.id)).toEqual(["a"])
  expect(feed.entry("t2").store!.getState().rows.map((r) => r.id)).toEqual(["b", "c"])
  void live
})
