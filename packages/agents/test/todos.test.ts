import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { buildRows } from "../src/pi/rows.js"
import { SessionLog } from "../src/pi/session-log.js"
import { DETAILS_CUT, PAGE_SIZE, ThreadChangeSchema, ThreadSnapshotSchema, type Todos, type ToolRow } from "../src/rows.js"
import { appendEntries, assistantEntry, ext, openThread, sessionHeader, tmpDir, toolResultEntry, userEntry } from "./helpers.js"

type Status = "pending" | "in_progress" | "completed" | "deleted"
const task = (id: number, status: Status, extra: Record<string, unknown> = {}) => ({ id, subject: `Task ${id}`, status, ...extra })
const details = (tasks: unknown[], extra: Record<string, unknown> = {}) => ({ action: "update", params: {}, tasks, nextId: 100, ...extra })
const stateEntry = (id: string, parent: string | null, data: unknown) => ({ type: "custom", customType: "rpiv-todo-state", id, parentId: parent, timestamp: "2026-11-15T10:00:03.000Z", data })
const call = (parent: string | null, id: string, callId: string) => assistantEntry(parent, [{ type: "toolCall", id: callId, name: "todo", arguments: { action: "update" } }], id)
const result = (parent: string, callId: string, data: unknown, id: string) => toolResultEntry(parent, callId, "ok", false, id, "todo", data)

