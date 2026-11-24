// Break-tests for the todo list (DEV-41): hostile snapshots, branches, compaction, paging, publishing.
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { buildRows } from "../src/pi/rows.js"
import { SessionLog } from "../src/pi/session-log.js"
import { readSnapshot } from "../src/pi/todos.js"
import { PAGE_SIZE, ThreadChangeSchema, ThreadSnapshotSchema, type Todos, type ToolRow } from "../src/rows.js"
import { appendEntries, assistantEntry, ext, openThread, state, sessionHeader, tmpDir, toolResultEntry, userEntry } from "./helpers.js"

type Status = "pending" | "in_progress" | "completed" | "deleted"
const task = (id: number, status: Status, extra: Record<string, unknown> = {}) => ({ id, subject: `Task ${id}`, status, ...extra })
const details = (tasks: unknown[], extra: Record<string, unknown> = {}) => ({ action: "update", params: {}, tasks, nextId: 100, ...extra })
const stateEntry = (id: string, parent: string | null, data: unknown) => ({ type: "custom", customType: "rpiv-todo-state", id, parentId: parent, timestamp: "2026-11-15T10:00:03.000Z", data })
const call = (parent: string | null, id: string, callId: string) => assistantEntry(parent, [{ type: "toolCall", id: callId, name: "todo", arguments: { action: "update" } }], id)
const result = (parent: string, callId: string, data: unknown, id: string) => toolResultEntry(parent, callId, "ok", false, id, "todo", data)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function fileOf(...entries: unknown[]): string {
  const file = path.join(tmpDir(), "s.jsonl")
  fs.writeFileSync(file, [sessionHeader, ...entries].map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n") + "\n")
  return file
}
function walk(...entries: unknown[]) {
  const log = new SessionLog(fileOf(...entries))
  log.refresh()
  return buildRows(log.branch(null).path, log.broken, false)
}
const todosOf = (...entries: unknown[]): Todos | null => walk(...entries).todos
const one = (d: unknown) => todosOf(userEntry(null, "go", "u1"), call("u1", "a1", "c1"), result("a1", "c1", d, "r1"))

describe("hostile snapshots are skipped whole and never throw", () => {
  const valid = task(1, "pending")
  const cases: [string, unknown][] = [
    ["id 1e21 (not a safe integer)", details([{ ...valid, id: 1e21 }])],
    ["id 2**53", details([{ ...valid, id: 2 ** 53 }])],
    ["id 1.5", details([{ ...valid, id: 1.5 }])],
    ["id as a numeric string", details([{ ...valid, id: "1" }])],
    ["id null", details([{ ...valid, id: null }])],
    ["status null", details([{ ...valid, status: null }])],
    ["status 'toString'", details([{ ...valid, status: "toString" }])],
    ["status 'hasOwnProperty'", details([{ ...valid, status: "hasOwnProperty" }])],
    ["status ['pending']", details([{ ...valid, status: ["pending"] }])],
    ["task null", details([null])],
    ["task an array", details([[1, 2]])],
    ["task a string", details(["x"])],
    ["activeForm a number", details([{ ...valid, activeForm: 5 }])],
    ["blockedBy not an array", details([{ ...valid, blockedBy: 1 }])],
    ["blockedBy with a float", details([{ ...valid, blockedBy: [1.5] }])],
    ["blockedBy with null", details([{ ...valid, blockedBy: [null] }])],
    ["nextId a string", { ...details([valid]), nextId: "3" }],
    ["nextId null", { ...details([valid]), nextId: null }],
    ["nextId 1.5", { ...details([valid]), nextId: 1.5 }],
    ["nextId missing", { action: "update", tasks: [valid] }],
    ["tasks an object", { action: "update", tasks: { 0: valid, length: 1 }, nextId: 1 }],
    ["details null", null],
    ["details an array", [valid]],
    ["details a number", 7],
  ]
  for (const [name, d] of cases) {
    it(`${name}: no list, and the last valid one stays`, () => {
      expect(one(d)).toBeNull()
      expect(readSnapshot(d)).toBeNull()
      const entries = [userEntry(null, "go", "u1"), call("u1", "a1", "c1"), result("a1", "c1", details([task(7, "in_progress")]), "r1"), call("r1", "a2", "c2"), result("a2", "c2", d, "r2")]
      expect(todosOf(...entries)).toEqual({ tasks: [task(7, "in_progress")] })
    })
  }

  it("an action that is not a string, an error that is not a string: snapshot still taken, nothing thrown", () => {
    expect(one({ action: 5, error: { x: 1 }, tasks: [valid], nextId: 2 })).toEqual({ tasks: [valid] })
  })

  it("empty subject and empty activeForm are kept/dropped without breaking", () => {
    expect(one(details([{ id: 1, subject: "", status: "in_progress", activeForm: "" }]))).toEqual({ tasks: [{ id: 1, subject: "", status: "in_progress" }] })
  })

  it("a task that carries __proto__/constructor keys of its own pollutes nothing and is not copied through", () => {
    const raw = `{"action":"update","tasks":[{"id":1,"subject":"x","status":"pending","__proto__":{"status":"completed","polluted":true},"constructor":{"prototype":{"p":1}}}],"nextId":2}`
    const todos = one(JSON.parse(raw))
    expect(todos).toEqual({ tasks: [{ id: 1, subject: "x", status: "pending" }] })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.keys(todos!.tasks[0]!)).toEqual(["id", "subject", "status"])
  })

  it("duplicate ids (rpiv never writes them) make the snapshot invalid, so the last valid one stays", () => {
    expect(one(details([task(1, "pending"), task(1, "completed")]))).toBeNull()
  })

  it("a thousand tasks with tiny subjects is over the cap and keeps the last valid list", () => {
    const many = Array.from({ length: 1000 }, (_, i) => task(i + 1, "pending"))
    const todos = todosOf(userEntry(null, "go", "u1"), call("u1", "a1", "c1"), result("a1", "c1", details([task(1, "pending")]), "r1"), call("r1", "a2", "c2"), result("a2", "c2", details(many), "r2"))
    expect(todos).toEqual({ tasks: [task(1, "pending")] })
  })

  it("a cut that would split a surrogate pair does not leave half of it", () => {
    const subject = "a".repeat(299) + "😀" + "b".repeat(50)
    const got = one(details([{ id: 1, subject, status: "pending" }]))!.tasks[0]!.subject
    expect(got.endsWith("…")).toBe(true)
    expect(/[\ud800-\udbff]…$/.test(got)).toBe(false)
    expect(() => JSON.parse(JSON.stringify(got))).not.toThrow()
  })

  it("a description 1 MB long does not count against the cap (it is not carried)", () => {
    const got = one(details([{ id: 1, subject: "x", status: "pending", description: "d".repeat(1_000_000), metadata: { big: "m".repeat(100000) } }]))
    expect(got).toEqual({ tasks: [task(1, "pending", { subject: "x" })] })
  })
})

