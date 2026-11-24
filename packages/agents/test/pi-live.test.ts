import fs from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { NO_CHAT, NO_CONTROL, PI_BUILTIN_COMMANDS, PI_LIVE_MAX_LINE_BYTES, TOO_LONG, connectPiLive, type PiLiveConnection, type PiLiveOptions, type PiLiveReady } from "../src/index.js"
import { ActionError } from "../src/thread.js"
import { ThreadChangeSchema, type ThreadChange } from "../src/rows.js"
import { BUILT_INS, FakePi, chatPicture, until, type FakeConfig } from "./fake-pi-live.js"
import { appendEntries, assistantEntry, sessionHeader, tmpDir, userEntry } from "./helpers.js"

const fakes: FakePi[] = []
const connections: PiLiveConnection[] = []
afterEach(async () => {
  for (const c of connections.splice(0)) c.close()
  for (const f of fakes.splice(0)) await f.stop()
})

function sessionFile(...entries: unknown[]): string {
  const file = path.join(tmpDir(), "s.jsonl")
  fs.writeFileSync(file, [sessionHeader, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n")
  return file
}

/** A fake pi-live and a connection to it, ready (unless the test says it will not be). */
async function open(config: FakeConfig = {}, options: Partial<PiLiveOptions> = {}) {
  const fake = await FakePi.start(config)
  fakes.push(fake)
  const log: string[] = []
  const connection = connectPiLive(fake.path, { terminalId: "t1", log: (l) => log.push(l), welcomeTimeoutMs: 1000, ...options })
  connections.push(connection)
  return { fake, connection, log }
}

async function opened(config: FakeConfig = {}, options: Partial<PiLiveOptions> = {}) {
  const o = await open(config, options)
  const ready = await o.connection.ready
  const changes: ThreadChange[] = []
  const snapshot = ready.thread.snapshot()
  ready.thread.subscribe((c) => changes.push(ThreadChangeSchema.parse(c)))
  return { ...o, ready, thread: ready.thread, changes, snapshot }
}

const text = (t: string) => ({ type: "text", text: t })
const twoModels = [
  { provider: "p", id: "m1", name: "M1", reasoning: true, efforts: ["low", "high"] },
  { provider: "p", id: "m2", name: "M2", reasoning: false, efforts: ["off"] },
]

describe("the first picture", () => {
  it("says hello first, as a chat client named herdr-web, speaking protocol 1", async () => {
    const { fake } = await opened()
    expect(fake.received[0]).toEqual({ type: "hello", protocol: 1, client: { name: "herdr-web" }, chat: true })
    expect(fake.junk).toEqual([])
  })

  it("a welcome taken mid-reply with a tool running is a complete snapshot, and the next message continues it", async () => {
    const file = sessionFile(userEntry(null, "run the tests", "u1"))
    const chat = chatPicture({
      state: { ...chatPicture().state, leafId: "u1", working: true, name: "tests", efforts: ["low", "high"], effort: "low", model: { provider: "p", id: "m1", name: "M1", reasoning: true }, pending: [{ id: "p1", text: "and lint", mode: "steer" }], usage: { tokens: 1200, window: 200000, percent: 1 } },
      models: twoModels,
      reply: { blocks: [{ kind: "thinking", text: "hm" }, { kind: "text", text: "Running" }] },
      tools: [{ callId: "c1", name: "bash", argument: "bun test" }],
    })
    const { fake, thread, snapshot, changes, ready } = await opened({ chat, session: { file, name: "from welcome", terminal: "t9" } })
    expect(snapshot.live).toEqual({
      working: true,
      reply: { blocks: [{ kind: "thinking", text: "hm" }, { kind: "text", text: "Running" }] },
      tools: [{ callId: "c1", name: "bash", argument: "bun test" }],
      pending: [{ id: "p1", text: "and lint", mode: "steer" }],
      usage: { tokens: 1200, window: 200000, percent: 1 },
      notice: null,
      asks: [],
      waiting: null,
      approvals: [],
      approved: [],
    })
    expect(snapshot.rows.map((r) => [r.id, r.kind])).toEqual([["u1", "user"]])
    expect(snapshot.capabilities).toEqual({
      send: true,
      stop: true,
      models: { list: [{ id: "p/m1", name: "M1", reasoning: true }, { id: "p/m2", name: "M2", reasoning: false }], current: "p/m1" },
      efforts: { list: ["low", "high"], current: "low" },
    })
    expect(snapshot.identity).toEqual({ agent: "pi", terminalId: "t1", sessionId: "s-1", sessionFile: file, title: "tests", cwd: "/tmp/work" })
    expect(ready).toMatchObject({ chat: true, control: true, disabled: null, version: "0.2.0", features: ["chat", "control"], session: { id: "s-1", pid: 4242, mode: "tui", terminal: "t9" } })
    // The very next message is a change on top of the snapshot: nothing is missing between them.
    fake.send({ type: "reply", blocks: [{ kind: "text", text: "Running it" }] })
    await until(() => changes.length === 1)
    expect(changes[0]).toMatchObject({ type: "update", seq: snapshot.seq + 1, live: { reply: { blocks: [{ kind: "text", text: "Running it" }] }, tools: [{ callId: "c1" }] } })
    expect(thread.closed).toBe(false)
  })

  it("an idle welcome has no reply and no tools", async () => {
    const { snapshot } = await opened()
    expect(snapshot.live).toMatchObject({ working: false, reply: null, tools: [] })
  })
})

describe("every message kind", () => {
  it("state, models, reply, tool, entries and notice feed the thread; the finished reply becomes its row", async () => {
    const file = sessionFile(userEntry(null, "hi", "u1"))
    const { fake, thread, changes } = await opened({ session: { file } })
    const live = () => thread.snapshot().live
    fake.send({ type: "state", ...chatPicture().state, leafId: "u1", working: true })
    await until(() => live().working)
    fake.send({ type: "models", list: twoModels })
    await until(() => thread.snapshot().capabilities.models?.list.length === 2)
    fake.send({ type: "tool", phase: "start", callId: "c1", name: "bash", argument: "ls" })
    await until(() => live().tools.length === 1)
    fake.send({ type: "reply", blocks: [{ kind: "text", text: "Hello" }] })
    await until(() => live().reply !== null)
    fake.send({ type: "tool", phase: "end", callId: "c1", name: "bash", isError: false })
    await until(() => live().tools.length === 0)
    fake.send({ type: "notice", level: "error", text: "Compaction failed: nope" })
    await until(() => live().notice !== null)
    expect(live().notice).toEqual({ level: "error", text: "Compaction failed: nope" })
    changes.length = 0
    appendEntries(file, assistantEntry("u1", [text("Hello")], "a1"))
    fake.send({ type: "entries", leafId: "a1", replyDone: true })
    fake.send({ type: "state", ...chatPicture().state, leafId: "a1", working: false })
    await until(() => !live().working)
    expect(thread.snapshot().rows.map((r) => r.id)).toEqual(["u1", "a1.0"])
    expect(live().reply).toBeNull()
    const withRow = changes.filter((c) => c.type === "update" && c.rows?.some((r) => r.id === "a1.0"))
    expect(withRow).toHaveLength(1)
    expect(withRow[0]?.type === "update" && withRow[0].live?.reply).toBeNull() // row and live reply change together
  })

  it("commands, pong and unknown types are read and ignored (items and answers: asks-pi-live.test.ts; waitingForUser: waiting-pi-live.test.ts)", async () => {
    const { fake, thread, changes, log } = await opened()
    const before = JSON.stringify(thread.snapshot())
    fake.send({ type: "commands", list: [{ name: "x", description: "", source: "prompt" }] })
    fake.send({ type: "pong", reqId: "p1" })
    fake.send({ type: "from_the_future", anything: [1, 2, 3] })
    fake.send({ type: "state", ...chatPicture().state, aNewField: 1 })
    fake.send({ type: "reply", blocks: [{ kind: "text", text: "after" }], aNewField: true })
    await until(() => changes.length === 1)
    expect(changes[0]).toMatchObject({ type: "update", live: { reply: { blocks: [{ kind: "text", text: "after" }] } } })
    expect(thread.snapshot().capabilities).toEqual(JSON.parse(before).capabilities)
    expect(log).toEqual([])
  })

  it("a line that is not JSON, and a known message with the wrong shape, are logged and skipped; the connection goes on", async () => {
    const { fake, thread, changes, log, connection } = await opened()
    fake.sendRaw("not json\n")
    fake.send({ type: "reply", blocks: "nope" })
    fake.send({ type: "reply", blocks: [{ kind: "text", text: "fine" }] })
    await until(() => changes.length === 1)
    expect(log).toEqual(["pi-live: ignored a line that was not JSON", "pi-live: ignored an invalid reply message"])
    expect(thread.closed).toBe(false)
    expect(await Promise.race([connection.closed, Promise.resolve("open")])).toBe("open")
  })

  it("an error message from pi-live is logged, and the connection stays", async () => {
    const { fake, log, thread } = await opened()
    fake.send({ type: "error", message: "an unknown type" })
    await until(() => log.length === 1)
    expect(log[0]).toBe("pi-live: pi said: an unknown type")
    expect(thread.closed).toBe(false)
  })
})

describe("actions", () => {
  async function withModels(config: FakeConfig = {}) {
    return opened({ chat: chatPicture({ models: twoModels, state: { ...chatPicture().state, efforts: ["low", "high"], effort: "low" } }), ...config })
  }

  const cases: { name: string; run: (t: PiLiveReady["thread"]) => Promise<void>; sent: Record<string, unknown>; refusal: string }[] = [
    { name: "send", run: (t) => t.send("hello"), sent: { op: "send", text: "hello" }, refusal: "No API key is set up for the model." },
    { name: "stop", run: (t) => t.stop(), sent: { op: "stop" }, refusal: "Nothing is running." },
    { name: "set_model", run: (t) => t.setModel("p/m2"), sent: { op: "set_model", model: "p/m2" }, refusal: "No API key for p." },
    { name: "set_effort", run: (t) => t.setEffort("high"), sent: { op: "set_effort", effort: "high" }, refusal: "Not now." },
    { name: "set_name", run: (t) => t.setName("my session"), sent: { op: "set_name", name: "my session" }, refusal: "Names are locked." },
    { name: "compact", run: (t) => t.compact(), sent: { op: "compact" }, refusal: "Already compacting." },
    { name: "compact", run: (t) => t.compact("keep the plan"), sent: { op: "compact", instructions: "keep the plan" }, refusal: "Already compacting." },
    { name: "clear_input", run: (t) => t.clearInput(), sent: { op: "clear_input" }, refusal: "There is no input box." },
  ]

  for (const c of cases) {
    const label = `${c.name}${"instructions" in c.sent ? " with instructions" : ""}`
    it(`${label} goes out as an action with a reqId and resolves on ok`, async () => {
      const { fake, thread } = await withModels()
      await c.run(thread)
      const [action] = fake.actions()
      expect(action).toMatchObject({ type: "action", ...c.sent })
      expect(typeof action.reqId).toBe("string")
      expect(action).not.toHaveProperty("id")
      expect(Object.keys(action).sort()).toEqual(["type", "reqId", ...Object.keys(c.sent)].sort())
    })
    it(`${label}: pi's refusal arrives as an ActionError with pi's own sentence`, async () => {
      const { thread } = await withModels({ refusals: { [c.name]: c.refusal } })
      const failed = c.run(thread)
      await expect(failed).rejects.toBeInstanceOf(ActionError)
      await expect(failed).rejects.toThrow(c.refusal)
    })
  }

  it("a pi built-in typed to send is refused by pi-live with its sentence", async () => {
    const { thread } = await opened()
    await expect(thread.send("/new")).rejects.toThrow("pi-live can't run /new. Use the matching action, or type it in pi's terminal.")
  })

  it("a slash command that is not a built-in is sent as it is", async () => {
    const { thread, fake } = await opened()
    await thread.send("/skill:review the diff")
    expect(fake.actions()[0]).toMatchObject({ op: "send", text: "/skill:review the diff" })
  })

  it("empty text, an unknown model and an effort the model does not take are refused here without asking pi", async () => {
    const { thread, fake } = await withModels()
    await expect(thread.send("  ")).rejects.toThrow("There is nothing to send.")
    await expect(thread.setModel("p/zzz")).rejects.toThrow(/does not offer/)
    await expect(thread.setEffort("max")).rejects.toThrow(/takes: low, high/)
    expect(fake.actions()).toEqual([])
  })

  it("a compact whose instructions are blank sends none", async () => {
    const { thread, fake } = await opened()
    await thread.compact("   ")
    expect(fake.actions()[0]).not.toHaveProperty("instructions")
  })

  it("results are matched by reqId, never by position: a notice and the results of two actions arrive in another order", async () => {
    const { fake, thread, changes } = await opened({ autoReply: false })
    const first = thread.compact()
    const second = thread.send("two")
    const third = thread.stop()
    await until(() => fake.actions().length === 3)
    const [a, b, c] = fake.actions().map((m) => m.reqId as string)
    const settled: string[] = []
    first.then(() => settled.push("first"), () => settled.push("first"))
    second.then(() => settled.push("second"), () => settled.push("second"))
    third.then(() => settled.push("third"), () => settled.push("third"))
    // the effect of an action comes before its result, and the results are not in the order the actions went out
    fake.send({ type: "notice", level: "error", text: "Compaction failed: x" })
    fake.result(c!)
    fake.result(a!, "Compaction is not possible now.")
    fake.result("nobody", "an answer to nothing")
    fake.result(b!)
    await expect(first).rejects.toThrow("Compaction is not possible now.")
    await expect(second).resolves.toBeUndefined()
    await expect(third).resolves.toBeUndefined()
    expect(settled).toEqual(["third", "first", "second"])
    expect(changes[0]).toMatchObject({ type: "update", live: { notice: { level: "error", text: "Compaction failed: x" } } })
    expect(thread.snapshot().live.notice).toEqual({ level: "error", text: "Compaction failed: x" })
  })

  it("an action pi never answers ends in an ActionError after the timeout, and the late answer is ignored", async () => {
    const { fake, thread } = await opened({ autoReply: false }, { thread: { actionTimeoutMs: 40 } })
    const p = thread.stop()
    await expect(p).rejects.toThrow(/did not answer in time/)
    fake.result(fake.actions()[0].reqId)
    await new Promise((r) => setTimeout(r, 20))
    expect(thread.closed).toBe(false)
  })
})

describe("a pi-live too old for chat", () => {
  it("has no chat in its features: the rows are shown, the sentence is the one for old pi-live, and nothing is asked of pi", async () => {
    const file = sessionFile(userEntry(null, "hi", "u1"), assistantEntry("u1", [text("hello")], "a1"))
    const { fake, ready, thread, snapshot } = await opened({ features: undefined, chat: null, control: undefined, session: { file } })
    expect(ready).toMatchObject({ chat: false, disabled: NO_CHAT, features: [] })
    expect(NO_CHAT).toBe("Update pi-live to chat with this pi.")
    expect(snapshot.rows.map((r) => r.kind)).toEqual(["user", "assistant"])
    expect(snapshot.capabilities).toEqual({ send: false, stop: false, models: null, efforts: null, disabled: NO_CHAT })
    await expect(thread.send("hi")).rejects.toThrow(NO_CHAT)
    await expect(thread.stop()).rejects.toThrow(NO_CHAT)
    await expect(thread.compact()).rejects.toThrow(NO_CHAT)
    expect(fake.actions()).toEqual([])
  })

  it("a features list without chat is the same", async () => {
    const { ready } = await opened({ features: ["control"], chat: null })
    expect(ready).toMatchObject({ chat: false, disabled: NO_CHAT })
  })

  it("a welcome that says chat and carries none is closed", async () => {
    const { connection, log } = await open({ chat: null })
    await expect(connection.ready).rejects.toThrow(/before the welcome/)
    expect(log).toEqual(["pi-live: the welcome says chat but carries none; closing the connection"])
  })
})

describe("control off", () => {
  it("the chat is shown and kept up to date, sending is not: every action is refused with the sentence, asking nobody", async () => {
    const { fake, ready, thread, changes, snapshot } = await opened({ control: false, chat: chatPicture({ state: { ...chatPicture().state, working: true } }) })
    expect(ready).toMatchObject({ chat: true, control: false, disabled: NO_CONTROL })
    expect(NO_CONTROL).toBe("Control is off for this pi.")
    expect(snapshot.live.working).toBe(true)
    expect(snapshot.capabilities).toEqual({ send: false, stop: false, models: null, efforts: null, disabled: NO_CONTROL })
    fake.send({ type: "reply", blocks: [{ kind: "text", text: "still streaming" }] })
    await until(() => changes.length === 1)
    for (const act of [() => thread.send("x"), () => thread.stop(), () => thread.setModel("a/b"), () => thread.setEffort("low"), () => thread.setName("n"), () => thread.compact(), () => thread.clearInput()]) {
      await expect(act()).rejects.toThrow(NO_CONTROL)
    }
    expect(fake.actions()).toEqual([])
  })
})

describe("size", () => {
  it("a reply line of 10 MiB is read whole, in the welcome and as a message", async () => {
    const big = "x".repeat(10 * 1024 * 1024)
    const { fake, thread, snapshot, changes } = await opened({ chat: chatPicture({ reply: { blocks: [{ kind: "text", text: big }] } }) })
    expect(snapshot.live.reply?.blocks[0]?.text.length).toBe(big.length)
    fake.send({ type: "reply", blocks: [{ kind: "text", text: big + "y" }] })
    await until(() => changes.length === 1, "the big reply", 10_000)
    expect(thread.snapshot().live.reply?.blocks[0]?.text.length).toBe(big.length + 1)
    expect(thread.closed).toBe(false)
  })

  it("the line limit for a pi-live connection is 64 MiB", () => {
    expect(PI_LIVE_MAX_LINE_BYTES).toBe(64 * 1024 * 1024)
  })

  it("a line longer than the limit closes the connection with one log line", async () => {
    const { fake, thread, connection, log } = await opened({}, { maxLineBytes: 2 * 1024 * 1024 })
    fake.sendRaw(JSON.stringify({ type: "reply", blocks: [{ kind: "text", text: "z".repeat(3 * 1024 * 1024) }] }) + "\n")
    const end = await connection.closed
    expect(end).toEqual({ shutdown: null, why: "line too long" })
    expect(log).toEqual(["pi-live: a line from pi was longer than 2097152 bytes; closing the connection"])
    expect(thread.closed).toBe(true)
  })

  it("the same at the real limit: a line of 64 MiB and a byte, with no newline until its end", async () => {
    const { fake, thread, connection, log } = await opened()
    fake.sendRaw('{"type":"reply","blocks":[{"kind":"text","text":"' + "z".repeat(PI_LIVE_MAX_LINE_BYTES) + '"}]}\n')
    await connection.closed
    expect(log).toHaveLength(1)
    expect(log[0]).toMatch(/longer than 67108864 bytes/)
    expect(thread.closed).toBe(true)
  }, 20_000)

  it("a send over 1 MiB is refused with a sentence before anything is written, and the connection is still good", async () => {
    const { fake, thread, connection } = await opened()
    await expect(thread.send("x".repeat(1024 * 1024 + 1))).rejects.toThrow(TOO_LONG)
    await expect(thread.send("é".repeat(600 * 1024))).rejects.toThrow(TOO_LONG) // 1.2 MB in bytes, 600 thousand characters
    await thread.send("small")
    expect(fake.actions().map((a) => a.text)).toEqual(["small"])
    expect(fake.tooLong).toBe(false)
    expect(thread.closed).toBe(false)
    expect(await Promise.race([connection.closed, Promise.resolve("open")])).toBe("open")
  })
})

describe("the end of a connection", () => {
  it.each([["quit"], ["reload"], ["new"], ["resume"], ["fork"]])("a goodbye with shutdown %s is reported, and the thread closes", async (shutdown) => {
    const { fake, thread, connection } = await opened()
    fake.goodbye(shutdown)
    const end = await connection.closed
    expect(end.shutdown).toBe(shutdown)
    expect(thread.closed).toBe(true)
  })

  it("a goodbye that names no shutdown counts as quit", async () => {
    const { fake, connection } = await opened()
    fake.goodbye()
    expect((await connection.closed).shutdown).toBe("quit")
  })

  it("a close with no goodbye (a crash) has no shutdown", async () => {
    const { fake, thread, connection } = await opened()
    fake.crash()
    expect((await connection.closed).shutdown).toBeNull()
    expect(thread.closed).toBe(true)
  })

  it("actions waiting at the end, and after it, are ActionErrors", async () => {
    const { fake, thread, connection } = await opened({ autoReply: false })
    const waiting = thread.stop()
    await until(() => fake.actions().length === 1)
    fake.crash()
    await connection.closed
    await expect(waiting).rejects.toThrow(/no longer connected/)
    await expect(thread.stop()).rejects.toThrow(/no longer connected/)
  })

  it("closing it ourselves ends the thread and says so", async () => {
    const { thread, connection } = await opened()
    connection.close()
    expect(await connection.closed).toEqual({ shutdown: null, why: "closed by the backend" })
    expect(thread.closed).toBe(true)
  })
})

describe("a connection that does not get going", () => {
  it("a pi that never sends its welcome is closed after the timeout", async () => {
    const { connection, log } = await open({ silent: true }, { welcomeTimeoutMs: 60 })
    await expect(connection.ready).rejects.toThrow(/no welcome/)
    expect(log).toEqual(["pi-live: a pi did not send its welcome in time; closing the connection"])
  })

  it("a protocol other than 1 is closed with a line", async () => {
    const { connection, log } = await open({ welcome: { type: "welcome", protocol: 2, session: { id: "s", pid: 1 } } })
    await expect(connection.ready).rejects.toThrow(/protocol/)
    expect(log[0]).toMatch(/speaks protocol 2/)
  })

  it("a welcome with no session is closed with a line", async () => {
    const { connection, log } = await open({ welcome: { type: "welcome", protocol: 1 } })
    await expect(connection.ready).rejects.toThrow(/bad welcome/)
    expect(log[0]).toMatch(/the welcome was not valid \(session\)/)
  })

  it("an error from pi-live and then its close reject ready, and closed still resolves", async () => {
    const { fake, connection, log } = await open({ silent: true })
    await until(() => fake.received.length === 1)
    fake.send({ type: "error", message: "unsupported protocol" })
    fake.crash()
    await expect(connection.ready).rejects.toThrow(/before the welcome/)
    expect(await connection.closed).toMatchObject({ shutdown: null })
    expect(log).toEqual(["pi-live: pi said: unsupported protocol"])
  })

  it("nothing listening there: ready rejects and closed resolves", async () => {
    const connection = connectPiLive(path.join(tmpDir(), "none.sock"), { terminalId: "t1" })
    await expect(connection.ready).rejects.toThrow(/before the welcome/)
    expect((await connection.closed).shutdown).toBeNull()
  })
})

describe("pi's built-in commands", () => {
  it("are the ones protocol.md lists (the fake's transcription of it)", () => {
    expect([...PI_BUILTIN_COMMANDS]).toEqual(BUILT_INS)
  })
})
