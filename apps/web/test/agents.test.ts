import { describe, expect, it } from "vitest"
import { agentName, agentState, formatAge, isAgent, isPinned, seenTurn } from "@/lib/agents"
import { agent, terminal } from "./fixtures"

describe("isAgent", () => {
  it("a live terminal whose program reported status", () => {
    expect(isAgent(agent("t1", "idle"))).toBe(true)
    expect(isAgent(terminal("t1"))).toBe(false) // a shell: no status
    expect(isAgent(agent("t1", "idle", { state: "finished" }))).toBe(false)
  })
})

describe("agentState", () => {
  it.each([
    ["blocked", "needs_you"],
    ["error", "needs_you"],
    ["BLOCKED", "needs_you"],
    ["working", "working"],
  ])("status %s is %s, whatever the turn and seen label say", (status, expected) => {
    expect(agentState(agent("t1", status, { turn: 9, labels: { "herdr.seen": "0" } }))).toBe(expected)
  })

  it("done when the turn is above the seen label", () => {
    expect(agentState(agent("t1", "idle", { turn: 3, labels: { "herdr.seen": "2" } }))).toBe("done")
  })

  it("idle when the turn equals or is below the seen label", () => {
    expect(agentState(agent("t1", "idle", { turn: 3, labels: { "herdr.seen": "3" } }))).toBe("idle")
    expect(agentState(agent("t1", "idle", { turn: 2, labels: { "herdr.seen": "5" } }))).toBe("idle")
  })

  it("a missing label with turn above 0 is done; with turn 0 it is idle", () => {
    expect(agentState(agent("t1", "idle", { turn: 1 }))).toBe("done")
    expect(agentState(agent("t1", "idle", { turn: 0 }))).toBe("idle")
  })

  it("an empty or unreadable label counts as missing", () => {
    for (const bad of ["", "  ", "abc", "-1", "1.5"]) {
      expect(agentState(agent("t1", "idle", { turn: 1, labels: { "herdr.seen": bad } }))).toBe("done")
      expect(agentState(agent("t1", "idle", { turn: 0, labels: { "herdr.seen": bad } }))).toBe("idle")
    }
  })

  it("any other status word (done, idle, something new) falls to the turn rule", () => {
    expect(agentState(agent("t1", "done", { turn: 2, labels: { "herdr.seen": "1" } }))).toBe("done")
    expect(agentState(agent("t1", "thinking-hard", { turn: 0 }))).toBe("idle")
  })
})

describe("labels", () => {
  it("seenTurn parses whole numbers only", () => {
    expect(seenTurn(terminal("t1", { labels: { "herdr.seen": "4" } }))).toBe(4)
    expect(seenTurn(terminal("t1", { labels: { "herdr.seen": "0" } }))).toBe(0)
    expect(seenTurn(terminal("t1"))).toBeNull()
  })

  it("pinned is any non-empty value", () => {
    expect(isPinned(terminal("t1", { labels: { "herdr.pinned": "1" } }))).toBe(true)
    expect(isPinned(terminal("t1", { labels: { "herdr.pinned": "yes" } }))).toBe(true)
    expect(isPinned(terminal("t1", { labels: { "herdr.pinned": "" } }))).toBe(false)
    expect(isPinned(terminal("t1"))).toBe(false)
  })
})

describe("agentName", () => {
  it("prefers name, then title, then the program's own name, then the address", () => {
    expect(agentName(agent("t1", "idle", { name: "pi-evals", title: "x" }))).toBe("pi-evals")
    expect(agentName(agent("t1", "idle", { title: "fixing tests" }))).toBe("fixing tests")
    expect(agentName(agent("t1", "idle"))).toBe("pi")
    expect(agentName(terminal("cachyos/t7"))).toBe("cachyos/t7")
  })
})

describe("formatAge", () => {
  const now = 10_000_000
  it.each([
    [0, "now"],
    [44, "now"],
    [45, "1m"],
    [39 * 60, "39m"],
    [59 * 60 + 59, "59m"],
    [3600, "1h"],
    [47 * 3600, "47h"],
    [48 * 3600, "2d"],
    [10 * 86400, "10d"],
  ])("%i seconds ago is %s", (seconds, expected) => {
    expect(formatAge(now, now - seconds * 1000)).toBe(expected)
  })
  it("never negative, and empty without a time", () => {
    expect(formatAge(now, now + 5000)).toBe("now")
    expect(formatAge(now, null)).toBe("")
  })
})
