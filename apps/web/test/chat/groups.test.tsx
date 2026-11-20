// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { Row } from "@herdr-web/agents/rows"
import { ChatView } from "@/components/chat/chat-view"
import { groupMeta, groupRows, groupSummary, type GroupItem } from "@/lib/chat/format"
import { ThreadStore } from "@/lib/chat/thread-store"
import { assistant, fakeActions, feeder, live, snapshot, thinking, tool, user } from "./helpers"

const steps = (...rows: Row[]) => rows as GroupItem["rows"]
const named = (id: string, name: string, over = {}) => tool(id, { name, args: {}, ...over })

describe("groupSummary", () => {
  it("counts commands, files read, files edited and searches, singular and plural", () => {
    expect(groupSummary(steps(named("a", "bash"), named("b", "bash")))).toBe("Ran 2 commands")
    expect(groupSummary(steps(named("a", "bash"), named("b", "read")))).toBe("Ran 1 command, read 1 file")
    expect(groupSummary(steps(named("a", "read"), named("b", "read"), named("c", "read")))).toBe("Read 3 files")
  })
  it("edit and write are one count of edited files", () => {
    expect(groupSummary(steps(named("a", "edit"), named("b", "write")))).toBe("Edited 2 files")
    expect(groupSummary(steps(named("a", "write"), named("b", "read")))).toBe("Edited 1 file, read 1 file")
  })
  it("grep, find and ls are one count of searches: once, twice, then N times", () => {
    expect(groupSummary(steps(named("a", "grep"), named("b", "read")))).toBe("Searched once, read 1 file")
    expect(groupSummary(steps(named("a", "grep"), named("b", "find")))).toBe("Searched twice")
    expect(groupSummary(steps(named("a", "grep"), named("b", "find"), named("c", "ls")))).toBe("Searched 3 times")
  })
  it("thinking is 'thought' with no count, however many", () => {
    expect(groupSummary(steps(thinking("a"), thinking("b"), named("c", "bash")))).toBe("Thought, ran 1 command")
  })
  it("another tool is 'used <name>', with × N when more than once", () => {
    expect(groupSummary(steps(named("a", "web_fetch"), named("b", "bash")))).toBe("Used web_fetch, ran 1 command")
    expect(groupSummary(steps(named("a", "web_fetch"), named("b", "web_fetch"), named("c", "web_fetch")))).toBe("Used web_fetch × 3")
  })
  it("keeps the order of first appearance, and rows the user ran count the same", () => {
    const rows = steps(thinking("a"), named("b", "bash"), named("c", "bash", { byUser: true }), named("d", "bash"), named("e", "bash"), named("f", "bash"), named("g", "read"), named("h", "edit"), named("i", "grep"))
    expect(groupSummary(rows)).toBe("Thought, ran 5 commands, read 1 file, edited 1 file, searched once")
  })
})

describe("groupMeta", () => {
  it("sums the durations that exist, and counts failed and stopped steps", () => {
    const m = groupMeta(steps(named("a", "bash", { durationMs: 100 }), named("b", "bash", { durationMs: 50, status: "error" }), named("c", "bash", { durationMs: null, status: "interrupted" }), thinking("d")))
    expect(m).toEqual({ failed: 1, stopped: 1, durationMs: 150 })
  })
  it("has no duration when no step has one", () => {
    expect(groupMeta(steps(thinking("a"), named("b", "bash", { durationMs: null }))).durationMs).toBeNull()
  })
})

describe("groupRows", () => {
  const ids = (rows: Row[]) => groupRows(rows).map((i) => (i.type === "group" ? `[${i.rows.map((r) => r.id).join(",")}]` : i.row.id))
  it("a run of two or more steps is a group; a run of one is not", () => {
    expect(ids([user("u"), thinking("a"), tool("b"), assistant("x"), tool("c"), user("v")])).toEqual(["u", "[a,b]", "x", "c", "v"])
  })
  it("a row of any other kind breaks a run", () => {
    expect(ids([tool("a"), tool("b"), assistant("x"), tool("c"), tool("d")])).toEqual(["[a,b]", "x", "[c,d]"])
  })
  it("a group's id is its first row's id, and an older page that extends the run keeps it one group", () => {
    const page = [tool("c"), tool("d"), assistant("x")]
    const first = groupRows(page)[0]!
    expect(first.type === "group" && first.id).toBe("c")
    const grown = groupRows([thinking("a"), tool("b"), ...page])[0]!
    expect(grown.type).toBe("group")
    expect(grown.type === "group" && grown.rows.map((r) => r.id)).toEqual(["a", "b", "c", "d"])
    expect(grown.type === "group" && grown.id).toBe("a")
  })
})

const mount = (store: ThreadStore) => render(<ChatView store={store} actions={fakeActions()} disabledReason={null} draftKey="t1" onShowTerminal={() => {}} />)
const trigger = () => screen.getByTestId("group-trigger")

