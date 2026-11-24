// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Row } from "@herdr-web/agents/rows"
import { ChatView } from "@/components/chat/chat-view"
import { RowView } from "@/components/chat/rows"
import { ThreadStore } from "@/lib/chat/thread-store"
import { initials, nameHue, parseLinkBatch } from "@/lib/chat/link"
import { assistant, fakeActions, snapshot, tool, user } from "./helpers"

const batch = (items: string[], count: number | null = items.length, source = "link"): Row => ({
  kind: "notice",
  id: "n1",
  at: Date.UTC(2026, 10, 24, 9, 5),
  level: "info",
  text: `[Link: ${count ?? items.length} message(s) received]\n\n${items.join("\n\n")}`,
  source,
  details: count === null ? undefined : { batched: true, count },
})

const show = (row: Row) => render(<RowView row={row} end={false} fullResult={async () => ""} />)

describe("parseLinkBatch", () => {
  it("splits a batch into messages and compaction outcomes", () => {
    const row = batch(['From "a":\nhello', 'From "b":\nline one\nline two', 'link_compact "c" [r-1]: not done: busy'])
    if (row.kind !== "notice") throw new Error()
    expect(parseLinkBatch(row.text, row.details)).toEqual({
      split: true,
      items: [
        { kind: "message", from: "a", body: "hello" },
        { kind: "message", from: "b", body: "line one\nline two" },
        { kind: "compact", target: "c", outcome: "not done: busy" },
      ],
    })
  })

  it("keeps a blank line inside a message", () => {
    expect(parseLinkBatch('[Link: 1 message(s) received]\n\nFrom "a":\none\n\ntwo', { count: 1 })).toEqual({ split: true, items: [{ kind: "message", from: "a", body: "one\n\ntwo" }] })
  })

  it("gives the whole text back when the split does not match the count, or there is no count", () => {
    const quoting = '[Link: 1 message(s) received]\n\nFrom "a":\nthey said:\n\nFrom "b":\nsomething'
    expect(parseLinkBatch(quoting, { count: 1 })).toEqual({ split: false, text: 'From "a":\nthey said:\n\nFrom "b":\nsomething', from: "a" })
    expect(parseLinkBatch('[Link: 1 message(s) received]\n\nFrom "a":\nhi', undefined)).toMatchObject({ split: false, from: "a" })
    expect(parseLinkBatch('[Link: 2 message(s) received]\n\nFrom "a":\nhi', { count: 2 })).toMatchObject({ split: false })
    expect(parseLinkBatch("something else entirely", { count: 1 })).toEqual({ split: false, text: "something else entirely", from: null })
  })
})

describe("names", () => {
  it("a name has one colour, and initials from its last two words", () => {
    expect(nameHue("herdr-web-builder")).toBe(nameHue("herdr-web-builder"))
    expect(nameHue("herdr-web-builder")).not.toBe(nameHue("herdr-web-tester"))
    expect(nameHue("x")).toBeGreaterThanOrEqual(0)
    expect(nameHue("x")).toBeLessThan(360)
    expect(initials("herdr-web-builder")).toBe("WB")
    expect(initials("solo")).toBe("S")
    expect(initials("---")).toBe("?")
  })
})

describe("a received batch", () => {
  it("one message: a bubble with the sender's name and its markdown", () => {
    show(batch(['From "herdr-web-builder":\nDone, **all green**.']))
    const from = screen.getByTestId("link-from")
    expect(within(from).getByTestId("link-name").textContent).toBe("herdr-web-builder")
    expect(within(from).getByTestId("link-avatar").textContent).toBe("WB")
    expect(from.querySelector("[data-streamdown=strong]")?.textContent).toBe("all green")
    expect(screen.queryByTestId("row-notice")).toBeNull()
  })

  it("three messages from two senders: grouped by sender, a bubble each", () => {
    show(batch(['From "a-one":\nfirst', 'From "a-one":\nsecond', 'From "b-two":\nthird']))
    const runs = screen.getAllByTestId("link-from")
    expect(runs.map((r) => r.dataset["from"])).toEqual(["a-one", "b-two"])
    expect(within(runs[0]!).getAllByTestId("link-bubble").map((b) => b.textContent)).toEqual(["first", "second"])
  })

  it("a compaction outcome is one line", () => {
    show(batch(['link_compact "builder" [r-1]: compacted', 'link_compact "tester" [r-2]: left the link before answering; result unknown']))
    expect(screen.getAllByTestId("link-compact-outcome").map((l) => l.textContent)).toEqual([
      "builder compacted",
      "Compaction of tester: left the link before answering; result unknown",
    ])
  })

  it("a body that quotes `From \"…\":` is shown whole, with a note, nothing lost", () => {
    show(batch(['From "a":\nthey said:', 'From "b":\nsomething'], 1))
    const row = screen.getByTestId("row-link")
    expect(row.dataset["split"]).toBe("false")
    expect(screen.getByTestId("link-unsplit")).toBeTruthy()
    expect(row.textContent).toContain("they said:")
    expect(row.textContent).toContain("something")
  })

  describe("a long message", () => {
    afterEach(() => vi.restoreAllMocks())
    it("folds, and Show more opens it", () => {
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(800)
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(192)
      show(batch(['From "a":\n' + "a line\n\n".repeat(30)]))
      const body = screen.getByTestId("link-body")
      expect(body.dataset["folded"]).toBe("true")
      fireEvent.click(screen.getByTestId("link-more"))
      expect(body.dataset["folded"]).toBe("false")
      expect(screen.getByTestId("link-more").textContent).toBe("Show less")
    })
    it("a short one has no Show more", () => {
      show(batch(['From "a":\nshort']))
      expect(screen.queryByTestId("link-more")).toBeNull()
    })
  })

  it("a custom message of another type, or none, stays a notice line", () => {
    show(batch(['From "a":\nhi'], 1, "something-else"))
    expect(screen.getByTestId("row-notice")).toBeTruthy()
    expect(screen.queryByTestId("row-link")).toBeNull()
  })

  it("a source named like an Object property stays a notice line", () => {
    for (const source of ["constructor", "__proto__", "toString"]) {
      const { unmount } = show(batch(['From "a":\nhi'], 1, source))
      expect(screen.getByTestId("row-notice")).toBeTruthy()
      unmount()
    }
  })
})

