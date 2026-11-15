import { describe, expect, it } from "vitest"
import { SeenTracker } from "@/lib/seen"

const t = (turn: number, seen: number | null, address = "t1") => ({ address, turn, seen })

describe("SeenTracker", () => {
  it("writes the turn once while the pane is shown, visible and focused", () => {
    const s = new SeenTracker()
    expect(s.decide(t(2, 1), true)).toBe(2)
    expect(s.decide(t(2, 1), true)).toBeNull() // the label has not arrived yet: still once
    expect(s.decide(t(2, 2), true)).toBeNull()
  })
  it("writes again for each new turn", () => {
    const s = new SeenTracker()
    expect(s.decide(t(1, 0), true)).toBe(1)
    expect(s.decide(t(2, 1), true)).toBe(2)
    expect(s.decide(t(3, 2), true)).toBe(3)
  })
  it("writes nothing while hidden or unfocused, and catches up when attending again", () => {
    const s = new SeenTracker()
    expect(s.decide(t(1, 0), false)).toBeNull()
    expect(s.decide(t(2, 0), false)).toBeNull()
    expect(s.decide(t(2, 0), true)).toBe(2)
  })
  it("never lowers: a label at or above the turn is left alone", () => {
    const s = new SeenTracker()
    expect(s.decide(t(2, 2), true)).toBeNull()
    expect(s.decide(t(3, 5), true)).toBeNull()
  })
  it("writes when the label is missing, even at turn 0", () => {
    expect(new SeenTracker().decide(t(0, null), true)).toBe(0)
    expect(new SeenTracker().decide(t(4, null), true)).toBe(4)
  })
  it("a mark unread made while the screen shows the agent stays unread until the next turn", () => {
    const s = new SeenTracker()
    expect(s.decide(t(2, 1), true)).toBe(2)
    s.markedUnread("t1", 2)
    expect(s.decide(t(2, 1), true)).toBeNull()
    expect(s.decide(t(3, 1), true)).toBe(3)
  })
  it("a mark unread for a turn that arrived while hidden is not overruled on return", () => {
    const s = new SeenTracker()
    expect(s.decide(t(3, 2), false)).toBeNull()
    s.markedUnread("t1", 3)
    expect(s.decide(t(3, 2), true)).toBeNull()
  })
  it("keeps terminals apart, and retries after a failed write", () => {
    const s = new SeenTracker()
    expect(s.decide(t(1, 0, "t1"), true)).toBe(1)
    expect(s.decide(t(1, 0, "t2"), true)).toBe(1)
    s.failed("t1", 1)
    expect(s.decide(t(1, 0, "t1"), true)).toBe(1)
  })
})