describe("state entries and tool results", () => {
  it("a state entry that is valid but over the cap is not taken, so older results show (rpiv would show the big list)", () => {
    const many = Array.from({ length: 200 }, (_, i) => task(i + 1, "pending", { subject: "y".repeat(120) }))
    const todos = todosOf(userEntry(null, "go", "u1"), call("u1", "a1", "c1"), result("a1", "c1", details([task(1, "pending")]), "r1"), stateEntry("s1", "r1", details(many)))
    expect(todos).toEqual({ tasks: [task(1, "pending")] })
  })

  it("an entry newer than a tool result, and a later invalid entry: the last valid entry stays", () => {
    const todos = todosOf(userEntry(null, "go", "u1"), stateEntry("s1", "u1", details([task(1, "in_progress")])), stateEntry("s2", "s1", { tasks: "x", nextId: 1 }), call("s2", "a1", "c1"), result("a1", "c1", details([task(9, "pending")]), "r1"))
    expect(todos).toEqual({ tasks: [task(1, "in_progress")] })
  })

  it("a state entry of another customType, or with no data, is ignored", () => {
    expect(todosOf(userEntry(null, "go", "u1"), { type: "custom", customType: "other", id: "s1", parentId: "u1", data: details([task(1, "pending")]) }, { type: "custom", customType: "rpiv-todo-state", id: "s2", parentId: "s1" })).toBeNull()
  })

  it("a tool result named todo with no details, or isError, is ignored; one named Todo (other case) is too", () => {
    const entries = [userEntry(null, "go", "u1"), call("u1", "a1", "c1"), toolResultEntry("a1", "c1", "ok", false, "r1", "todo"), call("r1", "a2", "c2"), toolResultEntry("a2", "c2", "ok", false, "r2", "Todo", details([task(1, "pending")]))]
    expect(todosOf(...entries)).toBeNull()
  })

  it("an in-band error (isError false, details.error, tasks unchanged) does not bring a dropped all-done list back when entries exist", () => {
    const todos = todosOf(
      userEntry(null, "go", "u1"),
      stateEntry("s1", "u1", details([task(1, "completed")])),
      userEntry("s1", "again", "u2"),
      call("u2", "a1", "c1"),
      result("a1", "c1", details([task(1, "completed")], { error: "#9 not found" }), "r1"),
    )
    expect(todos).toBeNull()
  })

  // Found by the tester: the fallback replay (no state entries) took an error result as a fresh snapshot, so a list dropped for being all done came back.
  it("old session (results only): a rejected call after the all-done list was dropped does not bring it back", () => {
    const todos = todosOf(
      userEntry(null, "go", "u1"),
      call("u1", "a1", "c1"),
      result("a1", "c1", details([task(1, "completed")]), "r1"),
      userEntry("r1", "again", "u2"),
      call("u2", "a2", "c2"),
      result("a2", "c2", details([task(1, "completed")], { error: "#9 not found" }), "r2"),
    )
    expect(todos).toBeNull()
  })

  it("the row of a todo call that errored has no `tasks` surprises", () => {
    const { rows } = walk(userEntry(null, "go", "u1"), call("u1", "a1", "c1"), result("a1", "c1", details([task(1, "pending")], { error: "boom" }), "r1"))
    const row = rows.find((r): r is ToolRow => r.kind === "tool")!
    expect(row.details).toMatchObject({ error: "boom" })
  })
})

