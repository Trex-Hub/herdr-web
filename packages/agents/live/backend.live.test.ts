// The whole chain, for real: a pi started by a scratch core, with pi-live loaded (the pinned devDependency), found by the
// real backend (apps/backend, built) in a pi-live folder inside the scratch root, read through the backend's main socket and
// acted on over its HTTP chat operations, as the web app will. Run with `pnpm test:agents` from the repo root.
// Needs `hc`, `pi` and the local model.
//
// Nothing here touches the real core or Devendra's pis: `hc` and the backend run under scripts/scratch-env.mjs with a root of their
// own under /tmp, and the backend gets that root's pi-live folder explicitly (PI_LIVE_DIR), never ~/.pi/agent/live; the real core's
// pid and pi's own settings and extensions are checked before and after; the backend is stopped by the pid this file started.
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import WebSocket from "ws"
import type { Row, ThreadChange, ThreadSnapshot } from "../src/rows.js"
import { MODEL_WAIT_MS, pingExtension as pingExtension_, corePids, fingerprint, LLAMA, LOCAL_MODEL, piLive, repo, scratch, sendUntilStreaming, sleep, strayedLiveFiles, strayedSessions, TurnClock, until } from "./support.js"

const { root, env, work, sessions, hc, stopCore } = scratch("hw-bk-live-")
const liveDir = env.PI_LIVE_DIR!
const PORT = 18440
const PASSPHRASE = "live test passphrase"
const ORIGIN = "http://localhost:3000"
const base = `http://127.0.0.1:${PORT}`
const clock = new TurnClock()
let failed = false

// ---- the backend, as a child process ------------------------------------------------------

let backend: ChildProcess | null = null
const backendLog: string[] = []

async function startBackend(): Promise<void> {
  const child = spawn(process.execPath, [path.join(repo, "apps/backend/dist/index.js")], {
    env: { ...env, PI_LIVE_DIR: liveDir, HW_HERDR_APP_SHARED: path.join(root, "herdr-app-shared.json"), PORT: String(PORT), HERDR_WEB_PASSPHRASE: PASSPHRASE, HERDR_WEB_ORIGINS: ORIGIN },
    stdio: ["ignore", "pipe", "pipe"],
  })
  backend = child
  const from = backendLog.length
  for (const stream of [child.stdout!, child.stderr!]) stream.on("data", (d: Buffer) => backendLog.push(...String(d).split("\n").filter(Boolean)))
  await until("the backend", () => (child.exitCode === null ? backendLog.slice(from).some((l) => /listening/i.test(l)) || undefined : (() => { throw new Error(`backend exited: ${backendLog.join("\n")}`) })()), 20_000)
}
async function stopBackend(): Promise<void> {
  const child = backend
  backend = null
  if (!child || child.exitCode !== null) return
  child.kill("SIGTERM")
  await new Promise<void>((r) => child.once("exit", () => r()))
}

async function signIn(): Promise<string> {
  const res = await fetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify({ passphrase: PASSPHRASE }) })
  expect(res.status).toBe(200)
  return res.headers.get("set-cookie")!.split(";")[0]!
}

