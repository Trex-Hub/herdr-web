import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { ActionError } from "../src/thread.js"
import { PAGE_SIZE, TOOL_RESULT_CUT, ThreadChangeSchema, ThreadSnapshotSchema, type Row, type ThreadChange } from "../src/rows.js"
import type { Action } from "../src/wire.js"
import { WIRE_VERSION } from "../src/wire.js"
import { appendEntries, assistantEntry, copySession, ext, openThread, sessionHeader, state, tmpDir, toolResultEntry, userEntry } from "./helpers.js"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function newFile(...entries: unknown[]): string {
  const file = path.join(tmpDir(), "s.jsonl")
  fs.writeFileSync(file, [sessionHeader, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n")
  return file
}

const text = (t: string) => ({ type: "text", text: t })

function updates(changes: ThreadChange[]) {
  return changes.map((c) => ThreadChangeSchema.parse(c))
}

describe("live reply, in pieces", () => {
  it("the reply being written replaces itself; an empty reply clears it; each change is one update with the next seq", () => {
    const file = newFile(userEntry(null, "hi", "u1"))
    const { thread, changes, snapshot } = openThread(file, {}, { leafId: "u1", working: true })
    expect(snapshot.live.reply).toBeNull()
    thread.handle(ext({ type: "reply", blocks: [{ kind: "text", text: "Hel" }] }))
    thread.handle(ext({ type: "reply", blocks: [{ kind: "thinking", text: "hm" }, { kind: "text", text: "Hello" }] }))
    thread.handle(ext({ type: "reply", blocks: [] }))
    const u = updates(changes)
    expect(u.map((c) => c.seq)).toEqual([snapshot.seq + 1, snapshot.seq + 2, snapshot.seq + 3])
    expect(u.map((c) => (c.type === "update" ? c.live?.reply : "reset"))).toEqual([
      { blocks: [{ kind: "text", text: "Hel" }] },
      { blocks: [{ kind: "thinking", text: "hm" }, { kind: "text", text: "Hello" }] },
      null,
    ])
    expect(u.every((c) => c.type === "update" && c.rows === undefined)).toBe(true)
  })

  it("a message that changes nothing the app sees produces no update", () => {
    const { thread, changes } = openThread(newFile(), {}, {})
    thread.handle(ext({ type: "reply", blocks: [] }))
    thread.handle(state())
    expect(changes).toEqual([])
  })

  it("the finished reply arrives as its row in the same update that clears the live reply", () => {
    const file = newFile(userEntry(null, "hi", "u1"))
    const { thread, changes } = openThread(file, {}, { leafId: "u1", working: true })
    thread.handle(ext({ type: "reply", blocks: [{ kind: "text", text: "Hello there" }] }))
    changes.length = 0
    appendEntries(file, assistantEntry("u1", [text("Hello there")], "a1"))
    thread.handle(ext({ type: "entries", leafId: "a1", replyDone: true }))
    const [only, ...rest] = updates(changes)
    expect(rest).toEqual([])
    expect(only?.type).toBe("update")
    if (only?.type !== "update") return
    expect(only.rows?.map((r) => [r.id, r.kind])).toEqual([["a1.0", "assistant"]])
    expect(only.live?.reply).toBeNull()
  })

  it("when pi's write is behind the message, the reply stays until the row exists, then both change together", async () => {
    const file = newFile(userEntry(null, "hi", "u1"))
    const { thread, changes } = openThread(file, {}, { leafId: "u1", working: true })
    thread.handle(ext({ type: "reply", blocks: [{ kind: "text", text: "late" }] }))
    changes.length = 0
    thread.handle(ext({ type: "entries", leafId: "a1", replyDone: true }))
    await sleep(60)
    expect(thread.snapshot().live.reply).not.toBeNull() // not yet: the row is not on disk
    expect(thread.snapshot().rows.map((r) => r.id)).toEqual(["u1"])
    appendEntries(file, assistantEntry("u1", [text("late")], "a1"))
    await sleep(120)
    const u = updates(changes)
    const withRow = u.filter((c) => c.type === "update" && c.rows?.some((r) => r.id === "a1.0"))
    expect(withRow).toHaveLength(1)
    const c = withRow[0]
    expect(c?.type === "update" && c.live?.reply).toBeNull()
    // and in no update were the row and the live reply both missing or both present
    for (const x of u) if (x.type === "update" && x.rows?.some((r) => r.id === "a1.0")) expect(x.live?.reply ?? null).toBeNull()
  })

  it("a row pi never writes does not keep the reply on screen forever", async () => {
    const file = newFile(userEntry(null, "hi", "u1"))
    const { thread } = openThread(file, { entryWaitMs: 80 }, { leafId: "u1", working: true })
    thread.handle(ext({ type: "reply", blocks: [{ kind: "text", text: "x" }] }))
    thread.handle(ext({ type: "entries", leafId: "ghost", replyDone: true }))
    await sleep(250)
    expect(thread.snapshot().live.reply).toBeNull()
  })

  it("a session whose file does not exist yet (pi writes it with the first assistant message) opens empty and fills in", async () => {
    const dir = tmpDir()
    const file = path.join(dir, "later.jsonl")
    const { thread, changes, snapshot } = openThread(file, {}, { leafId: null })
    expect(snapshot.rows).toEqual([])
    fs.writeFileSync(file, [sessionHeader, userEntry(null, "first", "u1"), assistantEntry("u1", [text("ok")], "a1")].map((e) => JSON.stringify(e)).join("\n") + "\n")
    thread.handle(ext({ type: "entries", leafId: "a1", replyDone: true }))
    expect(thread.snapshot().rows.map((r) => r.id)).toEqual(["u1", "a1.0"])
    expect(updates(changes)).toHaveLength(1)
  })
})

describe("working, tools and the queue", () => {
  it("working follows state; settling clears the reply and the running tools", () => {
    const file = newFile(userEntry(null, "go", "u1"))
    const { thread, changes } = openThread(file, {}, { leafId: "u1" })
    thread.handle(state({ leafId: "u1", working: true }))
    thread.handle(ext({ type: "reply", blocks: [{ kind: "text", text: "..." }] }))
    thread.handle(ext({ type: "tool", phase: "start", callId: "c1", name: "bash" }))
    expect(thread.snapshot().live).toMatchObject({ working: true, tools: [{ callId: "c1", name: "bash" }] })
    thread.handle(state({ leafId: "u1", working: false }))
    expect(thread.snapshot().live).toMatchObject({ working: false, reply: null, tools: [] })
    expect(updates(changes).length).toBeGreaterThan(0)
  })

  it("a tool row is running while its call has no result and the agent works, interrupted once it stopped without one", () => {
    const file = newFile(userEntry(null, "run", "u1"), assistantEntry("u1", [{ type: "toolCall", id: "c9", name: "bash", arguments: { command: "sleep 9" } }], "a1", { stopReason: "toolUse" }))
    const { thread } = openThread(file, {}, { leafId: "a1", working: true })
    const tool = (r: Row[]) => r.find((x) => x.kind === "tool")
    expect(tool(thread.snapshot().rows)).toMatchObject({ status: "running" })
    thread.handle(state({ leafId: "a1", working: false }))
    expect(tool(thread.snapshot().rows)).toMatchObject({ status: "interrupted" })
  })

  it("a running tool keeps the argument the extension sent, for the live line", () => {
    const file = newFile(userEntry(null, "go", "u1"))
    const { thread } = openThread(file, {}, { leafId: "u1" })
    thread.handle(ext({ type: "tool", phase: "start", callId: "c1", name: "bash", argument: "ls /tmp" }))
    expect(thread.snapshot().live.tools).toEqual([{ callId: "c1", name: "bash", argument: "ls /tmp" }])
    thread.handle(state({ leafId: "u1", working: true }))
  })

  it("a tool started by an old extension, without an argument, still has a live line", () => {
    const file = newFile(userEntry(null, "go", "u1"))
    const { thread } = openThread(file, {}, { leafId: "u1" })
    thread.handle(ext({ type: "tool", phase: "start", callId: "c1", name: "bash" }))
    expect(thread.snapshot().live.tools).toEqual([{ callId: "c1", name: "bash" }])
  })

  it("a queued message is pending while the agent has not taken it, and turns into its row when it did (steer, then taken)", () => {
    const file = newFile(userEntry(null, "start", "u1"))
    const { thread, changes } = openThread(file, {}, { leafId: "u1", working: true })
    thread.handle(state({ leafId: "u1", working: true, pending: [{ id: "p1", text: "actually, stop", mode: "steer" }] }))
    expect(thread.snapshot().live.pending).toEqual([{ id: "p1", text: "actually, stop", mode: "steer" }])
    expect(thread.snapshot().rows.map((r) => r.id)).toEqual(["u1"]) // queued is not a row
    changes.length = 0
    appendEntries(file, userEntry("u1", "actually, stop", "u2"))
    thread.handle(state({ leafId: "u2", working: true, pending: [] }))
    const u = updates(changes)
    expect(u).toHaveLength(1)
    const c = u[0]
    expect(c?.type === "update" && c.rows?.map((r) => r.id)).toEqual(["u2"])
    expect(c?.type === "update" && c.live?.pending).toEqual([])
  })

  it("a notice the file cannot hold shows until the agent works again", () => {
    const { thread } = openThread(newFile(), {}, {})
    thread.handle(ext({ type: "notice", level: "error", text: "Compaction failed: x" }))
    expect(thread.snapshot().live.notice).toEqual({ level: "error", text: "Compaction failed: x" })
    thread.handle(state({ working: true }))
    expect(thread.snapshot().live.notice).toBeNull()
  })
})

describe("the branch moves", () => {
  it("a leaf that is not the end of what is shown is a reset carrying the new snapshot, with the next seq", () => {
    const file = copySession("f-tree")
    const first = openThread(file, {}, { leafId: null })
    const full = first.snapshot
    expect(full.rows.length).toBeGreaterThan(0)
    // go to an earlier entry on the file's own branch
    const earlier = full.rows[1]!.id.split(".")[0]!
    first.thread.handle(state({ leafId: earlier }))
    const [c, ...rest] = first.changes
    expect(rest).toEqual([])
    expect(c?.type).toBe("reset")
    if (c?.type !== "reset") return
    expect(c.seq).toBe(full.seq + 1)
    expect(c.snapshot.seq).toBe(c.seq)
    expect(() => ThreadSnapshotSchema.parse(c.snapshot)).not.toThrow()
    expect(c.snapshot.rows.length).toBeLessThan(full.rows.length)
    expect(first.thread.snapshot()).toEqual(c.snapshot)
  })

  it("the leaf pi reports wins over the last line of the file (after /tree the abandoned branch is last in the file)", () => {
    const file = copySession("f-tree")
    const { thread } = openThread(file, {}, { leafId: "f7198b28" })
    const ids = thread.snapshot().rows.map((r) => r.id.split(".")[0])
    expect(ids).toContain("f7198b28")
    expect(ids).not.toContain("31f8d644")
  })

  it("page() of a row that left the branch rejects with an ActionError, and the reset that explains it came first", async () => {
    const file = newFile(userEntry(null, "a", "u1"), assistantEntry("u1", [text("b")], "a1"), userEntry("a1", "c", "u2"), assistantEntry("u2", [text("d")], "a2"))
    const { thread, changes } = openThread(file, {}, { leafId: "a2" })
    thread.handle(state({ leafId: "a1" }))
    expect(changes.at(-1)?.type).toBe("reset")
    await expect(thread.page("a2")).rejects.toBeInstanceOf(ActionError)
    await expect(thread.page("a2")).rejects.toThrow(/no longer there/)
  })
})

describe("paging", () => {
  function longFile(n: number): { file: string; ids: string[] } {
    const entries: unknown[] = []
    const ids: string[] = []
    let parent: string | null = null
    for (let i = 0; i < n; i++) {
      const id = `m${String(i).padStart(4, "0")}`
      entries.push(i % 2 === 0 ? userEntry(parent, `q${i}`, id) : assistantEntry(parent, [text(`r${i}`)], id))
      ids.push(i % 2 === 0 ? id : `${id}.0`) // an assistant entry's text block is row <entry>.0
      parent = id
    }
    return { file: newFile(...entries), ids }
  }

  it("opens on the last PAGE_SIZE rows and says older ones exist; pages walk back to the start without overlap or gap", async () => {
    const { file, ids } = longFile(PAGE_SIZE * 2 + 17)
    const { thread, snapshot } = openThread(file, {}, { leafId: ids.at(-1)!.replace(/\.0$/, "") })
    expect(snapshot.rows).toHaveLength(PAGE_SIZE)
    expect(snapshot.hasMore).toBe(true)
    expect(snapshot.rows[0]!.id).toBe(ids[ids.length - PAGE_SIZE])
    let first = snapshot.rows[0]!.id
    const seen = [...snapshot.rows.map((r) => r.id)]
    for (;;) {
      const p = await thread.page(first)
      seen.unshift(...p.rows.map((r) => r.id))
      if (p.rows.length > 0) first = p.rows[0]!.id
      if (!p.hasMore) break
    }
    expect(seen).toEqual(ids)
  })

  it("a page of limit 1 and a page of a silly limit are both well formed", async () => {
    const { file, ids } = longFile(10)
    const { thread } = openThread(file, {}, { leafId: ids.at(-1)!.replace(/\.0$/, "") })
    expect((await thread.page(ids[5]!, 1)).rows.map((r) => r.id)).toEqual([ids[4]])
    expect((await thread.page(ids[5]!, 0)).rows).toHaveLength(1)
    expect((await thread.page(ids[5]!, 1e9)).rows.map((r) => r.id)).toEqual(ids.slice(0, 5))
    const top = await thread.page(ids[0]!)
    expect(top).toEqual({ rows: [], hasMore: false })
  })

  it("an unknown row id rejects with a sentence, not a crash", async () => {
    const { thread } = openThread(newFile(), {}, {})
    await expect(thread.page("nope")).rejects.toThrow(ActionError)
  })
})

describe("tool results", () => {
  it("a long result is cut in the row and whole from toolResult", async () => {
    const big = "x".repeat(TOOL_RESULT_CUT * 3)
    const file = newFile(
      userEntry(null, "run", "u1"),
      assistantEntry("u1", [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "yes" } }], "a1", { stopReason: "toolUse" }),
      toolResultEntry("a1", "c1", big, false, "r1"),
    )
    const { thread, snapshot } = openThread(file, {}, { leafId: "r1" })
    const row = snapshot.rows.find((r) => r.kind === "tool")
    expect(row?.kind === "tool" && row.result).toMatchObject({ truncated: true, totalChars: big.length })
    expect(row?.kind === "tool" && row.result?.text.length).toBeLessThanOrEqual(TOOL_RESULT_CUT + 100)
    expect(await thread.toolResult(row!.id)).toBe(big)
  })

  it("asking for the result of a row that has none is an ActionError", async () => {
    const { thread } = openThread(newFile(userEntry(null, "a", "u1")), {}, { leafId: "u1" })
    await expect(thread.toolResult("u1")).rejects.toBeInstanceOf(ActionError)
  })
})

