// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Row } from "@herdr-web/agents/rows"
import { ChatView } from "@/components/chat/chat-view"
import { RowView } from "@/components/chat/rows"
import { groupRows } from "@/lib/chat/format"
import { ThreadStore } from "@/lib/chat/thread-store"
import { askRow, assistant, batchAsk, fakeActions, feeder, live, questionAsk, singleDetails, snapshot, tool, user } from "./helpers"

const blue = { kind: "selection", selections: ["Blue"] }
const mount = (store: ThreadStore) => render(<ChatView store={store} actions={fakeActions()} disabledReason={null} draftKey="t1" onShowTerminal={() => {}} />)
const alone = (row: Row) => render(<RowView row={row} end={false} fullResult={async () => ""} />)
const line = () => screen.getByTestId("ask-line").textContent
const stateOf = () => screen.getByTestId("row-ask").getAttribute("data-ask-state")

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe("a tool with no view of its own", () => {
  it("is the plain tool line", () => {
    alone(tool("t1", { name: "web_fetch", args: { url: "x" } }))
    expect(screen.getByTestId("row-tool")).toBeTruthy()
    expect(screen.queryByTestId("row-ask")).toBeNull()
  })
  it("a bash row is as it was", () => {
    alone(tool("t1"))
    expect(screen.getByTestId("row-tool").getAttribute("data-name")).toBe("bash")
  })
})

describe("grouping", () => {
  it("an ask_user row is never folded: it splits the run of steps around it", () => {
    const rows = [tool("a"), tool("b"), askRow("q"), tool("c"), tool("d"), tool("e")]
    expect(groupRows(rows).map((i) => (i.type === "group" ? `group:${i.rows.map((r) => r.id).join("")}` : `row:${i.row.id}`))).toEqual(["group:ab", "row:q", "group:cde"])
  })
  it("one ask_user row between lone steps stays a row, as do the steps", () => {
    expect(groupRows([tool("a"), askRow("q"), tool("b")]).map((i) => i.type)).toEqual(["row", "row", "row"])
  })
  it("in a thread the line is on the page, outside the group's fold", () => {
    mount(new ThreadStore(snapshot([user("u1"), tool("a"), tool("b"), askRow("q", { details: singleDetails(blue) }), tool("c"), tool("d")])))
    expect(screen.getAllByTestId("row-group")).toHaveLength(2)
    const ask = screen.getByTestId("row-ask")
    expect(ask.closest("[data-testid=row-group]")).toBeNull()
    expect(line()).toBe("Asked: Which color? · Answered: Blue")
  })
})

