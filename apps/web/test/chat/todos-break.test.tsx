// @vitest-environment jsdom
// Break-tests for the todo card (DEV-41): the live region's pace, state kept or lost, odd lists, the ask panel beside it.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { TodoTask, Todos } from "@herdr-web/agents/rows"
import { ChatView } from "@/components/chat/chat-view"
import { TodoPanel } from "@/components/chat/todo"
import { ThreadStore } from "@/lib/chat/thread-store"
import { blockedLabel, describeTodoCall, foldTodos } from "@/lib/chat/todos"
import { assistant, fakeActions, feeder, live, questionAsk, snapshot, user } from "./helpers"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const t = (id: number, status: TodoTask["status"], extra: Partial<TodoTask> = {}): TodoTask => ({ id, subject: `Task ${id}`, status, ...extra })
const list = (...tasks: TodoTask[]): Todos => ({ tasks })
const panel = (todos: Todos, working = true) => <TodoPanel todos={todos} working={working} />

describe("fold edges", () => {
  it("5 tasks never fold, 6 fold, in every mix", () => {
    for (const statuses of [
      ["pending", "pending", "pending", "pending", "pending"],
      ["completed", "completed", "completed", "completed", "in_progress"],
      ["completed", "completed", "completed", "completed", "completed"],
    ] as const) {
      const five = statuses.map((s, i) => t(i + 1, s))
      expect(foldTodos(five)).toEqual({ shown: five, hiddenDone: 0, hiddenOpen: 0 })
    }
    const six = foldTodos(Array.from({ length: 6 }, (_, i) => t(i + 1, "pending")))
    expect(six.shown).toHaveLength(3)
    expect(six).toMatchObject({ hiddenDone: 0, hiddenOpen: 3 })
  })

  it("6 tasks with five done: `✓ 5 done` and one row, no `+N more`", () => {
    render(panel(list(...Array.from({ length: 5 }, (_, i) => t(i + 1, "completed")), t(6, "in_progress"))))
    expect(screen.getByTestId("todos-done-fold").textContent).toContain("5 done")
    expect(screen.getAllByTestId("todo-task")).toHaveLength(1)
    expect(screen.queryByTestId("todos-more")).toBeNull()
  })

  it("6 tasks with exactly three open and three done: nothing hidden among the open", () => {
    const f = foldTodos([t(1, "completed"), t(2, "completed"), t(3, "completed"), t(4, "in_progress"), t(5, "pending"), t(6, "pending")])
    expect(f).toMatchObject({ hiddenDone: 3, hiddenOpen: 0 })
  })

  it("a pending task before the one in progress stays in list order; the in-progress one is never hidden", () => {
    const f = foldTodos([t(1, "pending"), t(2, "pending"), t(3, "pending"), t(4, "pending"), t(5, "pending"), t(6, "in_progress")])
    expect(f.shown.map((x) => x.id)).toContain(6)
    expect(f.shown).toHaveLength(3)
  })

  it("more than three in progress all show (never hide live work)", () => {
    const f = foldTodos(Array.from({ length: 8 }, (_, i) => t(i + 1, i < 5 ? "in_progress" : "pending")))
    expect(f.shown.filter((x) => x.status === "in_progress")).toHaveLength(5)
  })

  it("after `+N more` is opened and the list shrinks to five, nothing is lost and there is no stray `Show less`", () => {
    const big = list(...Array.from({ length: 8 }, (_, i) => t(i + 1, "pending")))
    const { rerender } = render(panel(big))
    fireEvent.click(screen.getByTestId("todos-more"))
    rerender(panel(list(t(1, "pending"), t(2, "pending"), t(3, "pending"))))
    expect(screen.getAllByTestId("todo-task")).toHaveLength(3)
    expect(screen.queryByTestId("todos-less")).toBeNull()
  })

  it("blockedLabel with a self-reference, a repeat and a huge list stays short and does not throw", () => {
    const all = [t(1, "pending", { blockedBy: [1, 1, 2] }), t(2, "pending")]
    expect(blockedLabel(all[0]!, all)).toBe("after #1, #1, #2")
    const many = t(3, "pending", { blockedBy: Array.from({ length: 500 }, (_, i) => i) })
    expect(() => blockedLabel(many, [many])).not.toThrow()
  })
})

