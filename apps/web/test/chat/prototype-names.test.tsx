// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { ChatView } from "@/components/chat/chat-view"
import { RowView } from "@/components/chat/rows"
import { ThreadStore } from "@/lib/chat/thread-store"
import { loadHighlighter } from "@/lib/highlighter"
import { assistant, fakeActions, feeder, live, snapshot, tool, user } from "./helpers"

/** Names an agent or extension can send that a plain object already has. */
const NAMES = ["constructor", "toString", "hasOwnProperty", "__proto__"]

const mount = (store: ThreadStore) =>
  render(<ChatView store={store} actions={fakeActions()} disabledReason={null} draftKey="t1" onShowTerminal={() => {}} />)

describe("names that an Object has already", () => {
  it("a finished tool row shows the default icon", () => {
    for (const name of NAMES) {
      const { unmount } = render(<RowView row={tool("t1", { name, args: {} })} end={false} fullResult={async () => ""} />)
      const row = screen.getByTestId("row-tool")
      expect(row.textContent).toContain(name)
      expect(row.querySelector("svg.lucide-wrench")).toBeTruthy()
      unmount()
    }
  })

  it("a live tool, with such a name or call id, renders with its elapsed time", () => {
    const store = new ThreadStore(snapshot([user("u1")]))
    mount(store)
    act(() => {
      feeder(store)({ live: live({ working: true, tools: NAMES.map((name) => ({ callId: name, name })) }) })
    })
    const lines = screen.getAllByTestId("live-tool")
    expect(lines).toHaveLength(NAMES.length)
    lines.forEach((line, i) => {
      expect(line.textContent).toContain(NAMES[i]!)
      expect(within(line).getByTestId("live-tool-elapsed").textContent).toMatch(/^$|^\d+ s$|^\d+ min \d+ s$/)
    })
  })

  it("a group of such tools renders", () => {
    const rows = NAMES.map((name, i) => tool(`t${i}`, { name, args: {} }))
    mount(new ThreadStore(snapshot([user("u1"), ...rows, assistant("a1")])))
    expect(screen.getByTestId("row-assistant")).toBeTruthy()
    expect(screen.getByTestId("group-label").textContent).toContain("Used constructor")
  })

  it("a code fence with such a language is plain code, not an error", async () => {
    for (const language of ["constructor", "__proto__", "toString"]) expect(await loadHighlighter(language)).toBeNull()
    expect(await loadHighlighter("ts")).not.toBeNull()
    render(<RowView row={assistant("a1", "```constructor\nconst x = 1\n```")} end={false} fullResult={async () => ""} />)
    const block = await screen.findByTestId("code-block")
    await waitFor(() => expect(block.textContent).toContain("const x = 1"))
  })
})