describe("snapshot, then subscribe", () => {
  it("in the same tick nothing is lost: every change after the snapshot has the next seq, none twice", () => {
    const file = newFile(userEntry(null, "hi", "u1"))
    const { thread, changes, snapshot } = openThread(file, {}, { leafId: "u1", working: true })
    for (let i = 0; i < 20; i++) thread.handle(ext({ type: "reply", blocks: [{ kind: "text", text: "x".repeat(i + 1) }] }))
    expect(changes.map((c) => c.seq)).toEqual(Array.from({ length: 20 }, (_, i) => snapshot.seq + 1 + i))
  })

  it("a listener that throws does not stop the others or the thread", () => {
    const logs: string[] = []
    const { thread } = openThread(newFile(), { log: (l) => logs.push(l) }, { working: true })
    const got: number[] = []
    thread.subscribe(() => {
      throw new Error("boom")
    })
    thread.subscribe((c) => got.push(c.seq))
    thread.handle(ext({ type: "reply", blocks: [{ kind: "text", text: "a" }] }))
    expect(got).toHaveLength(1)
    expect(logs.join("\n")).toMatch(/listener threw/)
  })

  it("unsubscribing stops the calls", () => {
    const { thread } = openThread(newFile(), {}, { working: true })
    const got: number[] = []
    const off = thread.subscribe((c) => got.push(c.seq))
    off()
    thread.handle(ext({ type: "reply", blocks: [{ kind: "text", text: "a" }] }))
    expect(got).toEqual([])
  })
})

