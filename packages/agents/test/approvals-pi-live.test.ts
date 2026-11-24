// Guardrails prompts parked on pi-live (Trex-Hub/pi-guardrails): read into `live.approvals`, answered with `{result}`,
// and kept as a record in `live.approved` once they close. Against the fake pi-live.
import { afterEach, describe, expect, it } from "vitest"
import { connectPiLive, type PiLiveConnection } from "../src/index.js"
import { APPROVAL_RECORDS, LiveSchema, ThreadChangeSchema, type ThreadChange } from "../src/rows.js"
import { approvalSubject } from "../src/pi/approvals.js"
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

const COMMAND_OPTIONS = [
  { result: "allow", label: "Allow once" },
  { result: "allow-session", label: "Allow for session" },
  { result: "deny", label: "Deny" },
  { result: "stop", label: "Decline and stop" },
]

const command = (id: string, openedAt = 1000, view: Record<string, unknown> = {}) => ({
  id,
  owner: "guardrails",
  kind: "guardrails.command",
  title: "Dangerous command: recursive delete",
  view: { toolName: "bash", command: "rm -rf build", reason: "recursive delete", options: COMMAND_OPTIONS, toolCallId: "call_1", ...view },
  openedAt,
})

const path = (id: string, openedAt = 2000, view: Record<string, unknown> = {}) => ({
  id,
  owner: "guardrails",
  kind: "guardrails.path",
  title: "Outside workspace: ~/.ssh/config",
  view: {
    toolName: "read",
    path: "/Users/dev/.ssh/config",
    displayPath: "~/.ssh/config",
    directory: "/Users/dev/.ssh",
    cwd: "/Users/dev/work",
    target: "file",
    reason: "outside the workspace",
    alwaysSavedTo: "project",
    options: [
      { result: "allow-file-once", label: "Allow once" },
      { result: "allow-file-session", label: "Allow file this session" },
      { result: "allow-file-always", label: "Allow file always", disabled: true, disabledReason: "project not trusted" },
      { result: "deny", label: "Deny" },
    ],
    toolCallId: "call_2",
    ...view,
  },
  openedAt,
})

const open = (t: { snapshot(): { live: { approvals: { id: string }[] } } }) => t.snapshot().live.approvals.map((a) => a.id)
const records = (t: { snapshot(): { live: { approved: unknown[] } } }) => t.snapshot().live.approved

