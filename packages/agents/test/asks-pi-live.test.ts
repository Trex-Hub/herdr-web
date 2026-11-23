// Prompts parked on pi-live: read from the welcome and item_*, answered with `answer`, against the fake pi-live.
import { afterEach, describe, expect, it } from "vitest"
import { NO_CONTROL, connectPiLive, type PiLiveConnection, type PiLiveOptions } from "../src/index.js"
import { ActionError } from "../src/thread.js"
import { ThreadChangeSchema, type ThreadChange } from "../src/rows.js"
import { FakePi, until, type FakeConfig } from "./fake-pi-live.js"

const fakes: FakePi[] = []
const connections: PiLiveConnection[] = []
afterEach(async () => {
  for (const c of connections.splice(0)) c.close()
  for (const f of fakes.splice(0)) await f.stop()
})

async function opened(config: FakeConfig = {}, options: Partial<PiLiveOptions> = {}) {
  const fake = await FakePi.start(config)
  fakes.push(fake)
  const log: string[] = []
  const connection = connectPiLive(fake.path, { terminalId: "t1", log: (l) => log.push(l), welcomeTimeoutMs: 1000, thread: { actionTimeoutMs: 300 }, ...options })
  connections.push(connection)
  const ready = await connection.ready
  const changes: ThreadChange[] = []
  ready.thread.subscribe((c) => changes.push(ThreadChangeSchema.parse(c)))
  return { fake, connection, log, ready, thread: ready.thread, changes }
}

const question = (id: string, openedAt = 1000, extra: Record<string, unknown> = {}) => ({
  id,
  owner: "ask_user",
  kind: "ask_user.question",
  title: "Which color?",
  view: { question: "Which color?", options: [{ title: "Green" }, { title: "Blue" }], allowMultiple: false, allowFreeform: true, allowComment: false, answer: { kind: "selection | freeform" } },
  openedAt,
  ...extra,
})
const batch = (id: string, openedAt = 2000) => ({
  id,
  owner: "ask_user",
  kind: "ask_user.batch",
  title: "Setup",
  view: { heading: "Setup", allowComment: false, questions: [{ question: "One?", options: [{ title: "a" }], allowMultiple: false, allowFreeform: false }] },
  openedAt,
  expiresAt: 5000,
})
const asks = (t: { snapshot(): { live: { asks: { id: string }[] } } }) => t.snapshot().live.asks.map((a) => a.id)
const selection = { kind: "selection", selections: ["Blue"] }