describe("a group in the thread", () => {
  const thread = () => new ThreadStore(snapshot([user("u1"), thinking("a"), tool("b"), tool("c"), assistant("x")]))

  it("is collapsed by default, as one line, with its steps not rendered", () => {
    mount(thread())
    expect(screen.getAllByTestId("row-group")).toHaveLength(1)
    expect(trigger().getAttribute("aria-expanded")).toBe("false")
    expect(screen.getByTestId("group-label").textContent).toBe("Thought, ran 2 commands")
    expect(screen.queryByTestId("row-tool")).toBeNull()
    expect(screen.queryByTestId("row-thinking")).toBeNull()
  })

  it("opens and closes on click, showing each step as a row of its own", () => {
    mount(thread())
    fireEvent.click(trigger())
    expect(trigger().getAttribute("aria-expanded")).toBe("true")
    expect(within(screen.getByTestId("group-steps")).getAllByTestId("row-tool")).toHaveLength(2)
    expect(screen.getAllByTestId("row-thinking")).toHaveLength(1)
    fireEvent.click(trigger())
    expect(trigger().getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByTestId("row-tool")).toBeNull()
  })

  it("shows the summed duration, and N failed with a destructive line when a step failed", () => {
    mount(new ThreadStore(snapshot([tool("a", { durationMs: 100 }), tool("b", { durationMs: 1400, status: "error" })])))
    expect(screen.getByTestId("group-duration").textContent).toBe("1.5 s")
    expect(screen.getByTestId("group-failed").textContent).toBe("1 failed")
    expect(trigger().querySelector("[data-slot=trace-line]")!.getAttribute("data-status")).toBe("error")
  })

  it("shows 'stopped' for an interrupted step, and nothing about failure when none failed", () => {
    mount(new ThreadStore(snapshot([tool("a"), tool("b", { status: "interrupted", result: null, durationMs: null })])))
    expect(screen.getByTestId("group-stopped").textContent).toBe("stopped")
    expect(screen.queryByTestId("group-failed")).toBeNull()
  })

  it("stays open through new rows and an older page that grows its run", () => {
    const store = new ThreadStore(snapshot([tool("c"), tool("d"), assistant("x")], { hasMore: true }))
    mount(store)
    fireEvent.click(trigger())
    act(() => feeder(store)({ rows: [user("u2")] }))
    expect(trigger().getAttribute("aria-expanded")).toBe("true")
    act(() => {
      store.prepend([thinking("a"), tool("b")], false)
      store.flush()
    })
    expect(screen.getAllByTestId("row-group")).toHaveLength(1)
    expect(trigger().getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByTestId("group-label").textContent).toBe("Thought, ran 3 commands")
  })

  it("has a first row's id on its item, so the scroller can keep the reader's place", () => {
    mount(thread())
    expect(screen.getByTestId("row-group").getAttribute("data-row-id")).toBe("a")
  })
})

describe("the group of the live run", () => {
  const working = { live: live({ working: true }) }

  it("is open while the agent works, and collapses when the turn ends", () => {
    const store = new ThreadStore(snapshot([user("u1"), tool("a"), tool("b")], working))
    mount(store)
    expect(trigger().getAttribute("aria-expanded")).toBe("true")
    act(() => feeder(store)({ rows: [assistant("x")], live: live() }))
    expect(trigger().getAttribute("aria-expanded")).toBe("false")
  })

  it("is not open when an assistant message came after it: only the run being worked on is", () => {
    mount(new ThreadStore(snapshot([user("u1"), tool("a"), tool("b"), assistant("x"), tool("c")], working)))
    expect(trigger().getAttribute("aria-expanded")).toBe("false")
  })

  it("a lone step becomes an open group when the next one arrives", () => {
    const store = new ThreadStore(snapshot([user("u1"), tool("a")], working))
    mount(store)
    expect(screen.queryByTestId("row-group")).toBeNull()
    act(() => feeder(store)({ rows: [tool("b")] }))
    expect(trigger().getAttribute("aria-expanded")).toBe("true")
  })

  it("stays open when the turn ends if the reader opened it by hand", () => {
    const store = new ThreadStore(snapshot([user("u1"), tool("a"), tool("b")], { live: live({ working: false }) }))
    mount(store)
    fireEvent.click(trigger()) // opened by hand (it was collapsed)
    act(() => feeder(store)({ live: live({ working: true }) }))
    act(() => feeder(store)({ rows: [assistant("x")], live: live() }))
    expect(trigger().getAttribute("aria-expanded")).toBe("true")
  })

  it("stays closed through the turn and after it if the reader closed it by hand", () => {
    const store = new ThreadStore(snapshot([user("u1"), tool("a"), tool("b")], working))
    mount(store)
    fireEvent.click(trigger()) // closed by hand (it was open)
    expect(trigger().getAttribute("aria-expanded")).toBe("false")
    act(() => feeder(store)({ rows: [tool("c")] }))
    expect(trigger().getAttribute("aria-expanded")).toBe("false")
    act(() => feeder(store)({ rows: [assistant("x")], live: live() }))
    expect(trigger().getAttribute("aria-expanded")).toBe("false")
  })
})