describe("guardrails prompts", () => {
  it("come from the welcome, both kinds, oldest first, with their views whole", async () => {
    const long = Array.from({ length: 40 }, (_, i) => `echo ${i}`).join("\n")
    const { thread } = await opened({ items: [path("p1", 2000), command("g1", 1000, { command: long })] })
    const live = thread.snapshot().live
    expect(live.approvals.map((a) => [a.id, a.kind])).toEqual([["g1", "guardrails.command"], ["p1", "guardrails.path"]])
    expect(live.approvals[0]!.kind === "guardrails.command" && live.approvals[0]!.view.command).toBe(long)
    expect(live.approvals[1]!.view.options[2]).toEqual({ result: "allow-file-always", label: "Allow file always", disabled: true, disabledReason: "project not trusted" })
    expect(live.asks).toEqual([])
  })

  it("item_opened adds one, a keyboard close removes it and leaves a record without a result", async () => {
    const { fake, thread, changes } = await opened()
    fake.openItem(command("g1"))
    await until(() => open(thread).length === 1, "the approval")
    expect(changes.at(-1)).toMatchObject({ type: "update", live: { approvals: [{ id: "g1" }] } })
    fake.closeItem("g1", { by: "keyboard" })
    await until(() => open(thread).length === 0, "the close")
    expect(records(thread)).toEqual([{ id: "g1", kind: "guardrails.command", callId: "call_1", subject: "rm -rf build", by: "keyboard", result: null, label: null }])
  })

  it("an answer goes on the wire as `{result}`, and once pi takes it the record names the result and its label", async () => {
    const { fake, thread } = await opened({ items: [command("g1")] })
    await expect(thread.answer("g1", { result: "allow-session" })).resolves.toEqual({ status: "delivered" })
    expect(fake.answers()[0]).toMatchObject({ id: "g1", answer: { result: "allow-session" } })
    await until(() => records(thread).length === 1, "the record")
    expect(records(thread)[0]).toMatchObject({ by: "client", result: "allow-session", label: "Allow for session" })
  })

  it("an invalid answer keeps it open with pi's reason, and records no result", async () => {
    const { fake, thread } = await opened({ items: [path("p1")], invalidAnswers: { p1: 'option "allow-file-always" disabled: project not trusted' } })
    await expect(thread.answer("p1", { result: "allow-file-always" })).resolves.toEqual({ status: "invalid", reason: 'option "allow-file-always" disabled: project not trusted' })
    expect(open(thread)).toEqual(["p1"])
    fake.closeItem("p1", { by: "keyboard" })
    await until(() => records(thread).length === 1, "the record")
    expect(records(thread)[0]).toMatchObject({ by: "keyboard", result: null })
  })

  it("another client's answer is `client` with no result; an abort, an error and an unknown `by` keep theirs", async () => {
    const { fake, thread } = await opened({ items: [command("a", 1), command("b", 2), command("c", 3), command("d", 4)] })
    fake.closeItem("a", { by: "client", client: { connId: "c9", name: "phone" } })
    fake.closeItem("b", { by: "abort" })
    fake.closeItem("c", { by: "error" })
    fake.closeItem("d", { by: "teleport" })
    await until(() => records(thread).length === 4, "the records")
    expect(records(thread).map((r: any) => [r.id, r.by, r.result])).toEqual([["a", "client", null], ["b", "abort", null], ["c", "error", null], ["d", "gone", null]])
  })

  it("a goodbye closes the open ones as `shutdown`, in one update", async () => {
    const { fake, thread, changes } = await opened({ items: [command("g1"), path("p1")] })
    fake.goodbye("reload")
    await until(() => changes.length > 0, "the update")
    expect(changes[0]).toMatchObject({ type: "update", live: { approvals: [], approved: [{ id: "g1", by: "shutdown" }, { id: "p1", by: "shutdown" }] } })
  })

  it("a nested call is recorded under its parent's row; no call id is null", async () => {
    const { fake, thread } = await opened({ items: [command("n", 1, { toolCallId: "cm_1/3", parentToolCallId: "cm_1" }), command("o", 2, { toolCallId: undefined })] })
    fake.closeItem("n")
    fake.closeItem("o")
    await until(() => records(thread).length === 2, "the records")
    expect(records(thread).map((r: any) => r.callId)).toEqual(["cm_1", null])
  })

  it("records are capped, newest kept", async () => {
    const { fake, thread } = await opened()
    for (let i = 0; i < APPROVAL_RECORDS + 5; i++) {
      fake.openItem(command(`g${i}`, i))
      fake.closeItem(`g${i}`)
    }
    await until(() => records(thread).length === APPROVAL_RECORDS && (records(thread).at(-1) as any).id === `g${APPROVAL_RECORDS + 4}`, "the records")
    expect((records(thread)[0] as any).id).toBe("g5")
  })

  it("an unknown kind, a view that does not fit, or `__proto__` as kind are left out with a log line; the waiting line is untouched", async () => {
    const { thread, log } = await opened({
      items: [{ ...command("x1"), kind: "guardrails.network" }, { ...command("x2"), view: { command: 3 } }, { ...command("x3"), kind: "__proto__" }, path("ok")],
    })
    expect(open(thread)).toEqual(["ok"])
    expect(log.filter((l) => l.includes("left out a guardrails item"))).toHaveLength(3)
  })

  it("ask_user prompts still go to `asks`", async () => {
    const ask = { id: "q1", owner: "ask_user", kind: "ask_user.question", title: "?", view: { question: "?", options: [], allowMultiple: false, allowFreeform: true, allowComment: false }, openedAt: 1 }
    const { thread } = await opened({ items: [ask, command("g1")] })
    expect(thread.snapshot().live.asks.map((a) => a.id)).toEqual(["q1"])
    expect(open(thread)).toEqual(["g1"])
  })
})

describe("the subject of a record", () => {
  const approval = (cmd: string) => ({ id: "x", kind: "guardrails.command" as const, title: "", openedAt: 0, view: { toolName: "bash", command: cmd, reason: "", options: [] } })
  it("is the first line, marked when more follow, and cut to a line", () => {
    expect(approvalSubject(approval("rm -rf a"))).toBe("rm -rf a")
    expect(approvalSubject(approval("set -e\nrm -rf a"))).toBe("set -e …")
    expect(approvalSubject(approval("x".repeat(500))).length).toBe(160)
  })
})

describe("the live shape", () => {
  it("reads a live from an older backend (no approvals) as none", () => {
    const old = { working: false, reply: null, tools: [], pending: [], usage: null, notice: null, asks: [], waiting: null }
    expect(LiveSchema.parse(old)).toMatchObject({ approvals: [], approved: [] })
  })
})