describe("open prompts", () => {
  it("come from the welcome, oldest first, a missing expiresAt as null", async () => {
    const { thread } = await opened({ items: [batch("c2", 2000), question("c1", 1000)] })
    const live = thread.snapshot().live
    expect(live.asks.map((a) => [a.id, a.kind, a.expiresAt])).toEqual([["c1", "ask_user.question", null], ["c2", "ask_user.batch", 5000]])
    expect(live.asks[0]!.view).not.toHaveProperty("answer")
  })

  it("are read even when the pi-live has no chat", async () => {
    const { thread, ready } = await opened({ features: ["control"], chat: null, items: [question("c1")] })
    expect(ready.chat).toBe(false)
    expect(asks(thread)).toEqual(["c1"])
  })

  it("item_opened adds one, item_closed removes it, each as one update", async () => {
    const { fake, thread, changes } = await opened()
    expect(asks(thread)).toEqual([])
    fake.openItem(question("c1"))
    await until(() => asks(thread).length === 1, "the ask")
    expect(changes.at(-1)).toMatchObject({ type: "update", live: { asks: [{ id: "c1" }] } })
    fake.openItem(question("c0", 500))
    await until(() => asks(thread).length === 2, "the second ask")
    expect(asks(thread)).toEqual(["c0", "c1"])
    fake.closeItem("c1", { by: "keyboard" })
    await until(() => asks(thread).length === 1, "the close")
    expect(asks(thread)).toEqual(["c0"])
    const seqs = changes.map((c) => c.seq)
    expect(seqs).toEqual(seqs.map((_, i) => seqs[0]! + i))
  })

  it("closing an id that is not open changes nothing", async () => {
    const { fake, thread, changes } = await opened({ items: [question("c1")] })
    fake.send({ type: "item_closed", id: "nope", outcome: { by: "keyboard" } })
    fake.openItem(question("c2"))
    await until(() => asks(thread).length === 2, "the ask")
    expect(changes).toHaveLength(1)
  })

  it("another owner's item, an unknown kind and a view that does not fit are left out, each with a log line", async () => {
    const { fake, thread, log } = await opened({ items: [{ ...question("x1"), owner: "other" }, { ...question("x2"), kind: "ask_user.form" }, { ...question("x3"), view: { question: 3 } }, question("ok")] })
    expect(asks(thread)).toEqual(["ok"])
    expect(log.filter((l) => l.includes("left out"))).toHaveLength(3)
    fake.send({ type: "item_opened", item: { id: "junk" } })
    fake.openItem({ ...question("x4"), owner: "dialogs" })
    fake.openItem(question("ok2", 3000))
    await until(() => asks(thread).length === 2, "the second ask")
    expect(asks(thread)).toEqual(["ok", "ok2"])
    expect(log.some((l) => l.includes("not valid"))).toBe(true)
  })

  it("a goodbye clears them all, as one update, and the connection ending leaves none", async () => {
    const { fake, thread, changes, connection } = await opened({ items: [question("c1"), batch("c2")] })
    fake.goodbye("reload")
    await until(() => changes.length > 0, "the update")
    expect(changes[0]).toMatchObject({ type: "update", live: { asks: [] } })
    await connection.closed
    expect(asks(thread)).toEqual([])
  })

  it("the connection ending without a goodbye leaves none", async () => {
    const { fake, thread, connection } = await opened({ items: [question("c1")] })
    fake.crash()
    await connection.closed
    expect(asks(thread)).toEqual([])
  })
})

