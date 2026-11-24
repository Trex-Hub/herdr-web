// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { TodoTask, Todos } from "@herdr-web/agents/rows"
import { ChatView } from "@/components/chat/chat-view"
import { RowView } from "@/components/chat/rows"
import { TodoPanel } from "@/components/chat/todo"
import { ThreadStore } from "@/lib/chat/thread-store"
import { blockedLabel, countTodos, currentTask, describeTodoCall, foldTodos, readTodoRowDetails, taskLabel } from "@/lib/chat/todos"
import { assistant, fakeActions, feeder, live, snapshot, tool, user } from "./helpers"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const t = (id: number, status: TodoTask["status"], extra: Partial<TodoTask> = {}): TodoTask => ({ id, subject: `Task ${id}`, status, ...extra })
const list = (...tasks: TodoTask[]): Todos => ({ tasks })

describe("the numbers and the current task", () => {
  it("counts done out of all", () => {
    expect(countTodos([t(1, "completed"), t(2, "pending"), t(3, "in_progress")])).toEqual({ done: 1, total: 3 })
  })
  it("the current task is the one in progress, else the first waiting, else none", () => {
    expect(currentTask([t(1, "pending"), t(2, "in_progress"), t(3, "pending")])?.id).toBe(2)
    expect(currentTask([t(1, "completed"), t(2, "pending")])?.id).toBe(2)
    expect(currentTask([t(1, "completed")])).toBeNull()
  })
  it("a task in progress reads as its activeForm, any other as its subject", () => {
    expect(taskLabel(t(1, "in_progress", { activeForm: "Doing it" }))).toBe("Doing it")
    expect(taskLabel(t(1, "pending", { activeForm: "Doing it" }))).toBe("Task 1")
    expect(taskLabel(t(1, "in_progress"))).toBe("Task 1")
  })
  it("blocked by tasks not done only", () => {
    const all = [t(1, "completed"), t(2, "pending"), t(3, "pending", { blockedBy: [1, 2, 9] })]
    expect(blockedLabel(all[2]!, all)).toBe("after #2")
    expect(blockedLabel(t(4, "pending", { blockedBy: [1] }), all)).toBeNull()
    expect(blockedLabel(t(5, "pending"), all)).toBeNull()
  })
})

describe("folding a long list", () => {
  const many = [t(1, "completed"), t(2, "completed"), t(3, "in_progress"), t(4, "pending"), t(5, "pending"), t(6, "pending"), t(7, "pending")]
  it("five or fewer never fold", () => {
    const five = many.slice(0, 5)
    expect(foldTodos(five)).toEqual({ shown: five, hiddenDone: 0, hiddenOpen: 0 })
  })
  it("done become a count, then the live task and the next two, then the rest as a count", () => {
    const f = foldTodos(many)
    expect(f.shown.map((x) => x.id)).toEqual([3, 4, 5])
    expect(f).toMatchObject({ hiddenDone: 2, hiddenOpen: 2 })
  })
  it("with nothing live, the first three waiting show", () => {
    const f = foldTodos([t(1, "completed"), t(2, "completed"), t(3, "pending"), t(4, "pending"), t(5, "pending"), t(6, "pending")])
    expect(f.shown.map((x) => x.id)).toEqual([3, 4, 5])
    expect(f).toMatchObject({ hiddenDone: 2, hiddenOpen: 1 })
  })
  it("two in progress both show", () => {
    const f = foldTodos([t(1, "in_progress"), t(2, "in_progress"), t(3, "pending"), t(4, "pending"), t(5, "pending"), t(6, "pending")])
    expect(f.shown.map((x) => x.id)).toEqual([1, 2, 3])
  })
  it("a long list that is all done shows whole", () => {
    const done = Array.from({ length: 7 }, (_, i) => t(i + 1, "completed"))
    expect(foldTodos(done).shown).toHaveLength(7)
  })
})

