import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { agentsSocketPath } from "@herdr-web/agents/wire"
import { FakeBackend, FakePi, LOCAL, THINKER, sleep, tmpSocket, until } from "./harness.js"

const EVENTS = path.join(import.meta.dirname, "../../agents/test/fixtures/pi")

let backend: FakeBackend | null = null
const pis: FakePi[] = []
const saved = { ...process.env }

beforeEach(() => {
  for (const k of ["HC_TERMINAL_ID", "HERDR_WEB_AGENTS_SOCKET", "XDG_STATE_HOME"]) delete process.env[k]
})
afterEach(async () => {
  for (const pi of pis.splice(0)) pi.emit("session_shutdown")
  await backend?.close()
  backend = null
  process.env = { ...saved }
})

async function setup(opts: { listen?: boolean; terminal?: string | null } = {}) {
  const socketPath = tmpSocket()
  process.env.HERDR_WEB_AGENTS_SOCKET = socketPath
  if (opts.terminal !== null) process.env.HC_TERMINAL_ID = opts.terminal ?? "t7"
  if (opts.listen !== false) backend = await new FakeBackend(socketPath).listen()
  const pi = new FakePi()
  pis.push(pi)
  pi.load()
  return { pi, socketPath }
}

const start = (pi: FakePi, reason = "startup") => pi.emit("session_start", { reason })

describe("when pi was not started by herdr-core", () => {
  it("registers nothing and never touches the socket, even when a backend is listening", async () => {
    const { pi } = await setup({ terminal: null })
    expect(pi.handlers.size).toBe(0)
    start(pi)
    await sleep(150)
    expect(backend!.conns).toHaveLength(0)
  })
})

describe("with a terminal id", () => {
  it("says hello first (terminal id, session), then models, then the state, all valid", async () => {
    const { pi } = await setup()
    pi.leaf = "leaf-1"
    start(pi)
    await until(() => (backend!.conns[0]?.messages.length ?? 0) >= 3)
    const [hello, models, state] = backend!.conns[0]!.messages
    expect(hello).toMatchObject({ type: "hello", agent: "pi", terminalId: "t7", reason: "startup", session: { id: "sid-1", file: "/tmp/work/s.jsonl", cwd: "/tmp/work" } })
    expect(models?.type).toBe("models")
    expect(state).toMatchObject({ type: "state", leafId: "leaf-1", working: false, effort: "off", efforts: ["off"], model: { provider: "llama-swap", id: "local" } })
    expect(backend!.conns[0]!.invalid).toEqual([])
  })

  it("the reason of the session start (new, resume, fork, reload) is told to the backend", async () => {
    const { pi } = await setup()
    start(pi, "reload")
    await until(() => backend!.conns[0]?.messages[0] !== undefined)
    expect(backend!.conns[0]!.messages[0]).toMatchObject({ reason: "reload" })
  })

  it("a model that cannot reason offers only `off`; one that can offers its levels minus those its map forbids, and xhigh/max only when mapped", async () => {
    const { pi } = await setup()
    start(pi)
    await until(() => backend!.of("models").length === 1)
    const list = backend!.of("models")[0]!.list
    expect(list.find((m) => m.id === "local")!.efforts).toEqual(["off"])
    expect(list.find((m) => m.id === "think")!.efforts).toEqual(["off", "low", "medium", "high", "xhigh"])
  })

  it("the model list is the scoped models when pi has them", async () => {
    const { pi } = await setup()
    const ctx = pi.ctx
    pi.ctx = () => ({ ...ctx(), scopedModels: [{ model: THINKER }] })
    start(pi)
    await until(() => backend!.of("models").length === 1)
    expect(backend!.of("models")[0]!.list.map((m) => m.id)).toEqual(["think"])
  })

  it("uses the socket in XDG_STATE_HOME when no override is set, the same path the backend side computes", async () => {
    const dir = path.dirname(tmpSocket())
    const env = { XDG_STATE_HOME: dir }
    const expected = agentsSocketPath(env as never)
    fs.mkdirSync(path.dirname(expected), { recursive: true })
    backend = await new FakeBackend(expected).listen()
    process.env.XDG_STATE_HOME = dir
    process.env.HC_TERMINAL_ID = "t2"
    const pi = new FakePi()
    pis.push(pi)
    pi.load()
    start(pi)
    await until(() => backend!.conns.length === 1)
  })
})

