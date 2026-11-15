import { describe, expect, it } from "vitest"
import { assistant, fullCaps, identity, live, manualStore, snapshot, thinking, tool, user } from "./helpers"
import { ThreadStore } from "@/lib/chat/thread-store"

const update = (seq: number, rest: Record<string, unknown>) => ({ type: "update" as const, seq, ...rest })

describe("ThreadStore", () => {
  it("starts from a snapshot", () => {
    const store = new ThreadStore(snapshot([user("u1"), assistant("a1")], { seq: 7, hasMore: true }))
    const s = store.getState()
    expect([s.seq, s.hasMore, s.rows.map((r) => r.id), s.generation]).toEqual([7, true, ["u1", "a1"], 0])
  })

  it("applies the next change, keeps the rows' order, and appends a new id at the end", () => {
    const store = new ThreadStore(snapshot([user("u1")]))
    expect(store.apply(update(2, { rows: [assistant("a1")] }))).toBe("applied")
    expect(store.apply(update(3, { rows: [user("u2")] }))).toBe("applied")
    expect(store.getState().rows.map((r) => r.id)).toEqual(["u1", "a1", "u2"])
    expect(store.getState().seq).toBe(3)
  })

  it("replaces a row by id where it is, and leaves the others as the same objects", () => {
    const rows = [user("u1"), tool("t1", { status: "running", result: null, durationMs: null }), assistant("a1")]
    const store = new ThreadStore(snapshot(rows))
    const before = store.getState().rows
    store.apply(update(2, { rows: [tool("t1")] }))
    const after = store.getState().rows
    expect(after.map((r) => r.id)).toEqual(["u1", "t1", "a1"])
    expect((after[1] as { status: string }).status).toBe("ok")
    expect(after[0]).toBe(before[0])
    expect(after[2]).toBe(before[2])
  })

  it("an upsert that changes nothing keeps the rows array and the row", () => {
    const store = new ThreadStore(snapshot([user("u1"), assistant("a1")]))
    const before = store.getState().rows
    store.apply(update(2, { rows: [{ ...(before[1] as object) }] }))
    expect(store.getState().rows).toBe(before)
  })

  it("replaces live, capabilities and identity as a whole, only when they are sent", () => {
    const store = new ThreadStore(snapshot([]))
    const caps = store.getState().capabilities
    store.apply(update(2, { live: live({ working: true, reply: { blocks: [{ kind: "text", text: "hi" }] } }) }))
    expect(store.getState().live.reply?.blocks[0]?.text).toBe("hi")
    expect(store.getState().capabilities).toBe(caps)
    store.apply(update(3, { live: live(), capabilities: fullCaps, identity: { ...identity, title: "renamed" } }))
    expect(store.getState().live.reply).toBeNull()
    expect(store.getState().capabilities).toBe(fullCaps)
    expect(store.getState().identity.title).toBe("renamed")
  })

  it("a reply that becomes a row arrives with the row in one change: never both, never neither", () => {
    const { store, frame } = manualStore(snapshot([user("u1")], { live: live({ working: true, reply: { blocks: [{ kind: "text", text: "partial" }] } }) }))
    const seen: Array<[number, boolean]> = []
    store.subscribe(() => seen.push([store.getState().rows.filter((r) => r.kind === "assistant").length, store.getState().live.reply !== null]))
    store.apply(update(2, { rows: [assistant("a1", "partial and done")], live: live() }))
    frame()
    expect(seen).toEqual([[1, false]])
  })

  it("ignores a change it already has, and reports a gap when one is missing", () => {
    const store = new ThreadStore(snapshot([user("u1")], { seq: 5 }))
    expect(store.apply(update(5, { rows: [user("x")] }))).toBe("stale")
    expect(store.apply(update(3, { rows: [user("x")] }))).toBe("stale")
    expect(store.apply(update(7, { rows: [user("x")] }))).toBe("gap")
    expect(store.getState().rows.map((r) => r.id)).toEqual(["u1"])
    expect(store.getState().seq).toBe(5)
  })

  it("a reset replaces everything, starts a new generation, and may skip seq", () => {
    const store = new ThreadStore(snapshot([user("u1"), assistant("a1")], { seq: 5 }))
    expect(store.apply({ type: "reset", seq: 9, snapshot: snapshot([user("n1")], { seq: 9, identity: { ...identity, sessionId: "new" } }) })).toBe("applied")
    const s = store.getState()
    expect([s.seq, s.rows.map((r) => r.id), s.identity.sessionId, s.generation]).toEqual([9, ["n1"], "new", 1])
    expect(store.apply(update(10, { rows: [assistant("n2")] }))).toBe("applied")
  })

  it("prepends an older page without duplicating rows, and keeps the live state", () => {
    const store = new ThreadStore(snapshot([user("u3"), assistant("a3")], { hasMore: true, live: live({ working: true }) }))
    store.setLoadingOlder(true)
    store.prepend([user("u1"), assistant("a1"), user("u3")], false)
    const s = store.getState()
    expect(s.rows.map((r) => r.id)).toEqual(["u1", "a1", "u3", "a3"])
    expect([s.hasMore, s.loadingOlder, s.live.working]).toEqual([false, false, true])
    // and a later upsert still finds rows by id
    store.apply(update(2, { rows: [assistant("a1", "edited")] }))
    expect((store.getState().rows[1] as { text: string }).text).toBe("edited")
  })

  it("a failed load of older rows is remembered until the next try", () => {
    const store = new ThreadStore(snapshot([user("u3")], { hasMore: true }))
    store.setLoadingOlder(false, "The backend is away.")
    expect(store.getState().olderError).toBe("The backend is away.")
    store.setLoadingOlder(true)
    expect(store.getState().olderError).toBeNull()
  })

  it("tells listeners once per frame, however many changes came, and getState is always the latest", () => {
    const { store, frame, pending } = manualStore(snapshot([user("u1")]))
    let told = 0
    store.subscribe(() => told++)
    for (let i = 0; i < 50; i++) store.apply(update(2 + i, { live: live({ working: true, reply: { blocks: [{ kind: "text", text: "x".repeat(i) }] } }) }))
    expect(told).toBe(0)
    expect(pending()).toBe(1)
    expect(store.getState().live.reply?.blocks[0]?.text).toHaveLength(49)
    frame()
    expect(told).toBe(1)
    store.apply(update(52, { rows: [thinking("th")] }))
    frame()
    expect(told).toBe(2)
  })

  it("an unsubscribed listener hears nothing", () => {
    const { store, frame } = manualStore(snapshot([]))
    let told = 0
    const off = store.subscribe(() => told++)
    off()
    store.apply(update(2, { live: live({ working: true }) }))
    frame()
    expect(told).toBe(0)
  })
})
