import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { MAX_ENTRY_BYTES, MAX_SESSION_BYTES } from "../src/pi/session-log.js"
import { appendEntries, assistantEntry, openThread, sessionHeader, tmpDir, userEntry } from "./helpers.js"

// What a hostile or broken pi, or a session file in a bad state, may do to the thread.

function sessionFile(...lines: unknown[]): string {
  const file = path.join(tmpDir(), "s.jsonl")
  fs.writeFileSync(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l)) + "\n").join(""))
  return file
}
const kinds = (rows: { kind: string }[]) => rows.map((r) => r.kind)

describe("a session file that is not a session file", () => {
  it("a named pipe is not opened for reading (that would block the backend for good)", () => {
    const dir = tmpDir()
    const fifo = path.join(dir, "pipe.jsonl")
    execFileSync("mkfifo", [fifo])
    const started = Date.now()
    const { snapshot } = openThread(fifo)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(snapshot.rows).toMatchObject([{ kind: "notice", id: "unreadable", level: "warning", text: "The session file is not a regular file." }])
  })

  it("a folder is not read either", () => {
    const dir = tmpDir()
    const folder = path.join(dir, "d.jsonl")
    fs.mkdirSync(folder)
    expect(openThread(folder).snapshot.rows).toMatchObject([{ kind: "notice", id: "unreadable" }])
  })

  it("a file past the size cap is not read, says so in a row, and the live parts keep working", () => {
    const file = path.join(tmpDir(), "huge.jsonl")
    fs.writeFileSync(file, JSON.stringify(sessionHeader) + "\n")
    fs.truncateSync(file, MAX_SESSION_BYTES + 1) // sparse: no disk used
    const started = Date.now()
    const { snapshot, thread } = openThread(file, {}, { working: true })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(snapshot.rows).toMatchObject([{ kind: "notice", id: "unreadable", text: expect.stringContaining("256 MiB") }])
    expect(thread.snapshot().live.working).toBe(true)
  })

  it("a path that is relative or not a .jsonl file is not read, whatever the hello says", () => {
    const file = sessionFile(sessionHeader, userEntry(null, "secret", "u1"))
    expect(openThread(file.replace(/\.jsonl$/, ".txt")).snapshot.rows).toEqual([])
    fs.copyFileSync(file, file.replace(/\.jsonl$/, ".txt"))
    expect(openThread(file.replace(/\.jsonl$/, ".txt")).snapshot.rows).toEqual([])
    expect(openThread(path.relative(process.cwd(), file)).snapshot.rows).toEqual([])
    expect(kinds(openThread(file).snapshot.rows)).toEqual(["user"])
  })

  it("a file that shrinks or is replaced is read again from its start", () => {
    const file = sessionFile(sessionHeader, userEntry(null, "one", "u1"), assistantEntry("u1", [{ type: "text", text: "A" }], "a1"))
    const { thread } = openThread(file)
    expect(kinds(thread.snapshot().rows)).toEqual(["user", "assistant"])
    fs.writeFileSync(file, JSON.stringify(sessionHeader) + "\n" + JSON.stringify(userEntry(null, "z", "z1")) + "\n")
    thread.handle({ type: "entries", leafId: "z1", replyDone: false })
    expect(thread.snapshot().rows).toMatchObject([{ kind: "user", id: "z1" }])
  })
})

