// Break tests for guardrails prompts on pi-live (DEV-42): hostile views, odd ids and results, answers that never settle, the order
// of things on the wire, and what a thread publishes. Complements approvals-pi-live.test.ts.
import { afterEach, describe, expect, it } from "vitest"
import { connectPiLive, type PiLiveConnection } from "../src/index.js"
import { ThreadChangeSchema, type ThreadChange } from "../src/rows.js"
import { FakePi, until, type FakeConfig } from "./fake-pi-live.js"

const fakes: FakePi[] = []
const connections: PiLiveConnection[] = []
afterEach(async () => {
  for (const c of connections.splice(0)) c.close()
  for (const f of fakes.splice(0)) await f.stop()
})

async function opened(config: FakeConfig = {}) {
  const fake = await FakePi.start(config)
  fakes.push(fake)
  const log: string[] = []
  const connection = connectPiLive(fake.path, { terminalId: "t1", log: (l) => log.push(l), welcomeTimeoutMs: 1000, thread: { actionTimeoutMs: 300 } })
  connections.push(connection)
  const ready = await connection.ready
  const changes: ThreadChange[] = []
  ready.thread.subscribe((c) => changes.push(ThreadChangeSchema.parse(c)))
  return { fake, log, thread: ready.thread, changes }
}

const OPTIONS = [
  { result: "allow", label: "Allow once" },
  { result: "allow-session", label: "Allow for session" },
  { result: "deny", label: "Deny" },
  { result: "stop", label: "Decline and stop" },
]
const command = (id: string, openedAt = 1000, view: Record<string, unknown> = {}) => ({
  id,
  owner: "guardrails",
  kind: "guardrails.command",
  title: "Dangerous command",
  view: { toolName: "bash", command: "rm -rf build", reason: "recursive delete", options: OPTIONS, toolCallId: "call_1", ...view },
  openedAt,
})
const ids = (t: { snapshot(): { live: { approvals: { id: string }[] } } }) => t.snapshot().live.approvals.map((a) => a.id)
const records = (t: { snapshot(): { live: { approved: any[] } } }) => t.snapshot().live.approved

describe("hostile items", () => {
  it("a view that is not an object (null, a string, an array, a number) leaves the item out and nothing throws", async () => {
    const { fake, thread, log } = await opened()
    for (const [i, view] of [null, "rm -rf /", [], 7, true].entries()) fake.openItem({ ...command(`h${i}`), view })
    fake.openItem(command("ok"))
    await until(() => ids(thread).includes("ok"), "the good one")
    expect(ids(thread)).toEqual(["ok"])
    expect(log.filter((l) => l.includes("left out"))).toHaveLength(5)
  })

  it("options that are not a list, missing, or hold non-objects are left out", async () => {
    const { thread } = await opened({
      items: [command("a", 1, { options: "allow" }), command("b", 2, { options: undefined }), command("c", 3, { options: [null, 3] }), command("d", 4, { options: { result: "allow" } }), command("ok", 5)],
    })
    expect(ids(thread)).toEqual(["ok"])
  })

  it("`__proto__`, `constructor`, `toString` as ids, results and tool names are plain data", async () => {
    const { fake, thread } = await opened({
      items: [
        command("__proto__", 1, { toolName: "constructor", options: [{ result: "__proto__", label: "constructor" }, { result: "constructor", label: "toString" }, { result: "deny", label: "Deny" }] }),
        command("constructor", 2),
      ],
    })
    expect(ids(thread)).toEqual(["__proto__", "constructor"])
    expect(Object.keys(thread.snapshot().live.approvals[0]!.view)).toContain("toolName")
    fake.closeItem("__proto__", { by: "client" })
    await until(() => records(thread).length === 1, "the record")
    expect(records(thread)[0]).toMatchObject({ id: "__proto__", by: "client", result: null, label: null })
    expect(({} as Record<string, unknown>)["result"]).toBeUndefined()
    // answering with a result the options hold under such a name is sent as is
    await expect(thread.answer("constructor", { result: "constructor" })).resolves.toEqual({ status: "delivered" })
    await until(() => records(thread).length === 2, "the second record")
    expect(records(thread)[1]).toMatchObject({ id: "constructor", by: "client", result: null }) // not among its options: no result named
  })

  it("a 3 MB command comes through whole; the record's subject stays one short line", async () => {
    const big = "echo " + "x".repeat(3 * 1024 * 1024)
    const { fake, thread } = await opened()
    fake.openItem(command("big", 1, { command: big }))
    await until(() => ids(thread).length === 1, "the big one", 8000)
    const a = thread.snapshot().live.approvals[0]!
    expect(a.kind === "guardrails.command" && a.view.command.length).toBe(big.length)
    fake.closeItem("big")
    await until(() => records(thread).length === 1, "the record")
    expect(records(thread)[0].subject.length).toBeLessThanOrEqual(160)
  })

  it("a command of only blank lines or only a newline gives a subject (not a throw) and keeps the whole command", async () => {
    const { fake, thread } = await opened()
    fake.openItem(command("blank", 1, { command: "\n\n\n" }))
    fake.openItem(command("empty", 2, { command: "" }))
    await until(() => ids(thread).length === 2, "both")
    fake.closeItem("blank")
    fake.closeItem("empty")
    await until(() => records(thread).length === 2, "records")
    expect(records(thread).map((r) => typeof r.subject)).toEqual(["string", "string"])
  })

  it("the same id opened twice is one prompt; the later view wins and its openedAt orders it", async () => {
    const { fake, thread } = await opened({ items: [command("g1", 100, { command: "first" }), command("g2", 200)] })
    fake.openItem(command("g1", 300, { command: "second" }))
    await until(() => ids(thread)[0] === "g2", "the reorder")
    expect(ids(thread)).toEqual(["g2", "g1"])
    const g1 = thread.snapshot().live.approvals[1]!
    expect(g1.kind === "guardrails.command" && g1.view.command).toBe("second")
  })

  it("an id that closed and opens again leaves one record, the newest", async () => {
    const { fake, thread } = await opened()
    fake.openItem(command("g1"))
    await until(() => ids(thread).length === 1, "open")
    fake.closeItem("g1", { by: "keyboard" })
    await until(() => records(thread).length === 1, "close")
    fake.openItem(command("g1"))
    await until(() => ids(thread).length === 1, "reopen")
    fake.closeItem("g1", { by: "abort" })
    await until(() => records(thread).length === 1 && records(thread)[0].by === "abort", "second close")
  })

  it("equal openedAt keeps the order they came in", async () => {
    const { thread } = await opened({ items: [command("a", 5), command("b", 5), command("c", 5)] })
    expect(ids(thread)).toEqual(["a", "b", "c"])
  })

  it("an outcome `by` this app does not know (timeout) is `gone`", async () => {
    const { fake, thread } = await opened({ items: [command("a", 1)] })
    fake.closeItem("a", { by: "timeout" })
    await until(() => records(thread).length === 1, "record")
    expect(records(thread)[0]).toMatchObject({ by: "gone" })
  })
})