async function post(cookie: string, name: string, body: unknown): Promise<{ status: number; body: any; ms: number }> {
  const t0 = Date.now()
  const said = (body as { text?: unknown }).text
  if (name === "send" && typeof said === "string" && !said.startsWith("/")) clock.start(said.slice(0, 40))
  const res = await fetch(`${base}/api/chat/${name}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie }, body: JSON.stringify(body) })
  if (name === "send" && typeof said === "string" && !said.startsWith("/") && !res.ok) clock.cancel()
  return { status: res.status, body: await res.json(), ms: Date.now() - t0 }
}

// ---- a browser: the main socket and the thread as the app would hold it ---------------------

interface Frame {
  /** Row ids and texts, and the live reply text, after each message: what the screen would show. */
  rows: Row[]
  reply: string | null
  at: number
  kind: string
}
class Thread {
  snapshot: ThreadSnapshot | null = null
  rows: Row[] = []
  live: ThreadSnapshot["live"] | null = null
  capabilities: ThreadSnapshot["capabilities"] | null = null
  seq = 0
  unavailable: string | null = null
  resets = 0
  /** How many times the chat was said to be unavailable: a /new or a /reload must not be one. */
  unavailables = 0
  gaps: string[] = []
  frames: Frame[] = []

  apply(m: { type: string; snapshot?: ThreadSnapshot; change?: ThreadChange; reason?: string }): void {
    if (m.type === "chat.unavailable") {
      this.unavailable = m.reason!
      this.unavailables++
      return
    }
    this.unavailable = null
    const reset = (s: ThreadSnapshot) => {
      this.snapshot = s
      this.rows = [...s.rows]
      this.live = s.live
      this.capabilities = s.capabilities
      this.seq = s.seq
    }
    if (m.type === "chat.snapshot") reset(m.snapshot!)
    else if (m.change!.type === "reset") {
      this.resets++
      reset(m.change!.snapshot)
    } else {
      const c = m.change!
      if (c.seq !== this.seq + 1) this.gaps.push(`seq ${c.seq} after ${this.seq}`)
      this.seq = c.seq
      for (const r of c.rows ?? []) {
        const i = this.rows.findIndex((x) => x.id === r.id)
        if (i >= 0) this.rows[i] = r
        else this.rows.push(r)
      }
      if (c.live) this.live = c.live
      if (c.capabilities) this.capabilities = c.capabilities
    }
    const reply = this.live?.reply ? this.live.reply.blocks.filter((b) => b.kind === "text").map((b) => b.text).join("") : null
    this.frames.push({ rows: [...this.rows], reply, at: Date.now(), kind: m.type })
    if (this.live) clock.observe(this.live)
  }
  get working(): boolean {
    return this.live?.working ?? false
  }
  get reply(): string | null {
    return this.frames.at(-1)?.reply ?? null
  }
  /** Tools running now: rows still running, and the live tools no row holds yet. */
  get running(): number {
    return this.rows.filter((x) => x.kind === "tool" && x.status === "running").length + (this.live?.tools.length ?? 0)
  }
}

/** A user row with our text, then an assistant row after it, and the agent settled: a finished turn, whatever the model said. */
function finishedTurn(thread: Thread, text: string): boolean {
  const kinds = thread.rows.map((x) => x.kind)
  const user = thread.rows.findIndex((x) => x.kind === "user" && x.text === text)
  return user >= 0 && !thread.working && kinds.slice(user + 1).includes("assistant")
}

class Browser {
  readonly messages: any[] = []
  readonly threads = new Map<string, Thread>()
  chatFlags = new Map<string, boolean>()
  closed = false
  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const m = JSON.parse(String(data))
      this.messages.push(m)
      if (m.type === "snapshot") for (const t of m.terminals) this.chatFlags.set(t.address, t.chat)
      if (m.type === "terminal") this.chatFlags.set(m.terminal.address, m.terminal.chat)
      if (m.type === "terminal.removed") this.chatFlags.delete(m.address)
      if (typeof m.type === "string" && m.type.startsWith("chat.")) {
        let t = this.threads.get(m.terminal)
        if (!t) this.threads.set(m.terminal, (t = new Thread()))
        t.apply(m)
      }
    })
    ws.on("close", () => (this.closed = true))
  }
  static open(cookie: string): Promise<Browser> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/ws`, { headers: { Origin: ORIGIN, Cookie: cookie } })
      const b = new Browser(ws)
      ws.on("open", () => resolve(b))
      ws.on("error", reject)
      ws.on("unexpected-response", (_r, res) => reject(new Error(`refused: ${res.statusCode}`)))
    })
  }
  subscribe(terminal: string): Thread {
    this.threads.delete(terminal)
    this.ws.send(JSON.stringify({ type: "chat.subscribe", terminal }))
    const t = new Thread()
    this.threads.set(terminal, t)
    return t
  }
  thread(terminal: string): Thread {
    return this.threads.get(terminal)!
  }
  close(): void {
    this.ws.close()
  }
}