describe("the line of a running call", () => {
  it("open: muted Awaiting input…, from the live asks", () => {
    const store = new ThreadStore(snapshot([user("u1"), askRow("q", { status: "running", result: null, durationMs: null })], { live: live({ working: true, asks: [questionAsk("call-q")] }) }))
    mount(store)
    expect(line()).toBe("Awaiting input…")
    expect(stateOf()).toBe("open")
    expect(screen.queryByTestId("ask-expires")).toBeNull()
  })

  it("open with a deadline says when it expires, counted in minutes", () => {
    const at = Date.now() + 2 * 60_000
    mount(new ThreadStore(snapshot([askRow("q", { status: "running", result: null })], { live: live({ working: true, asks: [questionAsk("call-q", {}, { expiresAt: at })] }) })))
    expect(screen.getByTestId("ask-expires").textContent).toBe(" · expires in 2 min")
    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(screen.getByTestId("ask-expires").textContent).toBe(" · expires in 2 min") // 90 s left, rounded up
    act(() => {
      vi.advanceTimersByTime(45_000)
    })
    expect(screen.getByTestId("ask-expires").textContent).toBe(" · expires in under a minute")
  })

  it("answer sent: the ask left live.asks but was there, so the line says Answered while the row waits", () => {
    const store = new ThreadStore(snapshot([askRow("q", { status: "running", result: null })], { live: live({ working: true, asks: [questionAsk("call-q")] }) }))
    mount(store)
    expect(stateOf()).toBe("open")
    act(() => {
      feeder(store)({ live: live({ working: true, asks: [] }) })
    })
    expect(line()).toBe("Answered")
    expect(stateOf()).toBe("sent")
    // the row arrives with its result
    act(() => {
      feeder(store)({ rows: [askRow("q", { details: singleDetails(blue) })], live: live() })
    })
    expect(line()).toBe("Asked: Which color? · Answered: Blue")
  })

  it("never opened: Awaiting input… through the 1 s grace, then a read-only card from the row's arguments with the terminal note", () => {
    mount(new ThreadStore(snapshot([askRow("q", { status: "running", result: null })], { live: live({ working: true }) })))
    expect(stateOf()).toBe("open")
    act(() => {
      vi.advanceTimersByTime(999)
    })
    expect(stateOf()).toBe("open")
    expect(screen.queryByTestId("ask-card")).toBeNull()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(stateOf()).toBe("no-item")
    const card = screen.getByTestId("ask-card")
    expect(within(card).getByText("Which color?")).toBeTruthy()
    expect(within(card).getByText("Green")).toBeTruthy()
    expect(within(card).getByText("Blue")).toBeTruthy()
    expect(within(card).getByText("Answer in the terminal.")).toBeTruthy()
    expect(screen.queryByTestId("ask-panel")).toBeNull()
  })

  it("an ask that opens inside the grace is the open line, never the card", () => {
    const store = new ThreadStore(snapshot([askRow("q", { status: "running", result: null })], { live: live({ working: true }) }))
    mount(store)
    act(() => {
      vi.advanceTimersByTime(600)
      feeder(store)({ live: live({ working: true, asks: [questionAsk("call-q")] }) })
      vi.advanceTimersByTime(2000)
    })
    expect(stateOf()).toBe("open")
    expect(screen.queryByTestId("ask-card")).toBeNull()
  })

  it("a batch with no item shows its heading and every question", () => {
    const args = { question: "Setup", questions: [{ question: "Which language?", options: ["TypeScript", "Python"] }, { question: "Anything else?" }] }
    mount(new ThreadStore(snapshot([askRow("q", { status: "running", result: null, args })], { live: live({ working: true }) })))
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    const card = screen.getByTestId("ask-card")
    expect(within(card).getByText("Setup")).toBeTruthy()
    expect(within(card).getAllByTestId("ask-card-question")).toHaveLength(2)
    expect(within(card).getByText("Python")).toBeTruthy()
  })

  it("a call that is only live (no row yet) follows the same states, from the one argument pi-live sends", () => {
    const store = new ThreadStore(snapshot([user("u1")], { live: live({ working: true, tools: [{ callId: "c9", name: "ask_user", argument: "Which color?" }], asks: [questionAsk("c9")] }) }))
    mount(store)
    expect(screen.getByTestId("live-tool").getAttribute("data-ask-state")).toBe("open")
    expect(line()).toBe("Awaiting input…")
    act(() => {
      feeder(store)({ live: live({ working: true, tools: [{ callId: "c9", name: "ask_user", argument: "Which color?" }] }) })
    })
    expect(line()).toBe("Answered")
  })

  it("a live call that never opens becomes the card after the grace", () => {
    mount(new ThreadStore(snapshot([user("u1")], { live: live({ working: true, tools: [{ callId: "c9", name: "ask_user", argument: "Which color?" }] }) })))
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(within(screen.getByTestId("ask-card")).getByText("Which color?")).toBeTruthy()
  })

  it("seen is per thread: a reset to another session forgets it", () => {
    const store = new ThreadStore(snapshot([askRow("q", { status: "running", result: null })], { live: live({ working: true, asks: [questionAsk("call-q")] }) }))
    mount(store)
    act(() => {
      store.apply({ type: "reset", seq: 10, snapshot: snapshot([askRow("q", { status: "running", result: null })], { seq: 10, live: live({ working: true }) }) })
      store.flush()
    })
    expect(stateOf()).toBe("open") // grace again, not "Answered"
  })
})