describe("without a backend", () => {
  it("pi is not disturbed: no throw, nothing printed, handlers return nothing, and the extension connects when the backend appears", async () => {
    const out = vi.spyOn(process.stdout, "write")
    const err = vi.spyOn(process.stderr, "write")
    const { pi, socketPath } = await setup({ listen: false })
    expect(start(pi)).toEqual([undefined])
    pi.emit("agent_start")
    pi.emit("message_update", { message: { role: "assistant", content: [{ type: "text", text: "x" }] } })
    pi.emit("agent_settled")
    await sleep(100)
    const written = [...out.mock.calls, ...err.mock.calls].map((c) => String(c[0])).filter((s) => !s.includes("vitest"))
    expect(written).toEqual([])
    backend = await new FakeBackend(socketPath).listen()
    await until(() => backend!.conns.length === 1, 4000)
    await until(() => backend!.of("state").length >= 1)
    out.mockRestore()
    err.mockRestore()
  })

  it("the retry is unref'd so a waiting extension does not keep pi's process alive (the timers and the socket)", async () => {
    // a child process that loads the extension, starts a session with no backend and just ends: it must exit by itself
    const { spawnSync } = await import("node:child_process")
    const code = `
      process.env.HC_TERMINAL_ID = "t1"; process.env.HERDR_WEB_AGENTS_SOCKET = "/tmp/hw-nonexistent-${process.pid}.sock";
      const mod = await import(${JSON.stringify(path.resolve(import.meta.dirname, "../src/index.ts"))});
      const h = {}; mod.default({ on: (e, f) => (h[e] = f), getThinkingLevel: () => "off" });
      h.session_start({ reason: "startup" }, { isIdle: () => true, modelRegistry: { getAvailable: () => [] }, sessionManager: { getSessionFile: () => undefined, getSessionId: () => "x", getLeafId: () => null }, getContextUsage: () => undefined });
    `
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", code], { timeout: 8000, encoding: "utf8" })
    expect(r.error).toBeUndefined()
    expect(r.status).toBe(0)
    expect(r.stdout + r.stderr).toBe("")
  })
})

describe("reconnecting", () => {
  it("when the backend drops the connection the extension comes back and tells everything again", async () => {
    const { pi } = await setup()
    start(pi)
    await until(() => (backend!.conns[0]?.messages.length ?? 0) >= 3)
    backend!.conns[0]!.socket.destroy()
    await until(() => backend!.conns.length === 2, 4000)
    await until(() => backend!.conns[1]!.messages.length >= 3)
    expect(backend!.conns[1]!.messages.map((m) => m.type).slice(0, 3)).toEqual(["hello", "models", "state"])
  })

  it("after session_shutdown it closes the connection and does not come back", async () => {
    const { pi } = await setup()
    start(pi)
    await until(() => (backend!.conns[0]?.messages.length ?? 0) >= 3)
    pi.emit("session_shutdown")
    await until(() => backend!.conns[0]!.closed)
    await sleep(900)
    expect(backend!.conns).toHaveLength(1)
  })

  it("/new, /resume, /fork and /reload load the extension again: the new instance's hello arrives on a connection of its own", async () => {
    const { pi } = await setup()
    start(pi)
    await until(() => (backend!.conns[0]?.messages.length ?? 0) >= 3)
    pi.emit("session_shutdown")
    const second = new FakePi()
    pis.push(second)
    second.load()
    second.leaf = "other"
    start(second, "new")
    await until(() => backend!.conns.length === 2)
    await until(() => backend!.conns[1]!.messages.length >= 3)
    expect(backend!.conns[1]!.messages[0]).toMatchObject({ type: "hello", reason: "new" })
  })

  it("a `refused` reply ends the connection and the extension stays quiet for a long while", async () => {
    const { pi } = await setup()
    start(pi)
    await until(() => backend!.conns[0] !== undefined)
    backend!.conns[0]!.send({ v: 1, type: "refused", reason: "wire version" })
    await until(() => backend!.conns[0]!.closed)
    await sleep(1500)
    expect(backend!.conns).toHaveLength(1)
  })
})