describe("the todo panel", () => {
  const mount = (todos: Todos, working = true) => render(<TodoPanel todos={todos} working={working} />)

  it("shows every status: count, labels, activeForm under the one in progress, blockedBy, struck-through done", () => {
    mount(list(t(1, "completed"), t(2, "in_progress", { activeForm: "Doing task 2" }), t(3, "pending", { blockedBy: [2] })))
    expect(screen.getByTestId("todos-count").textContent).toBe("1/3")
    const rows = screen.getAllByTestId("todo-task")
    expect(rows.map((r) => r.getAttribute("data-status"))).toEqual(["completed", "in_progress", "pending"])
    expect(within(rows[1]!).getByTestId("todo-active").textContent).toBe("Doing task 2")
    expect(within(rows[2]!).getByTestId("todo-blocked").textContent).toBe("after #2")
    expect(rows[0]!.querySelector(".line-through")).not.toBeNull()
    expect(rows[0]!.textContent).toContain("Done: Task 1") // state first, for a screen reader
    expect(rows[1]!.textContent).toContain("In progress: ")
    expect(rows[2]!.textContent).toContain("Pending: ")
    expect(screen.queryByTestId("todos-done-fold")).toBeNull()
  })

  it("a done task does not show what it was waiting on", () => {
    mount(list(t(1, "completed"), t(2, "completed", { blockedBy: [1] })))
    expect(screen.queryByTestId("todo-blocked")).toBeNull()
  })

  it("the ring turns while the agent works and stops when it does not", () => {
    const { rerender } = mount(list(t(1, "in_progress")))
    expect(screen.getByTestId("todo-mark").getAttribute("data-spinning")).toBe("true")
    rerender(<TodoPanel todos={list(t(1, "in_progress"))} working={false} />)
    expect(screen.getByTestId("todo-mark").getAttribute("data-spinning")).toBe("false")
  })

  it("collapses to the current task and a meter, and opens again", () => {
    mount(list(t(1, "completed"), t(2, "in_progress", { activeForm: "Doing task 2" })))
    fireEvent.click(screen.getByTestId("todos-toggle"))
    expect(screen.queryAllByTestId("todo-task")).toHaveLength(0)
    expect(screen.getByTestId("todos-current").textContent).toBe("· Doing task 2")
    expect(screen.getByTestId("todos-meter")).toBeTruthy()
    expect(screen.getByTestId("todos-toggle").getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(screen.getByTestId("todos-toggle"))
    expect(screen.getAllByTestId("todo-task")).toHaveLength(2)
  })

  it("folds a long list with `✓ N done` and `+N more`; either shows every row; Show less folds again", () => {
    mount(list(t(1, "completed"), t(2, "completed"), t(3, "in_progress"), t(4, "pending"), t(5, "pending"), t(6, "pending"), t(7, "pending")))
    expect(screen.getAllByTestId("todo-task")).toHaveLength(3)
    expect(screen.getByTestId("todos-done-fold").textContent).toContain("2 done")
    expect(screen.getByTestId("todos-more").textContent).toBe("+2 more")
    fireEvent.click(screen.getByTestId("todos-more"))
    expect(screen.getAllByTestId("todo-task")).toHaveLength(7)
    expect(screen.queryByTestId("todos-more")).toBeNull()
    fireEvent.click(screen.getByTestId("todos-less"))
    expect(screen.getAllByTestId("todo-task")).toHaveLength(3)
    fireEvent.click(screen.getByTestId("todos-done-fold"))
    expect(screen.getAllByTestId("todo-task")).toHaveLength(7)
  })

  it("a short list has no Show less", () => {
    mount(list(t(1, "pending")))
    expect(screen.queryByTestId("todos-less")).toBeNull()
  })

  it("tasks named like Object properties are only text", () => {
    mount(list({ id: 1, subject: "__proto__", status: "pending", activeForm: "constructor" }, { id: 2, subject: "toString", status: "in_progress", activeForm: "hasOwnProperty" }))
    expect(screen.getAllByTestId("todo-task").map((r) => r.textContent)).toEqual(["Pending: __proto__", "In progress: toStringhasOwnProperty"])
  })

  it("names the live task in a polite live region, at most every 3 s", () => {
    vi.useFakeTimers()
    const { rerender } = mount(list(t(1, "in_progress", { activeForm: "First" }), t(2, "pending")))
    expect(screen.getByTestId("todos-live").getAttribute("aria-live")).toBe("polite")
    expect(screen.getByTestId("todos-live").textContent).toBe("Working on: First. 0 of 2 done.")
    rerender(<TodoPanel todos={list(t(1, "completed"), t(2, "in_progress", { activeForm: "Second" }))} working />)
    rerender(<TodoPanel todos={list(t(1, "completed"), t(2, "in_progress", { activeForm: "Third" }))} working />)
    act(() => void vi.advanceTimersByTime(10))
    expect(screen.getByTestId("todos-live").textContent).toContain("Working on: Third") // the first change lands at once, the later one waits only when one just landed
    act(() => void vi.advanceTimersByTime(3000))
    expect(screen.getByTestId("todos-live").textContent).toContain("Third")
  })
})

describe("the card in the chat", () => {
  const mount = (store: ThreadStore) => render(<ChatView store={store} actions={fakeActions()} disabledReason={null} draftKey="t1" onShowTerminal={() => {}} />)

  it("is above the composer, only while there is a list", () => {
    const store = new ThreadStore(snapshot([user("u1")], { todos: list(t(1, "pending")) }))
    mount(store)
    const card = screen.getByTestId("todos")
    const composer = screen.getByTestId("composer")
    expect(card.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    act(() => void feeder(store)({ todos: null }))
    expect(screen.queryByTestId("todos")).toBeNull()
    act(() => void feeder(store)({ todos: list(t(1, "in_progress")), live: live({ working: true }) }))
    expect(screen.getByTestId("todos-count").textContent).toBe("0/1")
  })

  it("an update without `todos` leaves the list as it was; a new one replaces it whole", () => {
    const store = new ThreadStore(snapshot([user("u1")], { todos: list(t(1, "pending"), t(2, "pending")) }))
    mount(store)
    act(() => void feeder(store)({ rows: [assistant("a1")] }))
    expect(screen.getAllByTestId("todo-task")).toHaveLength(2)
    act(() => void feeder(store)({ todos: list(t(1, "completed")) }))
    expect(screen.getAllByTestId("todo-task")).toHaveLength(1)
  })

  it("a snapshot from an older backend has none", () => {
    mount(new ThreadStore(snapshot([user("u1")])))
    expect(screen.queryByTestId("todos")).toBeNull()
  })
})

describe("the todo tool row", () => {
  const row = (args: Record<string, unknown>, details: unknown, over: Partial<Extract<ReturnType<typeof tool>, { kind: "tool" }>> = {}) =>
    tool("t1", { name: "todo", args, details, ...over })
  const tasks = [t(1, "completed", { subject: "Read the code" }), t(2, "in_progress", { subject: "Fix it" }), t(3, "deleted" as never, { subject: "Gone" })]
  const show = (r: ReturnType<typeof tool>) => render(<RowView row={r} end={false} fullResult={async () => ""} />)

  it.each([
    [{ action: "create", tasks: [{ subject: "a" }, { subject: "b" }, { subject: "c" }] }, "Added 3 tasks"],
    [{ action: "create", tasks: [{ subject: "a" }] }, "Added 1 task"],
    [{ action: "create", subject: "One more" }, "Added: One more"],
    [{ action: "update", id: 2, status: "in_progress" }, "Started: Fix it"],
    [{ action: "update", id: 1, status: "completed" }, "Completed: Read the code"],
    [{ action: "update", id: 3, status: "deleted" }, "Removed: Gone"],
    [{ action: "update", id: 2, status: "pending" }, "Reset: Fix it"],
    [{ action: "update", id: 2, subject: "Renamed" }, "Updated: Fix it"],
    [{ action: "update", id: 99, status: "completed" }, "Completed: #99"],
    [{ action: "update" }, "Updated the list"],
    [{ action: "delete", id: 3 }, "Removed: Gone"],
    [{ action: "clear" }, "Cleared the list"],
    [{ action: "list" }, "Checked the list"],
    [{ action: "get", id: 1 }, "Checked the list"],
  ])("%j reads %s", (args, text) => {
    show(row(args, { action: args.action, tasks }))
    expect(screen.getByTestId("row-todo").textContent).toBe(text)
  })

  it("an action it does not know, an error, a running or stopped call, and details that are not there are the plain tool line", () => {
    for (const r of [
      row({ action: "teleport" }, { action: "teleport", tasks }),
      row({ action: "update", id: 1 }, { action: "update", tasks, error: "no such task" }),
      row({ action: "update", id: 1, status: "completed" }, { action: "update", tasks }, { status: "running", result: null, durationMs: null }),
      row({ action: "update", id: 1, status: "completed" }, { action: "update", tasks }, { status: "interrupted", result: null, durationMs: null }),
      row({ action: "update", id: 1, status: "completed" }, { action: "update", tasks }, { status: "error" }),
      row({ action: "update", id: 1, status: "completed" }, undefined),
      row({ action: "update", id: 1, status: "completed" }, "nope"),
      row({ action: "update", id: 1, status: "completed" }, { action: "update", tasks: "nope" }),
    ]) {
      const { unmount } = show(r)
      expect(screen.queryByTestId("row-todo")).toBeNull()
      expect(screen.getByText("todo")).toBeTruthy()
      unmount()
    }
  })

  it("a status or task named like an Object property is not a verb or a task", () => {
    expect(describeTodoCall({ action: "update", id: 1, status: "constructor" }, { action: "update", tasks: [{ id: 1, subject: "__proto__" }] })).toBe("Updated: __proto__")
    expect(describeTodoCall({ action: "toString" }, { action: "toString", tasks: [] })).toBeNull()
    expect(readTodoRowDetails({ action: "update", tasks: [{ id: "x", subject: 1 }, null, 5] })).toEqual({ action: "update", tasks: [] })
  })
})