describe("answering", () => {
  it("is put on the wire as pi-live wants it, and delivered closes the ask", async () => {
    const { fake, thread } = await opened({ items: [question("c1")] })
    await expect(thread.answer("c1", selection)).resolves.toEqual({ status: "delivered" })
    expect(fake.answers()).toEqual([{ type: "answer", reqId: expect.any(String), id: "c1", answer: selection }])
    await until(() => asks(thread).length === 0, "the close")
  })

  it("is not checked here: whatever the caller gives goes through, and pi-live's reason comes back", async () => {
    const { fake, thread } = await opened({ items: [question("c1")], invalidAnswers: { c1: 'option "Purple" not offered' } })
    const odd = { kind: "selection", selections: ["Purple"], more: [1, 2] }
    await expect(thread.answer("c1", odd)).resolves.toEqual({ status: "invalid", reason: 'option "Purple" not offered' })
    expect(fake.answers()[0].answer).toEqual(odd)
    expect(asks(thread)).toEqual(["c1"])
  })

  it("an answer to an id pi-live closed is `closed`, to one it never had `not_found`", async () => {
    const { fake, thread } = await opened({ items: [question("c1")] })
    fake.closeItem("c1")
    await expect(thread.answer("c1", selection)).resolves.toEqual({ status: "closed" })
    await expect(thread.answer("never", selection)).resolves.toEqual({ status: "not_found" })
  })

  it("matches each result to its answer by reqId, with two in flight", async () => {
    const { fake, thread } = await opened({ items: [question("c1"), question("c2", 1500)], autoReply: false })
    const first = thread.answer("c1", selection)
    const second = thread.answer("c2", selection)
    await until(() => fake.answers().length === 2, "both answers")
    const [a1, a2] = fake.answers()
    // pi-live answers in the other order, and the second says why not
    fake.answerResult(a2.reqId, "c2", "invalid", "only one selection allowed")
    fake.answerResult(a1.reqId, "c1", "delivered")
    await expect(second).resolves.toEqual({ status: "invalid", reason: "only one selection allowed" })
    await expect(first).resolves.toEqual({ status: "delivered" })
  })

  it("a result for no answer waiting, and one with a made-up reqId, are ignored", async () => {
    const { fake, thread } = await opened({ items: [question("c1")], autoReply: false })
    fake.answerResult("q99", "c1", "delivered")
    const pending = thread.answer("c1", selection)
    await until(() => fake.answers().length === 1, "the answer")
    fake.answerResult("zzz", "c1", "closed")
    fake.answerResult(fake.answers()[0].reqId, "c1", "delivered")
    await expect(pending).resolves.toEqual({ status: "delivered" })
    fake.answerResult(fake.answers()[0].reqId, "c1", "closed") // twice
    fake.send({ type: "answer_result", reqId: "q1", id: "c1", status: "maybe" })
    expect(asks(thread)).toEqual(["c1"])
  })

  it("works with control off: only actions are refused", async () => {
    const { fake, thread } = await opened({ control: false, items: [question("c1")] })
    expect(thread.snapshot().capabilities.disabled).toBe(NO_CONTROL)
    await expect(thread.stop()).rejects.toThrow(NO_CONTROL)
    await expect(thread.answer("c1", selection)).resolves.toEqual({ status: "delivered" })
    expect(fake.answers()).toHaveLength(1)
  })

  it("works with a pi-live that has no chat", async () => {
    const { thread } = await opened({ features: ["control"], chat: null, items: [question("c1")] })
    await expect(thread.answer("c1", selection)).resolves.toEqual({ status: "delivered" })
  })

  it("when pi-live says nothing, rejects with a sentence after actionTimeoutMs, and a late result changes nothing", async () => {
    const { fake, thread } = await opened({ items: [question("c1")], autoReply: false })
    const pending = thread.answer("c1", selection)
    await expect(pending).rejects.toThrow(ActionError)
    await expect(pending).rejects.toThrow(/did not answer in time/)
    fake.answerResult(fake.answers()[0].reqId, "c1", "delivered")
    expect(asks(thread)).toEqual(["c1"])
  })

  it("item_closed reaching us before the answer's own result (another client won): the ask is gone, and the answer resolves `closed`", async () => {
    const { fake, thread, changes } = await opened({ items: [question("c1")], autoReply: false })
    const pending = thread.answer("c1", selection)
    await until(() => fake.answers().length === 1, "the answer")
    fake.closeItem("c1", { by: "client", client: { connId: "c2", name: "another-tab" } })
    await until(() => asks(thread).length === 0, "the close")
    expect(changes.at(-1)).toMatchObject({ live: { asks: [] } })
    fake.answerResult(fake.answers()[0].reqId, "c1", "closed")
    await expect(pending).resolves.toEqual({ status: "closed" })
  })

  it("the connection ending while an answer is pending rejects it cleanly, at once", async () => {
    const { fake, thread, connection } = await opened({ items: [question("c1")], autoReply: false }, { thread: { actionTimeoutMs: 5000 } })
    const pending = thread.answer("c1", selection)
    const settled = pending.then(() => "resolved", (e: unknown) => e)
    await until(() => fake.answers().length === 1, "the answer")
    fake.crash()
    const error = await settled
    expect(error).toBeInstanceOf(ActionError)
    expect((error as Error).message).toBe("The agent is no longer connected.")
    await connection.closed
    await expect(thread.answer("c1", selection)).rejects.toThrow(/no longer connected/)
  })

  it("a goodbye while an answer is pending rejects it too", async () => {
    const { fake, thread } = await opened({ items: [question("c1")], autoReply: false }, { thread: { actionTimeoutMs: 5000 } })
    const settled = thread.answer("c1", selection).then(() => "resolved", (e: unknown) => e)
    await until(() => fake.answers().length === 1, "the answer")
    fake.goodbye("quit")
    expect(await settled).toBeInstanceOf(ActionError)
  })

  it("an answer too long for pi-live is refused with the sentence, nothing sent", async () => {
    const { fake, thread } = await opened({ items: [question("c1")] })
    await expect(thread.answer("c1", { kind: "freeform", text: "x".repeat(1024 * 1024 + 10) })).rejects.toThrow(/too long/)
    expect(fake.answers()).toHaveLength(0)
  })
})
