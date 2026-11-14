import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { buildRows, cutText } from "../src/pi/rows.js"
import { SessionLog } from "../src/pi/session-log.js"
import { RowSchema, TOOL_ARG_CUT, TOOL_RESULT_CUT, type Row, type ToolRow } from "../src/rows.js"
import { appendEntries, assistantEntry, fixturePath, sessionHeader, tmpDir, toolResultEntry, userEntry } from "./helpers.js"

function read(file: string, leaf: string | null = null, working = false) {
  const log = new SessionLog(file)
  log.refresh()
  const { path: branch } = log.branch(leaf)
  return { log, ...buildRows(branch, log.broken, working) }
}
const fixture = (name: string, leaf: string | null = null, working = false) => read(fixturePath(`session-${name}.jsonl`), leaf, working)
const summary = (rows: Row[]) => rows.map((r) => `${r.kind}:${r.id}`)

function write(lines: unknown[]): string {
  const file = path.join(tmpDir(), "s.jsonl")
  fs.writeFileSync(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l)) + "\n").join(""))
  return file
}

describe("session file to rows", () => {
  it("a plain turn is a user row, the model's thinking, and its answer", () => {
    const { rows } = fixture("a-plain")
    expect(rows.map((r) => r.kind)).toEqual(["user", "thinking", "assistant"])
    expect(rows[0]).toMatchObject({ kind: "user", id: "50d90a8e", text: "What is the capital of France? Answer in one short sentence.", images: 0 })
    expect(rows[2]).toMatchObject({ kind: "assistant", id: "98ad1ba9.1", text: "The capital of France is Paris.", model: "llama-swap/zorro-davidau-3.8-flash-next" })
    for (const row of rows) expect(RowSchema.safeParse(row).success).toBe(true)
  })

  it("leaves out the system message, model and thinking-level entries", () => {
    const { rows } = fixture("a-plain")
    expect(rows.some((r) => r.id === "bbac0416" || r.id === "f2dd7379" || r.id === "3e40feb0")).toBe(false)
    const h = fixture("h-model-thinking")
    expect(h.rows.map((r) => r.kind)).toEqual(["user", "thinking", "assistant"]) // three model_change and three thinking_level_change entries after it
  })

  it("a tool call and its result are one row; a failed one says so", () => {
    const { rows } = fixture("b-tools")
    const tools = rows.filter((r): r is ToolRow => r.kind === "tool")
    expect(tools).toHaveLength(2) // two calls, two results, two rows
    expect(tools[0]).toMatchObject({ id: "39491710.1", callId: "call_a8dd9faec0234fd5b61a8636", name: "bash", status: "ok", args: { command: "ls /tmp/hw-scratch-t/work" } })
    expect(tools[0]!.result).toEqual({ text: "exists.txt\n", truncated: false, totalChars: 11 })
    expect(tools[1]).toMatchObject({ id: "39491710.2", status: "error" })
    expect(tools[1]!.result!.text).toContain("No such file or directory")
    expect(tools[1]!.durationMs).toBe(14)
    expect(rows.some((r) => r.id === "a0cac82e" || r.id === "9561e838")).toBe(false) // the result entries are not rows of their own
  })

  it("a call with no result is running while the agent works and interrupted when it does not", () => {
    const file = write([sessionHeader, userEntry(null, "go", "u1"), assistantEntry("u1", [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "sleep 9" } }], "a1", { stopReason: "toolUse" })])
    expect((read(file, null, true).rows[1] as ToolRow).status).toBe("running")
    expect((read(file, null, false).rows[1] as ToolRow).status).toBe("interrupted")
  })

  it("a stopped reply ends with a notice", () => {
    const { rows } = fixture("c-escape")
    expect(rows.at(-1)).toMatchObject({ kind: "notice", id: "7d9227d4.stop", level: "info", text: "Stopped." })
    expect(rows.at(-2)).toMatchObject({ kind: "thinking", id: "7d9227d4.0" })
  })

  it("an error reply carries the model's error text", () => {
    const file = write([sessionHeader, userEntry(null, "hi", "u1"), assistantEntry("u1", [], "a1", { stopReason: "error", errorMessage: "402 Payment required" })])
    expect(read(file).rows.at(-1)).toMatchObject({ kind: "notice", level: "error", text: "402 Payment required" })
  })

  it("shows the whole branch with a divider where the compaction happened, not only what the model keeps", () => {
    const { rows } = fixture("e-compact")
    const ids = summary(rows)
    expect(ids).toContain("user:50d90a8e") // before the compaction's first kept entry (395b3043): still shown
    expect(ids).toContain("user:41151b8f")
    const at = rows.findIndex((r) => r.kind === "compaction")
    expect(rows[at]).toMatchObject({ id: "a3d852f4", tokensBefore: 30308 })
    expect((rows[at] as { summary: string }).summary).toMatch(/^## Goal/)
    expect(rows[at - 1]!.id).toBe("02df02d5.1") // right after the last message before it
    expect(rows[at + 1]).toMatchObject({ kind: "user", id: "2656bf65" }) // and the turn after
  })

  it("follows the leaf pi reported, not the last entry of the file (fact 1)", () => {
    // f-tree: /tree went back to f7198b28, then a new turn made ffcf9652 → 21ba4a77. The file's last entry is on the new branch.
    const last = fixture("f-tree")
    expect(last.rows.at(-1)).toMatchObject({ id: "21ba4a77.1" })
    expect(summary(last.rows)).not.toContain("compaction:a3d852f4") // the compaction is on the abandoned branch

    // Right after /tree, before the new turn: the leaf moved and the file did not. The leaf wins.
    const moved = fixture("f-tree", "f7198b28")
    expect(moved.rows.at(-1)).toMatchObject({ id: "f7198b28.1", text: "Red, blue, and yellow." })
    expect(summary(moved.rows)).not.toContain("user:ffcf9652")

    // And back on the long branch, the compaction divider is there again.
    const old = fixture("f-tree", "31f8d644")
    expect(summary(old.rows)).toContain("compaction:a3d852f4")
    expect(old.rows.at(-1)!.id).toBe("31f8d644.1")
  })

  it("an unknown leaf falls back to the last entry, and says it was not found", () => {
    const log = new SessionLog(fixturePath("session-f-tree.jsonl"))
    log.refresh()
    const { path: branch, found } = log.branch("nope0000")
    expect(found).toBe(false)
    expect(branch.at(-1)!.id).toBe("21ba4a77")
  })

  it("leaves out custom entries, hidden custom messages and context edits; shows the displayed ones", () => {
    const file = write([
      sessionHeader,
      userEntry(null, "hello", "u1"),
      { type: "custom", id: "c1", parentId: "u1", timestamp: "2026-11-15T10:00:00.000Z", customType: "x", data: { a: 1 } },
      { type: "custom_message", id: "c2", parentId: "c1", timestamp: "2026-11-15T10:00:00.000Z", customType: "x", content: "hidden context", display: false },
      { type: "context_edit", id: "c3", parentId: "c2", timestamp: "2026-11-15T10:00:00.000Z", targetId: "u1", replacement: null },
      { type: "label", id: "c4", parentId: "c3", timestamp: "2026-11-15T10:00:00.000Z", targetId: "u1", label: "x" },
      { type: "usage", id: "c5", parentId: "c4", timestamp: "2026-11-15T10:00:00.000Z", kind: "cache_warm" },
      { type: "message", id: "c6", parentId: "c5", timestamp: "2026-11-15T10:00:00.000Z", message: { role: "system", content: "", sections: { cwd: "/x" }, timestamp: 1 } },
      { type: "custom_message", id: "c7", parentId: "c6", timestamp: "2026-11-15T10:00:00.000Z", customType: "x", content: "shown to the user", display: true },
      assistantEntry("c7", [{ type: "text", text: "ok" }], "a1"),
    ])
    expect(summary(read(file).rows)).toEqual(["user:u1", "notice:c7", "assistant:a1.0"])
  })

  it("a branch summary becomes a notice", () => {
    const file = write([sessionHeader, userEntry(null, "q", "u1"), { type: "branch_summary", id: "b1", parentId: "u1", timestamp: "2026-11-15T10:00:00.000Z", fromId: "zz", summary: "tried A" }])
    expect(read(file).rows[1]).toMatchObject({ kind: "notice", id: "b1", text: "Summary of the branch left: tried A" })
  })

  it("a !command run by the user is a tool row marked byUser", () => {
    const file = write([
      sessionHeader,
      { type: "message", id: "x1", parentId: null, timestamp: "2026-11-15T10:00:00.000Z", message: { role: "bashExecution", command: "echo hi", output: "hi\n", exitCode: 0, cancelled: false, truncated: false, timestamp: 1 } },
    ])
    expect(read(file).rows[0]).toMatchObject({ kind: "tool", id: "x1", name: "bash", byUser: true, status: "ok", args: { command: "echo hi" }, result: { text: "hi\n" } })
  })

  it("counts images in a user message without carrying them", () => {
    const file = write([sessionHeader, { type: "message", id: "u1", parentId: null, timestamp: "2026-11-15T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 1 } }])
    const [row] = read(file).rows
    expect(row).toMatchObject({ kind: "user", text: "look", images: 1 })
    expect(JSON.stringify(row)).not.toContain("AAAA")
  })
})

describe("a line that cannot be read", () => {
  it("becomes a notice row where it sits in the file, and nothing else is lost", () => {
    const file = write([
      sessionHeader,
      userEntry(null, "first", "u1"),
      "{this is not json",
      assistantEntry("u1", [{ type: "text", text: "second" }], "a1"),
      '{"type":"message"}', // an entry with no id
      "[1,2,3]",
      userEntry("a1", "third", "u2"),
    ])
    const { rows, log } = read(file)
    expect(summary(rows)).toEqual(["user:u1", "notice:broken:3", "assistant:a1.0", "notice:broken:5", "notice:broken:6", "user:u2"])
    expect(rows[1]).toMatchObject({ kind: "notice", level: "warning", text: "Line 3 of the session file could not be read." })
    expect(log.broken).toEqual([3, 5, 6])
  })

  it("an entry that is the wrong shape does not crash the thread: it becomes a notice", () => {
    const file = write([sessionHeader, { type: "message", id: "m1", parentId: null, timestamp: "x", message: "not an object" }, userEntry("m1", "after", "u1")])
    const { rows } = read(file)
    expect(summary(rows)).toEqual(["notice:m1.error", "user:u1"])
    expect(rows[0]).toMatchObject({ at: null, level: "warning" })
  })

  it("a half-written last line is waited for, not reported", () => {
    const dir = tmpDir()
    const file = path.join(dir, "s.jsonl")
    fs.writeFileSync(file, JSON.stringify(sessionHeader) + "\n" + JSON.stringify(userEntry(null, "one", "u1")).slice(0, 40))
    const log = new SessionLog(file)
    log.refresh()
    expect(log.entries.size).toBe(0)
    expect(log.broken).toEqual([])
    fs.appendFileSync(file, JSON.stringify(userEntry(null, "one", "u1")).slice(40) + "\n")
    expect(log.refresh()).toBe(true)
    expect(log.entries.has("u1")).toBe(true)
    expect(log.broken).toEqual([])
  })

  it("a file that does not exist yet is an empty thread, and appears when pi writes it", () => {
    const file = path.join(tmpDir(), "later.jsonl")
    const log = new SessionLog(file)
    expect(log.refresh()).toBe(false)
    expect(log.branch(null).path).toEqual([])
    fs.writeFileSync(file, JSON.stringify(sessionHeader) + "\n" + JSON.stringify(userEntry(null, "hi", "u1")) + "\n")
    expect(log.refresh()).toBe(true)
    expect(log.branch(null).path.map((e) => e.id)).toEqual(["u1"])
  })

  it("a file that shrinks is read again from the start", () => {
    const file = path.join(tmpDir(), "s.jsonl")
    fs.writeFileSync(file, [sessionHeader, userEntry(null, "one", "u1"), assistantEntry("u1", [{ type: "text", text: "two" }], "a1")].map((e) => JSON.stringify(e)).join("\n") + "\n")
    const log = new SessionLog(file)
    log.refresh()
    expect(log.entries.size).toBe(2)
    fs.writeFileSync(file, JSON.stringify(sessionHeader) + "\n" + JSON.stringify(userEntry(null, "other", "u9")) + "\n")
    log.refresh()
    expect([...log.entries.keys()]).toEqual(["u9"])
  })

  it("a loop in parent ids ends the walk instead of looping", () => {
    const file = write([sessionHeader, userEntry("u2", "a", "u1"), userEntry("u1", "b", "u2")])
    expect(read(file).rows.length).toBeLessThanOrEqual(2)
  })
})

describe("stable ids", () => {
  it("the same session read twice gives the same rows and ids, byte for byte", () => {
    for (const name of ["a-plain", "b-tools", "c-escape", "e-compact", "f-tree"]) {
      const one = JSON.stringify(fixture(name).rows)
      const two = JSON.stringify(fixture(name).rows)
      expect(two).toBe(one)
    }
  })

  it("every id in a thread is unique", () => {
    for (const name of ["b-tools", "e-compact", "f-tree"]) {
      const ids = fixture(name).rows.map((r) => r.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it("ids come from the entries: appending to the file leaves earlier ids alone", () => {
    const file = path.join(tmpDir(), "s.jsonl")
    fs.copyFileSync(fixturePath("session-b-tools.jsonl"), file)
    const before = read(file).rows.map((r) => r.id)
    appendEntries(file, userEntry("af47aa91", "and another", "u-new"))
    const after = read(file).rows.map((r) => r.id)
    expect(after.slice(0, before.length)).toEqual(before)
    expect(after.at(-1)).toBe("u-new")
  })
})

describe("long tool results and arguments", () => {
  const longText = "x".repeat(TOOL_RESULT_CUT + 500)
  const file = write([
    sessionHeader,
    userEntry(null, "go", "u1"),
    assistantEntry("u1", [{ type: "toolCall", id: "c1", name: "write", arguments: { path: "/tmp/f", content: "y".repeat(TOOL_ARG_CUT * 3), nested: { list: ["short", "z".repeat(TOOL_ARG_CUT + 1)] } } }], "a1", { stopReason: "toolUse" }),
    toolResultEntry("a1", "c1", longText, false, "r1"),
  ])

  it("cuts the result in its row and says so", () => {
    const row = read(file).rows[1] as ToolRow
    expect(row.result).toEqual({ text: "x".repeat(TOOL_RESULT_CUT), truncated: true, totalChars: TOOL_RESULT_CUT + 500 })
  })

  it("keeps the whole result for `toolResult`", () => {
    const { resultEntry, rows } = read(file)
    const entry = resultEntry.get(rows[1]!.id)
    expect(entry?.id).toBe("r1")
  })

  it("cuts long strings in the arguments, however deep, and says so", () => {
    const row = read(file).rows[1] as ToolRow
    expect(row.argsTruncated).toBe(true)
    expect((row.args.content as string).length).toBe(TOOL_ARG_CUT)
    expect(((row.args.nested as { list: string[] }).list[1] as string).length).toBe(TOOL_ARG_CUT)
    expect((row.args.nested as { list: string[] }).list[0]).toBe("short")
  })

  it("a result exactly at the limit is not cut", () => {
    expect(cutText("a".repeat(TOOL_RESULT_CUT), TOOL_RESULT_CUT).truncated).toBe(false)
    expect(cutText("a".repeat(TOOL_RESULT_CUT + 1), TOOL_RESULT_CUT).truncated).toBe(true)
  })

  it("never cuts a surrogate pair in half", () => {
    const text = "a".repeat(9) + "😀" + "b"
    const cut = cutText(text, 10) // the emoji's two code units straddle the limit
    expect(cut.text).toBe("a".repeat(9))
    expect([...cut.text].every((c) => c.codePointAt(0)! < 0xd800)).toBe(true)
  })
})