function walk(entries: unknown[]) {
  const file = path.join(tmpDir(), "s.jsonl")
  fs.writeFileSync(file, [sessionHeader, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n")
  const log = new SessionLog(file)
  log.refresh()
  return buildRows(log.branch(null).path, log.broken, false)
}
const todosOf = (entries: unknown[]): Todos | null => walk(entries).todos

describe("the todo list from the session file", () => {
  it("none when the agent never wrote one", () => {
    expect(todosOf([userEntry(null, "hi", "u1")])).toBeNull()
  })

  it("the snapshot of a todo tool result, without the tasks the agent deleted and without what the app does not show", () => {
    const todos = todosOf([
      userEntry(null, "plan it", "u1"),
      call("u1", "a1", "c1"),
      result("a1", "c1", details([task(1, "completed"), task(2, "in_progress", { activeForm: "Doing 2", blockedBy: [1], description: "long", owner: "x", metadata: { a: 1 } }), task(3, "pending"), task(4, "deleted")]), "r1"),
    ])
    expect(todos).toEqual({ tasks: [task(1, "completed"), task(2, "in_progress", { activeForm: "Doing 2", blockedBy: [1] }), task(3, "pending")] })
  })

  it("the last valid snapshot wins, and a snapshot that does not check out is skipped whole", () => {
    const bad = [
      details([task(1, "completed"), { id: "x", subject: "no", status: "pending" }]), // id not an integer
      details([task(1, "completed"), { id: 2, subject: "Task 2", status: "started" }]), // status not one of the four
      details([task(1, "completed"), { id: 2, subject: 5, status: "pending" }]),
      details([task(1, "completed"), task(2, "pending", { blockedBy: ["a"] })]),
      { action: "update", tasks: [task(1, "completed")] }, // no nextId
      { tasks: "nope", nextId: 1 },
      "text",
    ]
    const entries: unknown[] = [userEntry(null, "go", "u1"), call("u1", "a1", "c1"), result("a1", "c1", details([task(1, "in_progress"), task(2, "pending")]), "r1")]
    let parent = "r1"
    bad.forEach((d, i) => {
      entries.push(call(parent, `a${i + 2}`, `c${i + 2}`), result(`a${i + 2}`, `c${i + 2}`, d, `r${i + 2}`))
      parent = `r${i + 2}`
    })
    expect(todosOf(entries)).toEqual({ tasks: [task(1, "in_progress"), task(2, "pending")] })
    entries.push(call(parent, "az", "cz"), result("az", "cz", details([task(1, "completed"), task(2, "in_progress")]), "rz"))
    expect(todosOf(entries)).toEqual({ tasks: [task(1, "completed"), task(2, "in_progress")] })
  })

  it("duplicate ids make a snapshot invalid", () => {
    const entries = [userEntry(null, "go", "u1"), call("u1", "a1", "c1"), result("a1", "c1", details([task(1, "pending"), task(1, "completed")]), "r1")]
    expect(todosOf(entries)).toBeNull()
  })

  it("a failed todo call is not a snapshot", () => {
    const entries = [userEntry(null, "go", "u1"), call("u1", "a1", "c1"), toolResultEntry("a1", "c1", "boom", true, "r1", "todo", details([task(1, "pending")]))]
    expect(todosOf(entries)).toBeNull()
  })

  it("a call made through another tool lands as a state entry, and those are authoritative once there is one", () => {
    const entries = [
      userEntry(null, "go", "u1"),
      call("u1", "a1", "c1"),
      result("a1", "c1", details([task(1, "pending")]), "r1"),
      stateEntry("s1", "r1", details([task(1, "completed"), task(2, "in_progress")])),
      call("s1", "a2", "c2"),
      result("a2", "c2", details([task(1, "pending")]), "r2"), // older than the entry would have it: ignored
    ]
    expect(todosOf(entries)).toEqual({ tasks: [task(1, "completed"), task(2, "in_progress")] })
  })

  it("an invalid state entry is skipped, and with no valid one the tool results are replayed", () => {
    const entries = [userEntry(null, "go", "u1"), call("u1", "a1", "c1"), result("a1", "c1", details([task(1, "pending")]), "r1"), stateEntry("s1", "r1", { tasks: [{ id: 1.5 }], nextId: 1 })]
    expect(todosOf(entries)).toEqual({ tasks: [task(1, "pending")] })
  })

  it("a list with every task done is dropped when the user speaks again; one with work left stays", () => {
    const base = [userEntry(null, "go", "u1"), call("u1", "a1", "c1"), result("a1", "c1", details([task(1, "completed"), task(2, "completed")]), "r1")]
    expect(todosOf(base)).toEqual({ tasks: [task(1, "completed"), task(2, "completed")] })
    expect(todosOf([...base, userEntry("r1", "next thing", "u2")])).toBeNull()
    const open = [userEntry(null, "go", "u1"), call("u1", "a1", "c1"), result("a1", "c1", details([task(1, "completed"), task(2, "pending")]), "r1"), userEntry("r1", "and?", "u2")]
    expect(todosOf(open)).toEqual({ tasks: [task(1, "completed"), task(2, "pending")] })
  })

  it("a list written after it was dropped comes back", () => {
    const entries = [
      userEntry(null, "go", "u1"),
      call("u1", "a1", "c1"),
      result("a1", "c1", details([task(1, "completed")]), "r1"),
      userEntry("r1", "again", "u2"),
      call("u2", "a2", "c2"),
      result("a2", "c2", details([task(1, "completed"), task(2, "in_progress")]), "r2"),
    ]
    expect(todosOf(entries)).toEqual({ tasks: [task(1, "completed"), task(2, "in_progress")] })
  })

  it("none left to show (cleared, or all deleted) is none", () => {
    const entries = [userEntry(null, "go", "u1"), call("u1", "a1", "c1"), result("a1", "c1", details([task(1, "deleted")]), "r1")]
    expect(todosOf(entries)).toBeNull()
    expect(todosOf([...entries, call("r1", "a2", "c2"), result("a2", "c2", details([]), "r2")])).toBeNull()
  })

  it("a task named like an Object property is only text, and a status named like one is not a status", () => {
    const named = todosOf([userEntry(null, "go", "u1"), call("u1", "a1", "c1"), result("a1", "c1", details([{ id: 1, subject: "__proto__", status: "pending", activeForm: "toString" }, task(2, "pending", { subject: "constructor" })]), "r1")])
    expect(named).toEqual({ tasks: [{ id: 1, subject: "__proto__", status: "pending", activeForm: "toString" }, task(2, "pending", { subject: "constructor" })] })
    expect(todosOf([userEntry(null, "go", "u1"), call("u1", "a1", "c1"), result("a1", "c1", details([{ id: 1, subject: "x", status: "constructor" }]), "r1")])).toBeNull()
    expect(todosOf([userEntry(null, "go", "u1"), call("u1", "a1", "c1"), result("a1", "c1", details([{ id: 1, subject: "x", status: "__proto__" }]), "r1")])).toBeNull()
  })

  it("a runaway subject is cut, and a snapshot over the cap is not taken", () => {
    const cutOne = todosOf([userEntry(null, "go", "u1"), call("u1", "a1", "c1"), result("a1", "c1", details([{ id: 1, subject: "x".repeat(5000), status: "pending" }]), "r1")])
    expect(cutOne?.tasks[0]?.subject).toHaveLength(301)
    const many = Array.from({ length: 200 }, (_, i) => task(i + 1, "pending", { subject: "y".repeat(120) }))
    expect(JSON.stringify(many).length).toBeGreaterThan(DETAILS_CUT)
    const entries = [userEntry(null, "go", "u1"), call("u1", "a1", "c1"), result("a1", "c1", details([task(1, "pending")]), "r1"), call("r1", "a2", "c2"), result("a2", "c2", details(many), "r2")]
    expect(todosOf(entries)).toEqual({ tasks: [task(1, "pending")] })
  })

  it("the list is found however far back its call is, even when more than a page of rows came after", () => {
    const entries: unknown[] = [userEntry(null, "go", "u1"), call("u1", "a1", "c1"), result("a1", "c1", details([task(1, "in_progress")]), "r1")]
    let parent = "r1"
    for (let i = 0; i < PAGE_SIZE + 10; i++) {
      entries.push(assistantEntry(parent, [{ type: "text", text: `n${i}` }], `t${i}`))
      parent = `t${i}`
    }
    const built = walk(entries)
    expect(built.rows.length).toBeGreaterThan(PAGE_SIZE)
    expect(built.todos).toEqual({ tasks: [task(1, "in_progress")] })
  })
})

describe("the todo tool row", () => {
  it("carries the trimmed tasks of its result, deleted ones included, with the action", () => {
    const { rows } = walk([userEntry(null, "go", "u1"), call("u1", "a1", "c1"), result("a1", "c1", details([task(1, "completed", { description: "d" }), task(2, "deleted")], { action: "delete" }), "r1")])
    const row = rows.find((r): r is ToolRow => r.kind === "tool")
    expect(row?.details).toEqual({ action: "delete", tasks: [task(1, "completed"), task(2, "deleted")] })
  })

  it("carries the error of a call that changed nothing", () => {
    const { rows } = walk([userEntry(null, "go", "u1"), call("u1", "a1", "c1"), result("a1", "c1", details([task(1, "pending")], { error: "no such task" }), "r1")])
    const row = rows.find((r): r is ToolRow => r.kind === "tool")
    expect((row?.details as { error: string }).error).toBe("no such task")
  })

  it("has no details when the result's do not check out or are over the cap", () => {
    const bad = walk([userEntry(null, "go", "u1"), call("u1", "a1", "c1"), result("a1", "c1", { tasks: [{ id: "x" }], nextId: 1 }, "r1")])
    expect((bad.rows.find((r) => r.kind === "tool") as ToolRow).details).toBeUndefined()
  })
})

describe("the thread publishes the list", () => {
  const start = () => {
    const file = path.join(tmpDir(), "s.jsonl")
    fs.writeFileSync(file, [sessionHeader, userEntry(null, "go", "u1")].map((e) => JSON.stringify(e)).join("\n") + "\n")
    return file
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it("a snapshot carries it, and an update carries the whole new list when it changes, null when it goes", async () => {
    const file = start()
    const { thread, changes, snapshot } = openThread(file, {}, { leafId: "u1", working: true })
    expect(snapshot.todos ?? null).toBeNull()
    appendEntries(file, call("u1", "a1", "c1"), result("a1", "c1", details([task(1, "in_progress"), task(2, "pending")]), "r1"))
    thread.handle(ext({ type: "entries", leafId: "r1", replyDone: false }))
    await sleep(80)
    const withTodos = changes.map((c) => ThreadChangeSchema.parse(c)).filter((c) => c.type === "update" && c.todos !== undefined)
    expect(withTodos).toHaveLength(1)
    expect(withTodos[0]).toMatchObject({ type: "update", todos: { tasks: [task(1, "in_progress"), task(2, "pending")] } })
    expect(ThreadSnapshotSchema.parse(thread.snapshot()).todos).toEqual({ tasks: [task(1, "in_progress"), task(2, "pending")] })

    changes.length = 0
    appendEntries(file, call("r1", "a2", "c2"), result("a2", "c2", details([task(1, "completed"), task(2, "completed")]), "r2"), userEntry("r2", "new thing", "u2"))
    thread.handle(ext({ type: "entries", leafId: "u2", replyDone: false }))
    await sleep(80)
    const last = changes.map((c) => ThreadChangeSchema.parse(c)).filter((c) => c.type === "update" && c.todos !== undefined)
    expect(last.at(-1)).toMatchObject({ type: "update", todos: null })
    expect(thread.snapshot().todos ?? null).toBeNull()
  })

  it("an update that changes only something else does not repeat the list", async () => {
    const file = start()
    appendEntries(file, call("u1", "a1", "c1"), result("a1", "c1", details([task(1, "pending")]), "r1"))
    const { thread, changes, snapshot } = openThread(file, {}, { leafId: "r1", working: true })
    expect(snapshot.todos).toEqual({ tasks: [task(1, "pending")] })
    thread.handle(ext({ type: "reply", blocks: [{ kind: "text", text: "hm" }] }))
    expect(changes.map((c) => ThreadChangeSchema.parse(c)).every((c) => c.type === "update" && c.todos === undefined)).toBe(true)
  })
})

describe("the cap counts the tasks shown, not the tombstones", () => {
  it("a long session with many deleted tasks still shows its list; the row drops the tombstones when they alone are over the cap", () => {
    const gone = Array.from({ length: 400 }, (_, i) => task(i + 10, "deleted", { subject: "z".repeat(100) }))
    const entries = [userEntry(null, "go", "u1"), call("u1", "a1", "c1"), result("a1", "c1", details([task(1, "in_progress"), ...gone]), "r1")]
    expect(todosOf(entries)).toEqual({ tasks: [task(1, "in_progress")] })
    const row = walk(entries).rows.find((r): r is ToolRow => r.kind === "tool")
    expect((row?.details as { tasks: unknown[] }).tasks).toEqual([task(1, "in_progress")])
  })
})