const send = (status: "ok" | "error" | "running" | "interrupted", result: string | null, details?: unknown) =>
  tool("s1", {
    name: "link_send",
    args: { to: "herdr-web-tester", message: "Run the **final** round." },
    status,
    result: result === null ? null : { text: result, truncated: false, totalChars: result.length },
    ...(details === undefined ? {} : { details }),
  })

describe("link_send", () => {
  it.each([
    ["sent", send("ok", 'Sent to "herdr-web-tester"', { to: "herdr-web-tester" }), /^Sent/],
    ["failed", send("ok", 'Terminal "herdr-web-tester" not found. Connected: a', { to: "herdr-web-tester", error: "not_found" }), /^Not delivered: Terminal "herdr-web-tester" not found/],
    ["failed", send("error", "Link not connected"), /^Not delivered: Link not connected/],
    ["sending", send("running", null), /^Sending$/],
    ["stopped", send("interrupted", null), /^Stopped$/],
  ])("%s: a bubble to the terminal, and what became of it", (state, row, status) => {
    show(row)
    const sent = screen.getByTestId("row-link-send")
    expect(sent.dataset["state"]).toBe(state)
    expect(within(sent).getByTestId("link-name").textContent).toBe("herdr-web-tester")
    expect(sent.querySelector("[data-streamdown=strong]")?.textContent).toBe("final")
    expect(screen.getByTestId("link-send-status").textContent).toMatch(status)
  })

  it("args in another shape: the plain tool line", () => {
    show(tool("s1", { name: "link_send", args: { to: 3 } }))
    expect(screen.getByTestId("row-tool")).toBeTruthy()
  })
})

describe("link_list", () => {
  const listRow = (over = {}) =>
    tool("l1", {
      name: "link_list",
      args: {},
      details: { terminals: ["me", "builder"], statuses: { builder: "working" }, self: "me" },
      ...over,
    })

  it("one line, opening to each terminal and its status", () => {
    show(listRow())
    const row = screen.getByTestId("row-link-list")
    expect(row.textContent).toContain("Listed 2 terminals")
    fireEvent.click(within(row).getByText("Listed 2 terminals"))
    const items = within(row).getAllByTestId("link-terminal")
    expect(items[0]!.textContent).toContain("(this agent)")
    expect(items[1]!.textContent).toContain("working")
  })

  it("running, failed, or without details: the plain tool line", () => {
    for (const over of [{ status: "running", result: null }, { status: "error" }, { details: { error: "not_connected" } }, { details: undefined }]) {
      const { unmount } = show(listRow(over))
      expect(screen.getByTestId("row-tool")).toBeTruthy()
      unmount()
    }
  })
})

describe("link_compact", () => {
  it("done: a small line; otherwise the plain tool line", () => {
    const row = (over = {}) => tool("c1", { name: "link_compact", args: { to: "builder" }, details: { to: "builder", id: "r-1" }, ...over })
    const { unmount } = show(row())
    expect(screen.getByTestId("link-compact-asked").textContent).toContain("Asked builder to compact")
    unmount()
    for (const over of [{ status: "running", result: null }, { details: { to: "builder", error: "not_found" } }]) {
      const { unmount } = show(row(over))
      expect(screen.getByTestId("row-tool")).toBeTruthy()
      unmount()
    }
  })
})

describe("in a thread", () => {
  it("link tools are never folded into a group of steps", () => {
    const rows = [user("u1"), tool("t1"), tool("t2", { name: "link_send", args: { to: "a", message: "hi" } }), tool("t3"), assistant("a1")]
    render(<ChatView store={new ThreadStore(snapshot(rows))} actions={fakeActions()} disabledReason={null} draftKey="t1" onShowTerminal={() => {}} />)
    expect(screen.getByTestId("row-link-send")).toBeTruthy()
    expect(screen.queryByText(/link_send/)).toBeNull()
  })
})