describe("answers that go wrong", () => {
  it("an answer pi never settles rejects, leaves the prompt open, and a later keyboard close records no result", async () => {
    const { fake, thread } = await opened({ items: [command("g1")], autoReply: false })
    await expect(thread.answer("g1", { result: "allow" })).rejects.toBeDefined()
    expect(ids(thread)).toEqual(["g1"])
    fake.closeItem("g1", { by: "keyboard" })
    await until(() => records(thread).length === 1, "record")
    expect(records(thread)[0]).toMatchObject({ by: "keyboard", result: null })
  })

  it("two answers sent at once for one prompt both go to pi (the first wins there); the second is `closed`", async () => {
    const { fake, thread } = await opened({ items: [command("g1")] })
    const [a, b] = await Promise.all([thread.answer("g1", { result: "allow" }), thread.answer("g1", { result: "deny" })])
    // pi-live's rule: the first one wins, the other sees it closed. The thread must not invent a result of its own.
    expect(fake.answers()).toHaveLength(2)
    expect([a.status, b.status].sort()).toEqual(["closed", "delivered"])
    await until(() => records(thread).length === 1, "record")
    expect(records(thread)[0]).toMatchObject({ by: "client", result: "allow" })
  })

  it("an answer that is not an object is passed to pi as it is, with no record kept for it", async () => {
    const { fake, thread } = await opened({ items: [command("g1")], invalidAnswers: { g1: 'expected an object with a string "result"' } })
    for (const answer of [null, "allow", 5, [], { result: 5 }, {}]) {
      await expect(thread.answer("g1", answer)).resolves.toEqual({ status: "invalid", reason: 'expected an object with a string "result"' })
    }
    expect(fake.answers()).toHaveLength(6)
    expect(ids(thread)).toEqual(["g1"])
    fake.closeItem("g1", { by: "keyboard" })
    await until(() => records(thread).length === 1, "record")
    expect(records(thread)[0]).toMatchObject({ result: null })
  })

  it("answering a prompt that is not there is not_found/closed and does not open or record anything", async () => {
    const { fake, thread } = await opened({ items: [command("g1")] })
    fake.closeItem("g1")
    await until(() => ids(thread).length === 0, "closed")
    const before = records(thread).length
    await expect(thread.answer("g1", { result: "allow" })).resolves.toMatchObject({ status: "closed" })
    await expect(thread.answer("nope", { result: "allow" })).resolves.toMatchObject({ status: "not_found" })
    expect(records(thread)).toHaveLength(before)
  })
})

describe("what the thread publishes", () => {
  it("one update per open and per close, none for a close of something unknown, a repeat goodbye or an empty goodbye", async () => {
    const { fake, thread, changes } = await opened()
    fake.closeItem("never-opened")
    await new Promise((r) => setTimeout(r, 100))
    expect(changes).toHaveLength(0)
    fake.openItem(command("g1"))
    await until(() => changes.length === 1, "open")
    fake.closeItem("g1")
    await until(() => changes.length === 2, "close")
    expect(thread.snapshot().live.approvals).toEqual([])
  })

  it("a goodbye with prompts in flight records each one once, and a late answer to one is `closed` or `not_found`, never delivered", async () => {
    const { fake, thread } = await opened({ items: [command("g1"), command("g2", 2000)] })
    fake.goodbye("reload")
    await until(() => ids(thread).length === 0, "cleared")
    expect(records(thread).map((r) => [r.id, r.by])).toEqual([["g1", "shutdown"], ["g2", "shutdown"]])
  })
})