describe("actions", () => {
  const modelList = [
    { provider: "p", id: "m1", name: "M1", reasoning: true, efforts: ["low", "high"] },
    { provider: "p", id: "m2", name: "M2", reasoning: false, efforts: ["off"] },
  ]

  function withModels() {
    const o = openThread(newFile(), {}, { efforts: ["low", "high"], effort: "low" })
    o.thread.handle(ext({ type: "models", list: modelList }))
    return o
  }
  const lastAction = (sent: unknown[]) => sent.at(-1) as Action

  it("send goes out as an action and resolves when the extension says ok", async () => {
    const { thread, sent } = openThread(newFile(), {}, {})
    const p = thread.send("hello")
    const a = lastAction(sent)
    expect(a).toMatchObject({ v: WIRE_VERSION, type: "action", op: "send", text: "hello" })
    thread.handle(ext({ type: "result", id: a.id, ok: true }))
    await expect(p).resolves.toBeUndefined()
  })

  it("a refusal from pi comes back as an ActionError with pi's sentence", async () => {
    const { thread, sent } = openThread(newFile(), {}, {})
    const p = thread.stop()
    thread.handle(ext({ type: "result", id: lastAction(sent).id, ok: false, error: "Nothing is running." }))
    await expect(p).rejects.toThrow("Nothing is running.")
    await expect(p).rejects.toBeInstanceOf(ActionError)
  })

  it("an answer that never comes ends in an ActionError after the timeout, and a late answer is ignored", async () => {
    const { thread, sent } = openThread(newFile(), { actionTimeoutMs: 40 }, {})
    const p = thread.clearInput()
    await expect(p).rejects.toThrow(/did not answer in time/)
    expect(() => thread.handle(ext({ type: "result", id: lastAction(sent).id, ok: true }))).not.toThrow()
  })

  it("two actions at once are matched to their own answers, whatever the order", async () => {
    const { thread, sent } = openThread(newFile(), {}, {})
    const a = thread.send("one")
    const b = thread.send("two")
    const [ida, idb] = (sent as Action[]).slice(-2).map((m) => m.id)
    expect(ida).not.toBe(idb)
    thread.handle(ext({ type: "result", id: idb!, ok: false, error: "no" }))
    thread.handle(ext({ type: "result", id: ida!, ok: true }))
    await expect(a).resolves.toBeUndefined()
    await expect(b).rejects.toThrow("no")
  })

  it("empty or blank text is refused here, nothing is sent", async () => {
    const { thread, sent } = openThread(newFile(), {}, {})
    const before = sent.length
    await expect(thread.send("   \n")).rejects.toBeInstanceOf(ActionError)
    expect(sent.length).toBe(before)
  })

  it("a model pi does not offer and an effort the model does not take are refused without asking pi", async () => {
    const { thread, sent } = withModels()
    const before = sent.length
    await expect(thread.setModel("p/zzz")).rejects.toThrow(/does not offer/)
    await expect(thread.setEffort("max")).rejects.toThrow(/takes: low, high/)
    expect(sent.length).toBe(before)
    const ok = thread.setModel("p/m2")
    expect(lastAction(sent)).toMatchObject({ op: "set_model", model: "p/m2" })
    thread.handle(ext({ type: "result", id: lastAction(sent).id, ok: true }))
    await ok
  })

  it("capabilities list the models as provider/id and the effort levels of the current model; an effort change is reported by the next state", () => {
    const { thread, changes } = withModels()
    const caps = thread.snapshot().capabilities
    expect(caps.models).toEqual({ list: [{ id: "p/m1", name: "M1", reasoning: true }, { id: "p/m2", name: "M2", reasoning: false }], current: "llama-swap/local" })
    expect(caps.efforts).toEqual({ list: ["low", "high"], current: "low" })
    changes.length = 0
    thread.handle(state({ model: { provider: "p", id: "m1", name: "M1", reasoning: true }, effort: "high", efforts: ["low", "high"] }))
    const c = changes[0]
    expect(c?.type === "update" && c.capabilities?.efforts?.current).toBe("high")
    expect(c?.type === "update" && c.capabilities?.models?.current).toBe("p/m1")
  })

  it("every action after close, and every one waiting at close, is an ActionError", async () => {
    const { thread } = openThread(newFile(), {}, {})
    const waiting = thread.send("x")
    thread.close()
    await expect(waiting).rejects.toThrow(/no longer connected/)
    await expect(thread.stop()).rejects.toThrow(/no longer connected/)
    expect(thread.closed).toBe(true)
  })

  it("a write to a dead socket is an ActionError, not a throw", async () => {
    const { thread } = openThread(newFile(), { send: () => { throw new Error("EPIPE") } }, {})
    await expect(thread.send("x")).rejects.toBeInstanceOf(ActionError)
  })
})

describe("closing", () => {
  it("onClose fires once, also for a listener added after; messages after close change nothing", () => {
    const { thread, changes } = openThread(newFile(), {}, { working: true })
    let n = 0
    thread.onClose(() => n++)
    thread.close()
    thread.close()
    thread.onClose(() => n++)
    expect(n).toBe(2)
    thread.handle(ext({ type: "reply", blocks: [{ kind: "text", text: "x" }] }))
    expect(changes).toEqual([])
  })
})

describe("the thread's title", () => {
  it("is the session name when there is one, else the first words of the first message", () => {
    const file = newFile(userEntry(null, "Fix the flaky login test\nand then the rest", "u1"))
    const o = openThread(file, {}, { leafId: "u1" })
    expect(o.snapshot.identity.title).toBe("Fix the flaky login test")
    o.thread.handle(state({ leafId: "u1", name: "login-fix" }))
    expect(o.thread.snapshot().identity.title).toBe("login-fix")
    expect(o.changes.at(-1)?.type === "update" && o.changes.at(-1)).toMatchObject({ identity: { title: "login-fix" } })
  })
})