describe("the live region", () => {
  it("announces at most once in 3 s, and the last change always lands", () => {
    vi.useFakeTimers()
    const first = list(t(1, "in_progress", { activeForm: "One" }), t(2, "pending"))
    const { rerender } = render(panel(first))
    const live_ = () => screen.getByTestId("todos-live").textContent
    rerender(panel(list(t(1, "completed"), t(2, "in_progress", { activeForm: "Two" }))))
    act(() => void vi.advanceTimersByTime(5))
    expect(live_()).toContain("Two")
    // within 3 s of that: two more changes arrive; none shows before 3 s are over
    act(() => void vi.advanceTimersByTime(500))
    rerender(panel(list(t(1, "completed"), t(2, "completed"), t(3, "in_progress", { activeForm: "Three" }))))
    act(() => void vi.advanceTimersByTime(500))
    rerender(panel(list(t(1, "completed"), t(2, "completed"), t(3, "completed"), t(4, "in_progress", { activeForm: "Four" }))))
    act(() => void vi.advanceTimersByTime(1900))
    expect(live_()).toContain("Two")
    expect(live_()).not.toContain("Four")
    act(() => void vi.advanceTimersByTime(1200))
    expect(live_()).toContain("Four")
  })

  it("a change that comes back to what was said does not announce again", () => {
    vi.useFakeTimers()
    const a = list(t(1, "in_progress", { activeForm: "A" }))
    const b = list(t(1, "in_progress", { activeForm: "B" }))
    const { rerender } = render(panel(a))
    rerender(panel(b))
    rerender(panel(a))
    act(() => void vi.advanceTimersByTime(4000))
    expect(screen.getByTestId("todos-live").textContent).toContain("A")
  })

  it("an unmounted card leaves no timer behind", () => {
    vi.useFakeTimers()
    const { rerender, unmount } = render(panel(list(t(1, "in_progress", { activeForm: "A" }))))
    rerender(panel(list(t(1, "in_progress", { activeForm: "B" }))))
    rerender(panel(list(t(1, "in_progress", { activeForm: "C" }))))
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("the live region is not in the tab order and the toggle is a real button with aria-expanded", () => {
    render(panel(list(t(1, "pending"))))
    expect(screen.getByTestId("todos-toggle").tagName).toBe("BUTTON")
    expect(screen.getByTestId("todos-live").getAttribute("tabindex")).toBeNull()
    expect(screen.getByTestId("todos-live").getAttribute("role")).toBe("status")
  })
})

describe("what the card remembers", () => {
  // The ticket allows "remembered per thread"; the card unmounts when the list goes, so a collapse does not survive a list that goes and returns.
  it("a collapsed card stays collapsed while the list updates", () => {
    const { rerender } = render(panel(list(t(1, "in_progress"), t(2, "pending"))))
    fireEvent.click(screen.getByTestId("todos-toggle"))
    rerender(panel(list(t(1, "completed"), t(2, "in_progress"))))
    expect(screen.getByTestId("todos-toggle").getAttribute("aria-expanded")).toBe("false")
    expect(screen.getByTestId("todos-current").textContent).toBe("· Task 2")
  })

  it("a collapsed card, its list dropped and a new one written, opens again (not remembered across the drop)", () => {
    const store = new ThreadStore(snapshot([user("u1")], { todos: list(t(1, "in_progress")) }))
    render(<ChatView store={store} actions={fakeActions()} disabledReason={null} draftKey="t1" onShowTerminal={() => {}} />)
    fireEvent.click(screen.getByTestId("todos-toggle"))
    act(() => void feeder(store)({ todos: null }))
    act(() => void feeder(store)({ todos: list(t(1, "in_progress")) }))
    // documents today's behaviour: the choice is gone
    expect(screen.getByTestId("todos-toggle").getAttribute("aria-expanded")).toBe("true")
  })

  it("another thread (a new draftKey) starts open", () => {
    const store = new ThreadStore(snapshot([user("u1")], { todos: list(t(1, "in_progress")) }))
    const { rerender } = render(<ChatView store={store} actions={fakeActions()} disabledReason={null} draftKey="t1" onShowTerminal={() => {}} />)
    fireEvent.click(screen.getByTestId("todos-toggle"))
    rerender(<ChatView store={store} actions={fakeActions()} disabledReason={null} draftKey="t2" onShowTerminal={() => {}} />)
    expect(screen.getByTestId("todos-toggle").getAttribute("aria-expanded")).toBe("true")
  })
})

describe("odd lists", () => {
  // rpiv-todo numbers its tasks from a counter, so this is hostile input only; React drops/duplicates rows on a later update.
  it("duplicate ids render both rows without a React error", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    render(panel(list(t(1, "pending"), t(1, "completed"))))
    expect(screen.getAllByTestId("todo-task")).toHaveLength(2)
    expect(err).not.toHaveBeenCalled()
  })

  it("an empty subject and an empty collapsed label do not throw", () => {
    render(panel(list({ id: 1, subject: "", status: "in_progress" })))
    fireEvent.click(screen.getByTestId("todos-toggle"))
    expect(screen.getByTestId("todos-count").textContent).toBe("0/1")
  })

  it("an empty list renders a card with 0/0 and no NaN width (the store never sends one, but a bad client might)", () => {
    render(panel(list()))
    fireEvent.click(screen.getByTestId("todos-toggle"))
    expect((screen.getByTestId("todos-meter").firstElementChild as HTMLElement).style.width).toBe("0%")
  })

  it("markup in a subject is text", () => {
    render(panel(list(t(1, "pending", { subject: "<img src=x onerror=alert(1)> **bold** [a](javascript:alert(1))" }))))
    expect(document.querySelector("img")).toBeNull()
    expect(screen.getByTestId("todo-task").textContent).toContain("<img src=x")
  })

  it("three hundred tasks, opened, render in well under a second", () => {
    const many = list(...Array.from({ length: 300 }, (_, i) => t(i + 1, i < 100 ? "completed" : "pending")))
    render(panel(many))
    const t0 = performance.now()
    fireEvent.click(screen.getByTestId("todos-more"))
    expect(screen.getAllByTestId("todo-task")).toHaveLength(300)
    expect(performance.now() - t0).toBeLessThan(1000)
  })

  it("the todo row line with a very long subject gets truncated by class, not by cutting the text", () => {
    expect(describeTodoCall({ action: "update", id: 1, status: "completed" }, { action: "update", tasks: [{ id: 1, subject: "x".repeat(300) }] })).toHaveLength("Completed: ".length + 300)
  })
})

describe("the store", () => {
  it("todos: undefined keeps, null clears, a list replaces; a stale or gapped update changes nothing", () => {
    const store = new ThreadStore(snapshot([user("u1")], { todos: list(t(1, "pending")) }))
    const send = feeder(store)
    send({ rows: [assistant("a1")] })
    expect(store.getState().todos).toEqual(list(t(1, "pending")))
    send({ todos: null })
    expect(store.getState().todos).toBeNull()
    send({ todos: list(t(2, "pending")) })
    const seq = store.getState().seq
    expect(store.apply({ type: "update", seq: seq, todos: list(t(9, "completed")) })).not.toBe("applied") // already seen
    expect(store.apply({ type: "update", seq: seq + 5, todos: list(t(9, "completed")) })).not.toBe("applied") // a gap
    expect(store.getState().todos).toEqual(list(t(2, "pending")))
  })

  it("a reset takes the todos of its snapshot, and none means none", () => {
    const store = new ThreadStore(snapshot([user("u1")], { todos: list(t(1, "pending")) }))
    store.replace(snapshot([user("u9")]))
    expect(store.getState().todos).toBeNull()
    store.replace(snapshot([user("u9")], { todos: list(t(4, "in_progress")) }))
    expect(store.getState().todos).toEqual(list(t(4, "in_progress")))
  })

  it("older rows prepended do not touch the list", () => {
    const store = new ThreadStore(snapshot([user("u2")], { hasMore: true, todos: list(t(1, "pending")) }))
    store.prepend([user("u1")], false)
    expect(store.getState().todos).toEqual(list(t(1, "pending")))
  })
})

describe("beside the ask panel", () => {
  it("the card, the ask panel and the composer are all there; the card first", () => {
    const store = new ThreadStore(snapshot([user("u1")], { todos: list(t(1, "in_progress")), live: live({ working: true, asks: [questionAsk("p1")] }) }))
    render(<ChatView store={store} actions={fakeActions()} disabledReason={null} draftKey="t1" onShowTerminal={() => {}} />)
    const card = screen.getByTestId("todos")
    const ask = screen.getByTestId("ask-panel")
    expect(card.compareDocumentPosition(ask) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0)
  })

  it("the card folds to its header while a question is open and opens again when it is answered; a fold the user made stays", () => {
    const store = new ThreadStore(snapshot([user("u1")], { todos: list(t(1, "in_progress"), t(2, "pending")), live: live({ working: true, asks: [questionAsk("p1")] }) }))
    render(<ChatView store={store} actions={fakeActions()} disabledReason={null} draftKey="t1" onShowTerminal={() => {}} />)
    expect(screen.getByTestId("todos-toggle").getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryAllByTestId("todo-task")).toHaveLength(0)
    act(() => void feeder(store)({ live: live({ working: true, asks: [] }) }))
    expect(screen.getByTestId("todos-toggle").getAttribute("aria-expanded")).toBe("true")
    fireEvent.click(screen.getByTestId("todos-toggle"))
    act(() => void feeder(store)({ live: live({ working: true, asks: [questionAsk("p2")] }) }))
    act(() => void feeder(store)({ live: live({ working: true, asks: [] }) }))
    expect(screen.getByTestId("todos-toggle").getAttribute("aria-expanded")).toBe("false")
  })
})