// ---- pi ---------------------------------------------------------------------------------------

function startPi(name: string, extra: string[] = []): string {
  // The folder is the scratch root's, which the core's terminals inherit; it is said again here so a pi never writes elsewhere.
  hc("run", "--bg", "--name", name, "--cwd", work, "--", "env", `PI_LIVE_DIR=${liveDir}`, "pi", "-ne", "-e", LLAMA, "-e", piLive, "-e", pingExtension, ...extra, "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--session-dir", sessions, "--model", LOCAL_MODEL, "--thinking", "off")
  const ls = JSON.parse(hc("ls", "--json")) as { terminals: { address: string; name: string | null }[] }
  const t = ls.terminals.find((x) => x.name === name)
  if (!t) throw new Error(`terminal ${name} not found`)
  return t.address
}

const { extension: pingExtension, file: pingFile } = pingExtension_(root)

const startedAt = Date.now()
let fingerprintBefore = ""
let corePidsBefore: number[] = []
let cookie = ""
let browser: Browser
let terminal = ""
let thread: Thread
const findings: string[] = []

beforeAll(async () => {
  fingerprintBefore = fingerprint()
  corePidsBefore = corePids()
  hc("server", "start")
  await startBackend()
  cookie = await signIn()
  browser = await Browser.open(cookie)
  await until("the first snapshot", () => browser.messages.some((m) => m.type === "snapshot"))
})

// A failed test keeps the scratch root (core stopped, folder left) and says where it is.
afterEach((ctx) => {
  if (ctx.task.result?.state === "fail") failed = true
})

afterAll(async () => {
  browser?.close()
  await stopBackend()
  clock.print()
  stopCore(!failed)
  console.log(["", "find-outs and numbers:", ...findings.map((f) => `  - ${f}`)].join("\n"))
})