describe("the line of a finished call", () => {
  it("answered: Asked · Answered, the selections joined, and it opens to a card with every option and the pick marked", () => {
    alone(askRow("q", { details: singleDetails({ kind: "selection", selections: ["Green", "Blue"] }) }))
    expect(line()).toBe("Asked: Which color? · Answered: Green, Blue")
    fireEvent.click(screen.getByRole("button"))
    const card = screen.getByTestId("ask-card")
    expect(card.querySelectorAll("[data-picked=true]")).toHaveLength(2)
    expect(within(card).queryByText("Answer in the terminal.")).toBeNull()
  })
  it("answered with a typed text", () => {
    alone(askRow("q", { details: singleDetails({ kind: "freeform", text: "Teal" }) }))
    expect(line()).toBe("Asked: Which color? · Answered: Teal")
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByTestId("ask-card-answer").textContent).toBe("Answered: Teal")
  })
  it("answered with a comment says + comment on the line and shows it in the card", () => {
    alone(askRow("q", { details: singleDetails({ kind: "selection", selections: ["Blue"], comment: "sky" }) }))
    expect(line()).toBe("Asked: Which color? · Answered: Blue + comment")
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByTestId("ask-card-comment").textContent).toBe("Comment: sky")
  })
  it("a batch says how many were answered, and its card has every question with its answer or skip", () => {
    const details = {
      kind: "batch",
      questions: [{ question: "Which language?", options: [{ title: "TypeScript" }, { title: "Python" }] }, { question: "Which checks?", options: [{ title: "lint" }] }, { question: "Anything else?", options: [] }, { question: "Fourth?", options: [] }],
      answers: [{ status: "answered", response: { kind: "selection", selections: ["Python"] } }, { status: "skipped" }, { status: "answered", response: { kind: "freeform", text: "no" } }, { status: "answered", response: { kind: "freeform", text: "yes" } }],
      cancelled: false,
    }
    alone(askRow("q", { args: { question: "Setup", questions: [] }, details }))
    expect(line()).toBe("Asked: Setup · 3 of 4 answered")
    fireEvent.click(screen.getByRole("button"))
    const card = screen.getByTestId("ask-card")
    expect(within(card).getAllByTestId("ask-card-question")).toHaveLength(4)
    expect(within(card).getByText("Skipped")).toBeTruthy()
    expect(card.querySelectorAll("[data-picked=true]")).toHaveLength(1)
  })
  it("a batch whose every question was skipped says 0 of N answered", () => {
    const details = { kind: "batch", questions: [{ question: "a", options: [] }, { question: "b", options: [] }, { question: "c", options: [] }], answers: [{ status: "skipped" }, { status: "skipped" }, { status: "skipped" }], cancelled: false }
    alone(askRow("q", { args: { question: "Setup", questions: [] }, details }))
    expect(line()).toBe("Asked: Setup · 0 of 3 answered")
  })
  it("a batch's heading comes from its details when the arguments are gone", () => {
    const details = { kind: "batch", heading: "From details", questions: [{ question: "a", options: [] }], answers: [{ status: "answered", response: { kind: "freeform", text: "x" } }], cancelled: false }
    alone(askRow("q", { args: {}, details }))
    expect(line()).toBe("Asked: From details · 1 of 1 answered")
  })
  it("a batch with no heading is named by how many questions it had", () => {
    const details = { kind: "batch", questions: [{ question: "a", options: [] }, { question: "b", options: [] }], answers: [{ status: "answered", response: { kind: "freeform", text: "x" } }, { status: "skipped" }], cancelled: false }
    alone(askRow("q", { args: { questions: [] }, details }))
    expect(line()).toBe("Asked: 2 questions · 1 of 2 answered")
  })
  it("not answered (Esc, a timeout, or Stop): muted, no card to open", () => {
    alone(askRow("q", { details: singleDetails(null, true), result: { text: "User cancelled the question(s)", truncated: false, totalChars: 30 } }))
    expect(line()).toBe("Asked: Which color? · Not answered")
    expect(screen.queryByRole("button")).toBeNull()
  })
  it("a cancelled batch is Not answered too", () => {
    alone(askRow("q", { args: { question: "Setup", questions: [] }, details: { kind: "batch", questions: [{ question: "a", options: [] }], answers: [], cancelled: true } }))
    expect(line()).toBe("Asked: Setup · Not answered")
  })
  it("stopped: the pi went away mid-ask and the row has no result", () => {
    alone(askRow("q", { status: "interrupted", result: null }))
    expect(line()).toBe("Asked: Which color? · Stopped")
  })
  it("error: today's error line, with the tool's name and failed", () => {
    alone(askRow("q", { status: "error", details: { error: "UI unavailable" }, result: { text: "UI unavailable", truncated: false, totalChars: 14 } }))
    expect(screen.queryByTestId("row-ask")).toBeNull()
    const row = screen.getByTestId("row-tool")
    expect(row.getAttribute("data-status")).toBe("error")
    expect(within(row).getByTestId("tool-error").textContent).toBe("failed")
  })
  it("no details (an old row, or details over the cap): the question and the result's own words", () => {
    alone(askRow("q", { result: { text: "User answered: Blue", truncated: false, totalChars: 19 } }))
    expect(line()).toBe("Asked: Which color? · Blue")
    expect(stateOf()).toBe("no-details")
  })
  it("no details and no result still says what was asked", () => {
    alone(askRow("q", { result: null }))
    expect(line()).toBe("Asked: Which color? · ")
  })
  it("a row that is shown alone (no thread) is never `answered by us`: running shows the card after the grace", () => {
    alone(askRow("q", { status: "running", result: null }))
    expect(stateOf()).toBe("open")
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(stateOf()).toBe("no-item")
  })
})

describe("the panel and the thread together", () => {
  it("while a question is open the panel is where the composer was, and the thread says Awaiting input…; both go with the ask", () => {
    const store = new ThreadStore(snapshot([user("u1"), assistant("a1"), askRow("q", { status: "running", result: null })], { live: live({ working: true, asks: [questionAsk("call-q")] }) }))
    mount(store)
    expect(screen.getByTestId("ask-panel")).toBeTruthy()
    expect(screen.queryByTestId("composer")).toBeNull()
    expect(line()).toBe("Awaiting input…")
    act(() => {
      feeder(store)({ rows: [askRow("q", { details: singleDetails(blue) })], live: live() })
    })
    expect(screen.queryByTestId("ask-panel")).toBeNull()
    expect(screen.getByTestId("composer")).toBeTruthy()
    expect(line()).toBe("Asked: Which color? · Answered: Blue")
  })
  it("a batch opens the same panel", () => {
    mount(new ThreadStore(snapshot([user("u1")], { live: live({ working: true, asks: [batchAsk("b1")] }) })))
    expect(screen.getByTestId("ask-panel")).toBeTruthy()
  })
})