describe("what it reports", () => {
  async function connected() {
    const s = await setup()
    start(s.pi)
    await until(() => backend!.of("state").length >= 1)
    return s
  }
  const reply = (text: string, extra: object[] = []) => ({ message: { role: "assistant", content: [...extra, { type: "text", text }] } })

  it("working and settled come with their state; the state is coalesced (many events in one tick, one message)", async () => {
    const { pi } = await connected()
    const before = backend!.of("state").length
    pi.emit("agent_start")
    pi.emit("turn_end")
    pi.emit("model_select")
    pi.emit("thinking_level_select")
    await until(() => backend!.of("state").length > before)
    await sleep(50)
    expect(backend!.of("state").length).toBe(before + 1)
    expect(backend!.of("state").at(-1)!.working).toBe(true)
    pi.emit("agent_settled")
    await until(() => backend!.of("state").at(-1)!.working === false)
  })

  it("reply updates are throttled to one message per 50 ms, carry the latest text, and the last one is not lost", async () => {
    const { pi } = await connected()
    pi.emit("agent_start")
    pi.emit("message_start", { message: { role: "assistant", content: [] } })
    for (let i = 1; i <= 300; i++) pi.emit("message_update", reply("w".repeat(i)))
    await sleep(150)
    const replies = backend!.of("reply")
    expect(replies.length).toBeLessThanOrEqual(3)
    expect(replies.at(-1)!.blocks).toEqual([{ kind: "text", text: "w".repeat(300) }])
  })

  it("thinking and text blocks are kept apart, in order, and empty ones are left out", async () => {
    const { pi } = await connected()
    pi.emit("message_start", { message: { role: "assistant", content: [] } })
    pi.emit("message_update", { message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "" }, { type: "text", text: "yes" }, { type: "toolCall", id: "c" }] } })
    await until(() => backend!.of("reply").length >= 1)
    expect(backend!.of("reply")[0]!.blocks).toEqual([{ kind: "thinking", text: "hmm" }, { kind: "text", text: "yes" }])
  })

  it("when the assistant message ends, a reply still waiting for its turn is dropped, and `entries` follows with replyDone and the leaf once pi has written", async () => {
    const { pi } = await connected()
    pi.emit("message_start", { message: { role: "assistant", content: [] } })
    pi.emit("message_update", reply("first")) // sent at once
    pi.emit("message_update", reply("first, then more")) // held back by the 50 ms throttle
    pi.leaf = "a-final"
    pi.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "first, then more" }] } })
    await until(() => backend!.of("entries").length === 1)
    await sleep(150)
    expect(backend!.of("reply").map((r) => r.blocks[0]!.text)).toEqual(["first"])
    expect(backend!.of("entries")[0]).toMatchObject({ leafId: "a-final", replyDone: true })
    // the hint goes out after pi's own handlers ran: pi appends to its file right after the event
    expect(backend!.all.map((m) => m.type).lastIndexOf("entries")).toBeGreaterThan(backend!.all.map((m) => m.type).indexOf("hello"))
  })

  it("a user message or tool result ending sends entries with replyDone false", async () => {
    const { pi } = await connected()
    pi.emit("message_end", { message: { role: "user", content: [{ type: "text", text: "hi" }] } })
    await until(() => backend!.of("entries").length === 1)
    expect(backend!.of("entries")[0]!.replyDone).toBe(false)
  })

  it("tools: start carries the main argument from the call's args, end the call id and an error flag", async () => {
    const { pi } = await connected()
    pi.emit("tool_execution_start", { toolCallId: "c1", toolName: "bash", args: { command: "node scripts/import.js exports/2026-03.csv\n\n# next" } })
    pi.emit("tool_execution_end", { toolCallId: "c1", toolName: "bash", isError: true })
    await until(() => backend!.of("tool").length === 2)
    expect(backend!.of("tool")).toMatchObject([{ phase: "start", callId: "c1", name: "bash", argument: "node scripts/import.js exports/2026-03.csv" }, { phase: "end", callId: "c1", isError: true }])
  })

  it("a tool start without args sends no argument, so an old rule is not mistaken for one", async () => {
    const { pi } = await connected()
    pi.emit("tool_execution_start", { toolCallId: "c2", toolName: "read" })
    await until(() => backend!.of("tool").length === 1)
    expect(backend!.of("tool")[0]).toMatchObject({ phase: "start", callId: "c2" })
    expect(backend!.of("tool")[0]!.argument).toBeUndefined()
  })

  it("a message typed while the agent works is pending as steer or follow-up, and leaves the queue when pi takes it", async () => {
    const { pi } = await connected()
    pi.emit("agent_start")
    pi.emit("input", { text: "also do X", streamingBehavior: "steer", source: "interactive" })
    pi.emit("input", { text: "later Y", streamingBehavior: "followUp", source: "interactive" })
    pi.emit("input", { text: "idle typed", source: "interactive" }) // not queued: nothing pending
    await until(() => backend!.of("state").at(-1)!.pending.length === 2)
    expect(backend!.of("state").at(-1)!.pending.map((p) => [p.text, p.mode])).toEqual([["also do X", "steer"], ["later Y", "followUp"]])
    pi.emit("message_start", { message: { role: "user", content: [{ type: "text", text: "also do X" }] } })
    await until(() => backend!.of("state").at(-1)!.pending.length === 1)
    expect(backend!.of("state").at(-1)!.pending[0]!.text).toBe("later Y")
    pi.emit("agent_settled")
    await until(() => backend!.of("state").at(-1)!.pending.length === 0)
  })

  it("two queued messages with the same text leave one at a time", async () => {
    const { pi } = await connected()
    pi.emit("agent_start")
    pi.emit("input", { text: "again", streamingBehavior: "steer" })
    pi.emit("input", { text: "again", streamingBehavior: "steer" })
    await until(() => backend!.of("state").at(-1)!.pending.length === 2)
    pi.emit("message_start", { message: { role: "user", content: "again" } })
    await until(() => backend!.of("state").at(-1)!.pending.length === 1)
  })

  it("a failed compaction becomes a notice with pi's words", async () => {
    const { pi } = await connected()
    pi.emit("session_compact_failed", { errorMessage: "Nothing to compact (session too small)" })
    await until(() => backend!.of("notice").length === 1)
    expect(backend!.of("notice")[0]).toMatchObject({ level: "error", text: "Nothing to compact (session too small)" })
  })

  it("a compaction, a tree move and a session rename each lead to a read of the file or the state", async () => {
    const { pi } = await connected()
    pi.emit("session_compact", {})
    await until(() => backend!.of("entries").length === 1)
    pi.leaf = "moved"
    pi.emit("session_tree", { newLeafId: "moved" })
    await until(() => backend!.of("entries").length === 2)
    expect(backend!.of("entries")[1]).toMatchObject({ leafId: "moved", replyDone: false })
    pi.sessionName = "renamed"
    pi.emit("session_info_changed", {})
    await until(() => backend!.of("state").at(-1)!.name === "renamed")
  })

  it("the model and effort in the state follow pi", async () => {
    const { pi } = await connected()
    pi.model = THINKER
    pi.thinking = "high"
    pi.emit("model_select", {})
    await until(() => backend!.of("state").at(-1)!.model?.id === "think")
    expect(backend!.of("state").at(-1)).toMatchObject({ effort: "high", efforts: ["off", "low", "medium", "high", "xhigh"] })
  })
})

