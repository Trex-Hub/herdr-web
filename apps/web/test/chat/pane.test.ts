import { describe, expect, it } from "vitest"
import { awayReason, initialView, wantsChatHint } from "@/lib/chat/pane"
import { agent, terminal } from "../fixtures"

describe("which side a pane opens on", () => {
  it("opens on Chat when there is chat and nothing was chosen before", () => {
    expect(initialView(true, null)).toBe("chat")
  })
  it("keeps the reader's earlier choice", () => {
    expect(initialView(true, "terminal")).toBe("terminal")
    expect(initialView(true, "chat")).toBe("chat")
  })
  it("opens on the terminal when there is no chat, whatever was chosen", () => {
    expect(initialView(false, null)).toBe("terminal")
    expect(initialView(false, "chat")).toBe("terminal")
  })
})

describe("the hint about pi-live", () => {
  it("is for a live local terminal whose program is pi and that has no chat", () => {
    expect(wantsChatHint(agent("t1", "idle"))).toBe(true)
  })
  it("is not for one that has chat, is finished, is another program or is on another machine", () => {
    expect(wantsChatHint(agent("t1", "idle", { chat: true }))).toBe(false)
    expect(wantsChatHint(agent("t1", "idle", { state: "finished" }))).toBe(false)
    expect(wantsChatHint(terminal("t1", { status: { state: "idle", app: "claude" } }))).toBe(false)
    expect(wantsChatHint(terminal("t1"))).toBe(false)
    expect(wantsChatHint(agent("cachyos/t1", "idle"))).toBe(false)
  })
})

describe("what the composer says when the link is down", () => {
  it("names the side that is down, and nothing when none is", () => {
    expect(awayReason("backend")).toMatch(/backend/)
    expect(awayReason("core")).toMatch(/core/)
    expect(awayReason(null)).toBeNull()
  })
})
