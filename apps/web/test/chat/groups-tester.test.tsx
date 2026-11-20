// @vitest-environment jsdom
// DEV-31, tester's tests: keyboard, open state across a page / new rows / the end of a turn, two groups, mixed unknown tools.
import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import type { Row } from "@herdr-web/agents/rows"
import { ChatView } from "@/components/chat/chat-view"
import { groupSummary, type GroupItem } from "@/lib/chat/format"
import { ThreadStore } from "@/lib/chat/thread-store"
import { assistant, fakeActions, feeder, live, snapshot, thinking, tool, user } from "./helpers"

const named = (id: string, name: string, over = {}) => tool(id, { name, args: {}, ...over })
const steps = (...rows: Row[]) => rows as GroupItem["rows"]
const mount = (store: ThreadStore) => render(<ChatView store={store} actions={fakeActions()} disabledReason={null} draftKey="t1" onShowTerminal={() => {}} />)
const triggers = () => screen.getAllByTestId("group-trigger")
const expanded = () => triggers().map((t) => t.getAttribute("aria-expanded"))

describe("the label of a mixed run", () => {
  it("each unknown tool has its own entry, in order of first appearance, × N when repeated", () => {
    expect(groupSummary(steps(named("a", "web_fetch"), named("b", "mcp_query"), named("c", "web_fetch"), named("d", "bash")))).toBe("Used web_fetch × 2, used mcp_query, ran 1 command")
  })
  it("a user-run command (you) counts as a command in the rendered label", () => {
    mount(new ThreadStore(snapshot([user("u"), named("a", "bash", { byUser: true }), named("b", "bash"), assistant("x")])))
    expect(screen.getByTestId("group-label").textContent).toBe("Ran 2 commands")
  })
})

describe("keyboard", () => {
  const thread = () => new ThreadStore(snapshot([user("u1"), thinking("a"), tool("b"), assistant("x")]))
  it("Tab reaches the group line, Enter opens it, Space closes it, aria-expanded follows", async () => {
    mount(thread())
    const trigger = triggers()[0]!
    expect(trigger.tagName).toBe("BUTTON")
    for (let i = 0; i < 4 && document.activeElement !== trigger; i++) await userEvent.tab() // the scroller may take a stop first
    expect(document.activeElement).toBe(trigger)
    await userEvent.keyboard("{Enter}")
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getAllByTestId("row-tool")).toHaveLength(1)
    await userEvent.keyboard(" ")
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByTestId("row-tool")).toBeNull()
  })
})

describe("open state is the reader's, by group", () => {
  const rows = (): Row[] => [user("u1"), tool("a"), tool("b"), assistant("x1"), user("u2"), tool("c"), tool("d"), assistant("x2")]

  it("opening one group leaves the other collapsed", () => {
    mount(new ThreadStore(snapshot(rows())))
    fireEvent.click(triggers()[1]!)
    expect(expanded()).toEqual(["false", "true"])
  })

  it("a hand-closed live group stays closed through new steps, an older page and the end of the turn", () => {
    const store = new ThreadStore(snapshot([tool("c"), tool("d")], { hasMore: true, live: live({ working: true }) }))
    mount(store)
    expect(expanded()).toEqual(["true"]) // the live run is open
    fireEvent.click(triggers()[0]!) // the reader closes it
    act(() => feeder(store)({ rows: [tool("e")] }))
    expect(expanded()).toEqual(["false"])
    act(() => {
      store.prepend([thinking("a"), tool("b")], false)
      store.flush()
    })
    expect(screen.getAllByTestId("row-group")).toHaveLength(1)
    expect(expanded()).toEqual(["false"])
    act(() => feeder(store)({ rows: [assistant("x")], live: live() }))
    expect(expanded()).toEqual(["false"])
  })

  it("a hand-opened group stays open through an older page that grows it, new rows, and the end of a turn", () => {
    const store = new ThreadStore(snapshot([tool("c"), tool("d"), assistant("x")], { hasMore: true }))
    mount(store)
    fireEvent.click(triggers()[0]!)
    act(() => {
      store.prepend([thinking("a"), tool("b")], false)
      store.flush()
    })
    expect(expanded()).toEqual(["true"])
    act(() => feeder(store)({ live: live({ working: true }) }))
    act(() => feeder(store)({ rows: [user("u2"), tool("e"), tool("f")] }))
    expect(expanded()).toEqual(["true", "true"]) // the old one by hand, the live run open
    act(() => feeder(store)({ rows: [assistant("y")], live: live() }))
    expect(expanded()).toEqual(["true", "false"]) // the live run collapses, the hand-opened one is as left
  })

  it("an open group with a failed step still says so on its line, and shows the failed step", () => {
    mount(new ThreadStore(snapshot([tool("a"), tool("b", { status: "error", result: { text: "boom", truncated: false, totalChars: 4 } })])))
    fireEvent.click(triggers()[0]!)
    expect(screen.getByTestId("group-failed").textContent).toBe("1 failed")
    expect(screen.getAllByTestId("row-tool")).toHaveLength(2)
  })
})