describe("actions", () => {
  async function connected() {
    const s = await setup()
    start(s.pi)
    await until(() => backend!.of("state").length >= 1)
    const act = async (a: Record<string, unknown>) => {
      const id = `x${Math.random()}`
      backend!.conns[0]!.send({ v: 1, type: "action", id, ...a })
      await until(() => backend!.of("result").some((r) => r.id === id))
      return backend!.of("result").find((r) => r.id === id)!
    }
    return { ...s, act }
  }

  it("send: idle sends plainly, working sends as a steer", async () => {
    const { pi, act } = await connected()
    expect(await act({ op: "send", text: "hello" })).toMatchObject({ ok: true })
    pi.idle = false
    expect(await act({ op: "send", text: "more" })).toMatchObject({ ok: true })
    expect(pi.sent).toEqual([{ content: "hello", options: undefined }, { content: "more", options: { deliverAs: "steer" } }])
  })

  it("a message with characters of several bytes arrives whole even when the socket splits it in the middle of one", async () => {
    const { pi } = await connected()
    const text = "héllo wörld — 日本語 🙂 ".repeat(50)
    const line = Buffer.from(JSON.stringify({ v: 1, type: "action", id: "u1", op: "send", text }) + "\n")
    const at = line.indexOf(Buffer.from("日")) + 1 // inside the three bytes of 日
    const socket = backend!.conns[0]!.socket
    socket.write(line.subarray(0, at))
    await sleep(50)
    socket.write(line.subarray(at))
    await until(() => backend!.of("result").some((r) => r.id === "u1"))
    expect(pi.sent).toEqual([{ content: text, options: undefined }])
  })

  it("send of nothing is an error with a sentence, and pi is not called", async () => {
    const { pi, act } = await connected()
    expect(await act({ op: "send", text: "  " })).toMatchObject({ ok: false, error: "There is nothing to send." })
    expect(pi.sent).toEqual([])
  })

  it("stop aborts", async () => {
    const { pi, act } = await connected()
    expect(await act({ op: "stop" })).toMatchObject({ ok: true })
    expect(pi.aborted).toBe(1)
  })

  it("set_model: a known model is set and the new state follows; unknown and keyless ones answer with a sentence", async () => {
    const { pi, act } = await connected()
    expect(await act({ op: "set_model", model: "or/think" })).toMatchObject({ ok: true })
    await until(() => backend!.of("state").at(-1)!.model?.id === "think")
    expect(await act({ op: "set_model", model: "or/ghost" })).toMatchObject({ ok: false, error: expect.stringContaining("does not know the model") })
    expect(await act({ op: "set_model", model: "ghost" })).toMatchObject({ ok: false })
    pi.setModelResult = false
    expect(await act({ op: "set_model", model: "llama-swap/local" })).toMatchObject({ ok: false, error: expect.stringContaining("No API key") })
  })

  it("set_effort: a level the model takes is set and reported back; one it does not is refused with the list", async () => {
    const { pi, act } = await connected()
    pi.model = THINKER
    expect(await act({ op: "set_effort", effort: "high" })).toMatchObject({ ok: true })
    expect(pi.thinking).toBe("high")
    await until(() => backend!.of("state").at(-1)!.effort === "high")
    const bad = await act({ op: "set_effort", effort: "minimal" })
    expect(bad).toMatchObject({ ok: false })
    expect((bad as { error: string }).error).toContain("takes: off, low, medium, high, xhigh")
    expect(pi.thinking).toBe("high")
    pi.model = LOCAL
    expect(await act({ op: "set_effort", effort: "high" })).toMatchObject({ ok: false })
  })

  it("clear_input empties pi's input box when there is one, and is a no-op without a UI", async () => {
    const { pi, act } = await connected()
    expect(await act({ op: "clear_input" })).toMatchObject({ ok: true })
    expect(pi.editorTexts).toEqual([""])
    pi.hasUI = false
    expect(await act({ op: "clear_input" })).toMatchObject({ ok: true })
    expect(pi.editorTexts).toEqual([""])
  })

  it("an action it does not know, and a malformed one, do not break the connection", async () => {
    const { act } = await connected()
    expect(await act({ op: "format_disk" })).toMatchObject({ ok: false, error: "pi does not know that action." })
    backend!.conns[0]!.send("not json\n")
    backend!.conns[0]!.send({ v: 1, type: "action" }) // no id
    backend!.conns[0]!.send({ v: 7, type: "action", id: "z", op: "stop" }) // wrong version: ignored
    backend!.conns[0]!.send({ v: 1, type: "welcome" })
    expect(await act({ op: "stop" })).toMatchObject({ ok: true })
  })
})