describe("branches, compaction, paging", () => {
  it("compaction entries and branch summaries in the path do not hide the list", () => {
    const todos = todosOf(
      userEntry(null, "go", "u1"),
      call("u1", "a1", "c1"),
      result("a1", "c1", details([task(1, "in_progress")]), "r1"),
      { type: "compaction", id: "k1", parentId: "r1", timestamp: "2026-11-15T10:00:04.000Z", summary: "s", firstKeptEntryId: "r1", tokensBefore: 10 },
      userEntry("k1", "more", "u2"),
    )
    expect(todos).toEqual({ tasks: [task(1, "in_progress")] })
  })

  it("/tree to a sibling branch shows that branch's list; going back shows the first again (reset carries it)", async () => {
    const file = fileOf(
      userEntry(null, "go", "u1"),
      call("u1", "a1", "c1"),
      result("a1", "c1", details([task(1, "in_progress")]), "rA"),
      // branch B from u1
      call("u1", "b1", "d1"),
      result("b1", "d1", details([task(5, "pending"), task(6, "pending")]), "rB"),
    )
    const { thread, changes } = openThread(file, {}, { leafId: "rA" })
    expect(thread.snapshot().todos).toEqual({ tasks: [task(1, "in_progress")] })
    changes.length = 0
    thread.handle(state({ leafId: "rB" }))
    await sleep(60)
    expect(thread.snapshot().todos).toEqual({ tasks: [task(5, "pending"), task(6, "pending")] })
    const seen = changes.map((c) => ThreadChangeSchema.parse(c))
    const carried = seen.map((c) => (c.type === "reset" ? c.snapshot.todos : c.type === "update" ? c.todos : undefined)).filter((t) => t !== undefined)
    expect(carried.at(-1)).toEqual({ tasks: [task(5, "pending"), task(6, "pending")] })
    changes.length = 0
    thread.handle(state({ leafId: "rA" }))
    await sleep(60)
    expect(thread.snapshot().todos).toEqual({ tasks: [task(1, "in_progress")] })
    const back = changes.map((c) => ThreadChangeSchema.parse(c)).map((c) => (c.type === "reset" ? c.snapshot.todos : c.type === "update" ? c.todos : undefined)).filter((t) => t !== undefined)
    expect(back.at(-1)).toEqual({ tasks: [task(1, "in_progress")] })
  })

  it("a list written long before the last page is in the snapshot of a thread and survives paging", () => {
    const entries: unknown[] = [userEntry(null, "go", "u1"), call("u1", "a1", "c1"), result("a1", "c1", details([task(1, "in_progress")]), "r1")]
    let parent = "r1"
    for (let i = 0; i < PAGE_SIZE * 3; i++) {
      entries.push(assistantEntry(parent, [{ type: "text", text: `n${i}` }], `t${i}`))
      parent = `t${i}`
    }
    const { thread, snapshot } = openThread(fileOf(...entries), {}, { leafId: parent })
    expect(ThreadSnapshotSchema.parse(snapshot).todos).toEqual({ tasks: [task(1, "in_progress")] })
    expect(snapshot.hasMore).toBe(true)
    expect(thread.snapshot().todos).toEqual({ tasks: [task(1, "in_progress")] })
  })
})

describe("publishing", () => {
  it("a list that goes from one valid list to the same list again publishes nothing; a change publishes once", async () => {
    const file = fileOf(userEntry(null, "go", "u1"))
    const { thread, changes } = openThread(file, {}, { leafId: "u1", working: true })
    appendEntries(file, call("u1", "a1", "c1"), result("a1", "c1", details([task(1, "pending")]), "r1"))
    thread.handle(ext({ type: "entries", leafId: "r1", replyDone: false }))
    await sleep(60)
    appendEntries(file, call("r1", "a2", "c2"), result("a2", "c2", details([task(1, "pending")], { action: "list" }), "r2"))
    thread.handle(ext({ type: "entries", leafId: "r2", replyDone: false }))
    await sleep(60)
    const withTodos = changes.map((c) => ThreadChangeSchema.parse(c)).filter((c) => c.type === "update" && c.todos !== undefined)
    expect(withTodos).toHaveLength(1)
  })

  it("a state entry alone (call made through codemode) publishes the list", async () => {
    const file = fileOf(userEntry(null, "go", "u1"))
    const { thread, changes } = openThread(file, {}, { leafId: "u1", working: true })
    appendEntries(file, stateEntry("s1", "u1", details([task(1, "in_progress")])))
    thread.handle(ext({ type: "entries", leafId: "s1", replyDone: false }))
    await sleep(60)
    const got = changes.map((c) => ThreadChangeSchema.parse(c)).filter((c) => c.type === "update" && c.todos)
    expect(got).toHaveLength(1)
  })
})