describe("a real pi through the real backend", () => {
  // Nothing may be written to pi while a model other than the local one is selected (pi's list holds paid providers).
  beforeEach(() => {
    const current = thread?.capabilities?.models?.current
    if (current !== undefined) expect(current, "pi is on the local model before every test").toBe(LOCAL_MODEL)
  })

  it("is refused without the sign-in and from a foreign origin, and offers no chat before pi is there", async () => {
    await expect(new Promise((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${PORT}/api/ws`, { headers: { Origin: ORIGIN } }); w.on("open", res); w.on("error", rej); w.on("unexpected-response", (_r, r) => rej(new Error(String(r.statusCode)))) })).rejects.toThrow("401")
    await expect(Browser.open(cookie.replace(/.$/, "x"))).rejects.toThrow("401")
    const bad = await fetch(`${base}/api/chat/send`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://evil.example", Cookie: cookie }, body: JSON.stringify({ terminal: "t1", text: "x" }) })
    expect(bad.status).toBe(403)
    expect([...browser.chatFlags.values()].some(Boolean)).toBe(false)
  })

  it("pi's terminal gets chat: true on the main socket, and a subscription starts with an empty thread of pi in that folder", async () => {
    terminal = startPi("bk-agent")
    await until("chat flag", () => browser.chatFlags.get(terminal) === true || undefined, 90_000)
    thread = browser.subscribe(terminal)
    await until("the snapshot", () => thread.snapshot || undefined)
    expect(thread.snapshot!.identity).toMatchObject({ agent: "pi", terminalId: terminal, cwd: fs.realpathSync(work) })
    expect(thread.rows).toEqual([])
    expect(thread.capabilities!.models?.current).toBe(LOCAL_MODEL)
  })

  it("a nested `pi -p` that carries this terminal's id (a sub-agent started inside the pi) is not linked: no reset, no refusal, the chat stays", async () => {
    const resets = thread.resets
    const logFrom = backendLog.length
    // `env` sets the id after core has set its own, as a sub-agent started inside the pi in `terminal` would have it.
    hc("run", "--bg", "--name", "bk-nested", "--cwd", work, "--", "env", `HC_TERMINAL_ID=${terminal}`, `PI_LIVE_DIR=${liveDir}`, "pi", "-ne", "-e", LLAMA, "-e", piLive, "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--session-dir", sessions, "--model", LOCAL_MODEL, "--thinking", "off", "-p", "Reply with one short sentence. Do not use any tool.")
    const ended = await until("the nested pi to end", () => {
      const ls = JSON.parse(hc("ls", "--all", "--json")) as { terminals: { name: string | null; state: string; exit_code?: number | null }[] }
      const t = ls.terminals.find((x) => x.name === "bk-nested")
      return t?.state === "finished" ? t : undefined
    }, MODEL_WAIT_MS)
    expect(ended.exit_code, "the nested pi ran to the end").toBe(0)
    await sleep(1500) // a connection would have been refused (logged) or would have replaced the holder (a reset) well within this
    expect(thread.resets).toBe(resets)
    expect(thread.unavailable).toBeNull()
    expect(browser.chatFlags.get(terminal)).toBe(true)
    expect(backendLog.slice(logFrom).filter((l) => /chat: refused a pi in terminal|chat: ignored a pi/.test(l))).toEqual([])
  })

  it("send: working, live text in pieces, the finished row replaces it (never both), settled, seq without gaps", async () => {
    const text = "Count from 1 to 40, one number per line, and say nothing else. Do not use any tool."
    const r = await post(cookie, "send", { terminal, text })
    expect(r).toMatchObject({ status: 200, body: { via: "agent" } })
    await until("working", () => thread.working || undefined, 30_000)
    await until("settled", () => (!thread.working && thread.rows.some((x) => x.kind === "assistant")) || undefined, MODEL_WAIT_MS)
    const pieces = new Set(thread.frames.map((f) => f.reply).filter(Boolean))
    expect(pieces.size).toBeGreaterThan(1)
    for (const f of thread.frames) {
      const done = f.rows.filter((x) => x.kind === "assistant").map((x) => (x.kind === "assistant" ? x.text.trim() : ""))
      if (f.reply && done.includes(f.reply.trim())) throw new Error("the finished reply was on screen both live and as a row")
    }
    const user = thread.rows.find((x) => x.kind === "user")
    expect(user).toMatchObject({ kind: "user", text })
    const kinds = thread.rows.map((x) => x.kind)
    expect(kinds.indexOf("assistant"), "an assistant row after the user row").toBeGreaterThan(kinds.indexOf("user"))
    expect(new Set(thread.rows.map((x) => x.id)).size).toBe(thread.rows.length)
    expect(thread.gaps).toEqual([])
    const assistant = thread.rows.find((x) => x.kind === "assistant")
    expect(assistant).toMatchObject({ kind: "assistant", model: LOCAL_MODEL, effort: "off" })
  })

  it("a tool call: a row running, then ok with its result", async () => {
    const before = thread.rows.length
    await post(cookie, "send", { terminal, text: "Use the bash tool to run exactly: echo hw-bk-$((6*7))  Then say done." })
    const tool = await until("the tool row", () => thread.rows.slice(before).find((x) => x.kind === "tool"), MODEL_WAIT_MS)
    await until("settled", () => !thread.working || undefined, MODEL_WAIT_MS)
    const done = thread.rows.find((x) => x.id === tool.id)
    expect(done).toMatchObject({ kind: "tool", status: "ok", name: "bash" })
    expect(done?.kind === "tool" && done.result?.text).toContain("hw-bk-42")
    expect(thread.frames.some((f) => f.rows.some((x) => x.id === tool.id && x.kind === "tool" && x.status === "running") || false) || thread.frames.some((f) => f.kind === "chat.change")).toBe(true)
    // the whole result operation answers for a row
    const whole = await post(cookie, "result", { terminal, row: tool.id })
    expect(whole).toMatchObject({ status: 200 })
    expect(whole.body.text).toContain("hw-bk-42")
  })

  it("stop: cut at the first live text or running tool (a short prompt would end before it), the agent settles and says Stopped", async () => {
    // A model may reach for a tool however the prompt is worded: the stop has to settle the agent either way.
    await sendUntilStreaming(
      () => post(cookie, "send", { terminal, text: "Write a very long story, at least 3000 words, about a lighthouse. Do not use any tool." }),
      { working: () => thread.working, streaming: () => (thread.reply?.length ?? 0) > 10 || thread.running > 0 },
    )
    const t0 = Date.now()
    expect(await post(cookie, "stop", { terminal })).toMatchObject({ status: 200, body: { ok: true } })
    await until("settled", () => !thread.working || undefined, 30_000)
    findings.push(`stop: settled ${Date.now() - t0} ms after the stop request`)
    expect(thread.reply).toBeNull()
    expect(thread.running, "no tool left running").toBe(0)
    expect(thread.rows.some((x) => x.kind === "notice" && /stopped/i.test(x.text))).toBe(true)
  })

  it("model and effort over HTTP: a refused effort is a sentence; a reasoning model's change is reported and shows on the next reply; the local model again offers only off", async () => {
    const models = thread.capabilities!.models!.list
    const reasoning = models.find((m) => m.reasoning && m.id !== LOCAL_MODEL)
    expect(reasoning, "a reasoning model in pi's list").toBeDefined()
    const rows = (await post(cookie, "effort", { terminal, effort: "not-a-level" }))
    expect(rows.status).toBe(409)
    expect(typeof rows.body.error).toBe("string")
    try {
      expect(await post(cookie, "model", { terminal, model: reasoning!.id })).toMatchObject({ status: 200 })
      await until("model", () => thread.capabilities?.models?.current === reasoning!.id || undefined, 15_000)
      const levels = thread.capabilities!.efforts!.list
      expect(levels.length).toBeGreaterThan(1)
      const pick = levels.find((l) => l !== "off" && l !== thread.capabilities!.efforts!.current)!
      expect(await post(cookie, "effort", { terminal, effort: pick })).toMatchObject({ status: 200 })
      await until("effort", () => thread.capabilities?.efforts?.current === pick || undefined, 15_000)
    } finally {
      // the local model again, whatever happened above
      await post(cookie, "model", { terminal, model: LOCAL_MODEL })
      await until("local again", () => thread.capabilities?.models?.current === LOCAL_MODEL || undefined, 15_000)
    }
    expect(await post(cookie, "model", { terminal, model: "no/such-model" })).toMatchObject({ status: 409 })
    expect(thread.capabilities?.efforts?.list).toEqual(["off"])
    // the model change is a row of the thread (not asked for until a message is written to the session file)
    const text = "Say hello in one short sentence (after the model switch)."
    await post(cookie, "send", { terminal, text })
    await until("a finished turn", () => finishedTurn(thread, text) || undefined, MODEL_WAIT_MS)
    findings.push(`model rows in the thread after switching and back: ${thread.rows.filter((x) => x.kind === "model").map((x) => (x.kind === "model" ? x.model : "")).join(" -> ") || "none"}`)
  })

  it("older: a page before a row; a row that is not there is a sentence", async () => {
    const first = thread.rows[0]!
    const page = await post(cookie, "older", { terminal, before: first.id })
    expect(page.status).toBe(200)
    expect(page.body).toEqual({ rows: [], hasMore: false })
    expect((await post(cookie, "older", { terminal, before: "nope" })).status).toBe(409)
  })

  it("`/compact` is pi-live's action, not typed: via agent, nothing typed into the terminal, pi compacts", async () => {
    await until("pi idle", () => !thread.working || undefined, 60_000)
    const t0 = Date.now()
    const r = await post(cookie, "send", { terminal, text: "/compact keep it short" })
    expect(r).toMatchObject({ status: 200, body: { via: "agent" } })
    findings.push(`/compact: POST (compact action) answered in ${r.ms} ms`)
    await sleep(1000)
    expect(hc("read", terminal), "the command was not typed into pi's input box").not.toContain("/compact keep it short")
    await until("a compaction row or pi idle again", () => thread.rows.some((x) => x.kind === "compaction") || (Date.now() - t0 > 20_000 && !thread.working) || undefined, 180_000)
    expect(thread.rows.some((x) => x.kind === "user" && x.text.startsWith("/"))).toBe(false)
  })

  it("`/name <name>` is pi-live's action: via agent, nothing typed, and pi writes the name to its session file", async () => {
    const r = await post(cookie, "send", { terminal, text: "/name hw live name" })
    expect(r).toMatchObject({ status: 200, body: { via: "agent" } })
    const named = () => fs.readdirSync(sessions).some((f) => f.endsWith(".jsonl") && fs.readFileSync(path.join(sessions, f), "utf8").includes('"name":"hw live name"'))
    await until("the name in a session file", () => named() || undefined, 15_000)
    expect(hc("read", terminal)).not.toContain("/name hw live name")
  })

  it("an extension's command from the composer runs in pi: via agent, and the command's file has its argument", async () => {
    const r = await post(cookie, "send", { terminal, text: "/hw-ping from the composer" })
    expect(r).toMatchObject({ status: 200, body: { via: "agent" } })
    await until("the command to run", () => (fs.existsSync(pingFile) ? fs.readFileSync(pingFile, "utf8") : undefined), 30_000)
    expect(fs.readFileSync(pingFile, "utf8")).toBe("from the composer")
  })

  it("`/reload` through the `/` rule: one reset on the same session, and never an unavailable", async () => {
    const resets = thread.resets
    const unavailables = thread.unavailables
    const sessionId = thread.snapshot!.identity.sessionId
    const rowsBefore = thread.rows.map((x) => x.id)
    const t0 = Date.now()
    expect(await post(cookie, "send", { terminal, text: "/reload" })).toMatchObject({ status: 200, body: { via: "terminal" } })
    await until("a reset", () => thread.resets > resets || undefined, 30_000)
    findings.push(`/reload: reset on the subscriber ${Date.now() - t0} ms after the request`)
    await sleep(1500) // a second reset, or an unavailable, would have come by now
    expect(thread.resets).toBe(resets + 1)
    expect(thread.unavailables, "pi-live's goodbye said reload: the chat is not unavailable in between").toBe(unavailables)
    expect(thread.snapshot!.identity.sessionId).toBe(sessionId)
    expect(thread.rows.map((x) => x.id).slice(0, rowsBefore.length)).toEqual(rowsBefore)
    expect(browser.chatFlags.get(terminal)).toBe(true)
    expect(thread.unavailable).toBeNull()
  })

  it("the backend restarting under a connected pi: the backend finds the pi again, a fresh socket sees the same thread", async () => {
    const rowsBefore = thread.rows.map((x) => x.id)
    await stopBackend()
    await until("the old socket to close", () => browser.closed || undefined, 10_000)
    await startBackend()
    cookie = await signIn() // the cookie survives (same passphrase), but a new login is the honest path
    browser = await Browser.open(cookie)
    const t0 = Date.now()
    await until("chat flag again", () => browser.chatFlags.get(terminal) === true || undefined, 60_000)
    findings.push(`backend restart: chat flag back ${Date.now() - t0} ms after the new socket opened`)
    thread = browser.subscribe(terminal)
    await until("snapshot", () => thread.snapshot || undefined)
    expect(thread.rows.map((x) => x.id)).toEqual(rowsBefore)
    // and a message still goes through
    const text = "Say hello in one short sentence (after the backend restart)."
    await post(cookie, "send", { terminal, text })
    await until("a finished turn", () => finishedTurn(thread, text) || undefined, MODEL_WAIT_MS)
  })

  it("`/new` through the `/` rule: one reset to an empty thread on another session, never an unavailable, and it works", async () => {
    const resets = thread.resets
    const unavailables = thread.unavailables
    const sessionId = thread.snapshot!.identity.sessionId
    await until("pi idle", () => !thread.working || undefined, 30_000)
    const t0 = Date.now()
    expect(await post(cookie, "send", { terminal, text: "/new" })).toMatchObject({ status: 200, body: { via: "terminal" } })
    await until("a reset", () => thread.resets > resets || undefined, 30_000)
    findings.push(`/new: reset on the subscriber ${Date.now() - t0} ms after the request`)
    await sleep(1500)
    expect(thread.resets).toBe(resets + 1)
    expect(thread.unavailables).toBe(unavailables)
    expect(thread.rows).toEqual([])
    expect(thread.snapshot!.identity.sessionId).not.toBe(sessionId)
    const text = "Say hello in one short sentence (after /new)."
    await post(cookie, "send", { terminal, text })
    await until("a finished turn", () => finishedTurn(thread, text) || undefined, MODEL_WAIT_MS)
    expect(thread.gaps).toEqual([])
  })

  it("an extension's command from the composer still runs after /new: the new session has the command too", async () => {
    fs.rmSync(pingFile, { force: true })
    const r = await post(cookie, "send", { terminal, text: "/hw-ping after new" })
    expect(r).toMatchObject({ status: 200, body: { via: "agent" } })
    await until("the command to run", () => (fs.existsSync(pingFile) ? fs.readFileSync(pingFile, "utf8") : undefined), 30_000)
    expect(fs.readFileSync(pingFile, "utf8")).toBe("after new")
  })

  it("`/quit` ends the chat at once: pi-live's goodbye says quit, subscribers are told, the flag goes", async () => {
    const quitter = startPi("bk-quit")
    await until("chat flag", () => browser.chatFlags.get(quitter) === true || undefined, 90_000)
    const t = browser.subscribe(quitter)
    await until("the snapshot", () => t.snapshot || undefined)
    const t0 = Date.now()
    expect(await post(cookie, "send", { terminal: quitter, text: "/quit" })).toMatchObject({ status: 200, body: { via: "terminal" } })
    await until("unavailable", () => t.unavailable || undefined, 20_000)
    findings.push(`/quit: unavailable ${Date.now() - t0} ms after the request`)
    expect(t.unavailable).toMatch(/ended|disconnected/)
    await until("flag off", () => browser.chatFlags.get(quitter) === false || undefined, 10_000)
  })

  it("the terminal ending (pi killed, no goodbye): subscribers are told, the flag goes", async () => {
    hc("keep", terminal, "--off")
    hc("kill", terminal)
    await until("unavailable", () => thread.unavailable || undefined, 20_000)
    expect(thread.unavailable).toMatch(/ended|disconnected/)
    await until("flag off", () => browser.chatFlags.get(terminal) === false || undefined, 10_000)
    expect((await post(cookie, "send", { terminal, text: "x" })).status).toBe(409)
  })

  it("left pi's settings, extensions and own sessions folder alone, and the real core running", () => {
    expect(fingerprint()).toBe(fingerprintBefore)
    expect(strayedLiveFiles(root), "no file of Devendra's own pis in ~/.pi/agent/live names the scratch root").toEqual([])
    expect(strayedSessions(root, startedAt)).toEqual([])
    expect(fs.readdirSync(sessions).filter((f) => f.endsWith(".jsonl")).length).toBeGreaterThan(0)
    const now = corePids()
    for (const pid of corePidsBefore) expect(now, `real core pid ${pid}`).toContain(pid)
    expect(backendLog.filter((l) => /error|exception|unhandled/i.test(l))).toEqual([])
  })
})

void sleep