describe("never into pi", () => {
  it("when pi's own API throws inside a handler, the handler swallows it", async () => {
    const { pi } = await setup()
    pi.throwing = true
    expect(() => start(pi)).not.toThrow()
    expect(() => pi.emit("agent_start")).not.toThrow()
    expect(() => pi.emit("message_end", { message: { role: "assistant" } })).not.toThrow()
    expect(() => pi.emit("input", null as never)).not.toThrow()
    expect(() => pi.emit("message_update", { message: { role: "assistant", content: "not a list" } })).not.toThrow()
    await sleep(100)
  })

  it("events with missing fields do not throw either", async () => {
    const { pi } = await setup()
    start(pi)
    for (const name of [...pi.handlers.keys()]) expect(() => pi.emit(name, {})).not.toThrow()
    await sleep(50)
  })

  it("a backend that floods it with junk does not disturb it", async () => {
    const { pi } = await setup()
    start(pi)
    await until(() => backend!.of("state").length >= 1)
    for (let i = 0; i < 200; i++) backend!.conns[0]!.send("}{\n")
    backend!.conns[0]!.send({ v: 1, type: "action", id: "ok", op: "stop" })
    await until(() => backend!.of("result").length === 1)
  })
})

describe("replaying what a live pi did", () => {
  const cases = ["00-startup", "b-tools", "c-escape", "d-steer", "e-compact", "e0-compact-too-small", "f-tree", "g-new", "h-model-thinking", "i-reload"]

  it.each(cases)("%s: every message it sends is valid, in the order the protocol needs, and it ends settled", async (name) => {
    const { pi } = await setup()
    const lines = fs.readFileSync(path.join(EVENTS, `events-${name}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { name: string; payload: Record<string, unknown> })
    start(pi, "startup")
    await until(() => (backend!.conns[0]?.messages.length ?? 0) >= 3)
    let n = 0
    for (const { name: ev, payload } of lines) {
      if (ev === "session_start" || ev === "session_shutdown") continue
      if (ev === "agent_start") pi.idle = false
      if (ev === "agent_settled") pi.idle = true
      pi.leaf = `leaf-${++n}`
      pi.emit(ev, payload)
      if (n % 10 === 0) await sleep(5)
    }
    await sleep(150)
    const conn = backend!.conns[0]!
    expect(conn.invalid).toEqual([])
    expect(conn.messages[0]!.type).toBe("hello")
    expect(conn.messages.filter((m) => m.type === "hello")).toHaveLength(1)
    const states = backend!.of("state")
    expect(states.length).toBeGreaterThan(0)
    const settled = lines.some((l) => l.name === "agent_settled")
    if (settled) expect(states.at(-1)!.working).toBe(false)
    const ended = lines.filter((l) => l.name === "message_end" && (l.payload.message as { role?: string })?.role === "assistant").length
    if (ended > 0) expect(backend!.of("entries").some((e) => e.replyDone)).toBe(true)
  })
})

describe("the extension file", () => {
  it("imports only Node built-ins (it must install on its own)", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "../src/index.ts"), "utf8")
    const imports = [...source.matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1])
    expect(imports.length).toBeGreaterThan(0)
    for (const i of imports) expect(i, i).toMatch(/^node:/)
  })

  it("writes no files: it never opens a path for writing", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "../src/index.ts"), "utf8")
    expect(source).not.toMatch(/writeFile|appendFile|createWriteStream|mkdirSync|unlink/)
  })

  it("has the pi manifest that points at its entry", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../package.json"), "utf8"))
    expect(pkg.pi.extensions).toEqual(["./src/index.ts"])
    expect(fs.existsSync(path.join(import.meta.dirname, "..", pkg.pi.extensions[0]))).toBe(true)
  })
})