describe("a session file that is huge or half written", () => {
  it("one entry longer than the chunk it is read in is still read, once", () => {
    const text = "y".repeat(9 * 1024 * 1024)
    const file = sessionFile(sessionHeader, userEntry(null, text, "u1"), assistantEntry("u1", [{ type: "text", text: "after" }], "a1"))
    const rows = openThread(file).snapshot.rows
    expect(kinds(rows)).toEqual(["user", "assistant"])
    expect((rows[0] as { text: string }).text).toHaveLength(text.length)
  })

  it("an entry past the per-entry limit is one unreadable line; what follows it is read", () => {
    const file = path.join(tmpDir(), "s.jsonl")
    fs.writeFileSync(file, JSON.stringify(sessionHeader) + "\n" + JSON.stringify(userEntry(null, "first", "u1")) + "\n")
    const fd = fs.openSync(file, "a")
    const block = Buffer.alloc(1024 * 1024, "z")
    for (let i = 0; i <= MAX_ENTRY_BYTES / block.length; i++) fs.writeSync(fd, block)
    fs.writeSync(fd, "\n" + JSON.stringify(assistantEntry("u1", [{ type: "text", text: "after" }], "a1")) + "\n")
    fs.closeSync(fd)
    const rows = openThread(file).snapshot.rows
    expect(rows.map((r) => `${r.kind}:${r.id}`)).toEqual(["user:u1", "notice:broken:3", "assistant:a1.0"])
  })

  it("a last line that is only half written waits for its end, and is then one entry", () => {
    const file = sessionFile(sessionHeader, userEntry(null, "q", "u1"))
    const whole = JSON.stringify(assistantEntry("u1", [{ type: "text", text: "whole" }], "a1"))
    fs.appendFileSync(file, whole.slice(0, 40))
    const { thread } = openThread(file)
    expect(kinds(thread.snapshot().rows)).toEqual(["user"])
    fs.appendFileSync(file, whole.slice(40, 70))
    thread.handle({ type: "entries", leafId: "u1", replyDone: false })
    expect(kinds(thread.snapshot().rows)).toEqual(["user"])
    fs.appendFileSync(file, whole.slice(70) + "\n")
    thread.handle({ type: "entries", leafId: "a1", replyDone: true })
    expect(thread.snapshot().rows.map((r) => r.id)).toEqual(["u1", "a1.0"])
  })

  it("thousands of entries are shown as one page and the rest as pages", async () => {
    const lines: unknown[] = [sessionHeader]
    let parent: string | null = null
    for (let i = 0; i < 3000; i++) {
      const e = i % 2 === 0 ? userEntry(parent, `m${i}`, `e${i}`) : assistantEntry(parent, [{ type: "text", text: `r${i}` }], `e${i}`)
      lines.push(e)
      parent = `e${i}`
    }
    const { snapshot, thread } = openThread(sessionFile(...lines))
    expect(snapshot.rows).toHaveLength(50)
    expect(snapshot.hasMore).toBe(true)
    const page = await thread.page(snapshot.rows[0]!.id, 500)
    expect(page.rows).toHaveLength(500)
    expect(page.rows.at(-1)!.id).not.toBe(snapshot.rows[0]!.id)
  })
})

describe("a leaf the file does not hold", () => {
  const file = () => sessionFile(sessionHeader, userEntry(null, "q", "u1"), assistantEntry("u1", [{ type: "text", text: "a" }], "a1"))

  it("is taken for the end of the file, not an error", () => {
    const { thread } = openThread(file(), {}, { leafId: "does-not-exist" })
    expect(thread.snapshot().rows.map((r) => r.id)).toEqual(["u1", "a1.0"])
  })

  it("a leaf whose parents are missing shows what chain there is", () => {
    const f = sessionFile(sessionHeader, userEntry("ghost", "orphan", "u1"), assistantEntry("u1", [{ type: "text", text: "a" }], "a1"))
    expect(openThread(f, {}, { leafId: "a1" }).snapshot.rows.map((r) => r.id)).toEqual(["u1", "a1.0"])
  })

  it("entries that point at each other do not loop", () => {
    const f = sessionFile(sessionHeader, { ...userEntry("b", "x", "a") }, { ...userEntry("a", "y", "b") })
    expect(openThread(f, {}, { leafId: "b" }).snapshot.rows).toHaveLength(2)
  })

  it("a leaf that comes with a later `entries` message moves the branch; one that never arrives is given up on after the wait", async () => {
    const f = file()
    const { thread, changes } = openThread(f, { entryWaitMs: 100 })
    thread.handle({ type: "entries", leafId: "not-written-yet", replyDone: false })
    await new Promise((r) => setTimeout(r, 250))
    expect(thread.snapshot().rows.map((r) => r.id)).toEqual(["u1", "a1.0"])
    appendEntries(f, userEntry("a1", "next", "u2"))
    thread.handle({ type: "entries", leafId: "u2", replyDone: false })
    expect(thread.snapshot().rows.map((r) => r.id)).toEqual(["u1", "a1.0", "u2"])
    expect(changes.length).toBeGreaterThan(0)
  })
})
