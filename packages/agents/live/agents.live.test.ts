// A real pi, started by a scratch core, with pi-live loaded (`-e`, from the pinned devDependency), and this package's client
// (connectPiLive) on the socket its session file names, found the way the backend finds it: a file in PI_LIVE_DIR, which the scratch
// environment points into the scratch root. Run with `pnpm test:agents` from the repo root. Needs `hc`, `pi` and the local model.
//
// It never touches the real core or Devendra's pis: every `hc` call runs under scripts/scratch-env.mjs with a root of its own under
// /tmp, and the real core's pid is checked before and after. It never writes pi's own configuration: settings.json and the extensions
// folder are checksummed before and after, no session of the test may land in pi's own sessions folder, and none of the files in
// ~/.pi/agent/live may name the scratch root.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { MODEL_WAIT_MS, sleep, assistantMessages, corePids, fingerprint, liveFiles, LLAMA, LOCAL_MODEL, piLive, scratch, sendUntilStreaming, strayedLiveFiles, strayedSessions, TurnClock, until } from "./support.js"
import { connectPiLive, NO_CONTROL, type PiLiveConnection, type PiLiveEnd, type PiLiveReady } from "../src/pi-live/connection.js"
import type { Row, ThreadChange, ThreadSnapshot } from "../src/rows.js"
import type { Thread } from "../src/thread.js"

const { root, env, work, sessions, hc, stopCore } = scratch("hw-ag-live-")
const liveDir = env.PI_LIVE_DIR!

// ---- the backend side: a client on every session file of a pi in a terminal --------------------

interface Seen {
  thread: Thread
  connection: PiLiveConnection
  ready: PiLiveReady
  /** Set when the connection ended: pi-live's goodbye said why. */
  end: PiLiveEnd | null
  /** The file this connection was made from. */
  sessionId: string
  startedAt: string | undefined
  snapshot: ThreadSnapshot
  changes: ThreadChange[]
  at: number
}
const seen: Seen[] = []
const clock = new TurnClock()
let failed = false
const logs: string[] = []
const linked = new Set<string>()
let watching: ReturnType<typeof setInterval> | undefined
/** While set, no client connects: for the test of a pi that nobody is connected to. */
let paused = false

/** Connect to each session file of a pi that runs in a terminal (`mode` tui and a `terminal`), once per file. */
function follow(): void {
  if (paused) return
  for (const f of liveFiles(liveDir)) {
    if (f.mode !== "tui" || !f.terminal) continue
    const key = `${f.sessionId}|${f.pid}|${f.startedAt}|${f.socketPath}`
    if (linked.has(key)) continue
    linked.add(key)
    const connection = connectPiLive(f.socketPath, { terminalId: f.terminal, log: (l) => logs.push(l) })
    connection.ready.then(
      (ready) => {
        const snapshot = ready.thread.snapshot()
        const entry: Seen = { thread: ready.thread, connection, ready, end: null, sessionId: f.sessionId, startedAt: f.startedAt, snapshot, changes: [], at: Date.now() }
        ready.thread.subscribe((c) => {
          entry.changes.push(c) // same tick as the snapshot: nothing is lost
          clock.observe(c.type === "reset" ? c.snapshot.live : c.live ?? { working: false })
        })
        void connection.closed.then((end) => (entry.end = end))
        seen.push(entry)
      },
      (e) => logs.push(`connection to ${f.socketPath} failed: ${String(e)}`),
    )
  }
}

function current(s: Seen): { rows: Row[]; reply: string | null; working: boolean; efforts: string | null; model: string | null; pending: number; running: number } {
  let rows = [...s.snapshot.rows]
  let live = s.snapshot.live
  let caps = s.snapshot.capabilities
  for (const c of s.changes) {
    if (c.type === "reset") {
      rows = [...c.snapshot.rows]
      live = c.snapshot.live
      caps = c.snapshot.capabilities
      continue
    }
    for (const r of c.rows ?? []) {
      const i = rows.findIndex((x) => x.id === r.id)
      if (i >= 0) rows[i] = r
      else rows.push(r)
    }
    if (c.live) live = c.live
    if (c.capabilities) caps = c.capabilities
  }
  return {
    rows,
    reply: live.reply ? live.reply.blocks.filter((b) => b.kind === "text").map((b) => b.text).join("") : null,
    working: live.working,
    efforts: caps.efforts?.current ?? null,
    model: caps.models?.current ?? null,
    pending: live.pending.length,
    running: rows.filter((r) => r.kind === "tool" && r.status === "running").length + live.tools.length,
  }
}

const startedAt = Date.now()
let fingerprintBefore = ""
let corePidsBefore: number[] = []

beforeAll(async () => {
  fingerprintBefore = fingerprint()
  corePidsBefore = corePids()
  hc("server", "start")
  watching = setInterval(follow, 100)
})

// A failed test keeps the scratch root (core stopped, folder left) and says where it is.
afterEach((ctx) => {
  if (ctx.task.result?.state === "fail") failed = true
})

afterAll(async () => {
  clearInterval(watching)
  for (const s of seen) s.connection.close()
  clock.print()
  stopCore(!failed)
})

function startPi(name: string, extraEnv: string[] = []): string {
  // PI_LIVE_DIR is the scratch root's folder: the core's terminals inherit it from the core, and it is said again here.
  const args = [
    "run", "--bg", "--name", name, "--cwd", work, "--", "env", `PI_LIVE_DIR=${liveDir}`, ...extraEnv,
    "pi", "-ne", "-e", LLAMA, "-e", piLive, "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files",
    "--session-dir", sessions, "--model", LOCAL_MODEL, "--thinking", "off",
  ]
  hc(...args)
  const ls = JSON.parse(hc("ls", "--json")) as { terminals: { address: string; name: string | null }[] }
  const t = ls.terminals.find((x) => x.name === name)
  if (!t) throw new Error(`terminal ${name} not found`)
  return t.address
}

const lastSeen = (terminal: string) => seen.filter((s) => s.thread.terminalId === terminal).at(-1)

describe("a real pi, a scratch core, this package's side of the socket", () => {
  it("pi starts and answers normally with pi-live loaded and no client connected; its session file says it is in this terminal", async () => {
    paused = true
    try {
      const t = startPi("no-client")
      const file = await until("pi's session file", () => liveFiles(liveDir).find((f) => f.terminal === t), 90_000)
      expect(file).toMatchObject({ mode: "tui", terminal: t })
      await until("pi's prompt", () => hc("read", t).includes("zorro") || hc("read", t).includes("llama-swap") || undefined, 90_000)
      const since = Date.now() - 1000
      hc("send", t, "Say hello in one short sentence.")
      // pi answered (an assistant message in its own session file), whatever it said
      await until("an answer in the session file", () => assistantMessages(sessions, since) >= 1 || undefined, MODEL_WAIT_MS)
      expect(seen.filter((s) => s.thread.terminalId === t)).toHaveLength(0)
      hc("kill", t)
      await until("the session file to go", () => !liveFiles(liveDir).some((f) => f.terminal === t) || undefined, 30_000)
    } finally {
      paused = false
    }
  })

  it("outside herdr-core (no HC_TERMINAL_ID) pi-live names no terminal, no client is made, and pi still answers", async () => {
    const before = seen.length
    const clean = { ...process.env }
    for (const k of ["HC_TERMINAL_ID", "HC_SOCKET", "HC_SCOPE", "HC_TERMINAL_SOCKET"]) delete clean[k]
    const r = spawnSync("pi", ["-ne", "-e", LLAMA, "-e", piLive, "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--session-dir", sessions, "--model", LOCAL_MODEL, "--thinking", "off", "-p", "Say hello in one short sentence."], {
      env: { ...clean, PI_LIVE_DIR: liveDir },
      encoding: "utf8",
      timeout: 150_000,
    })
    expect(r.status).toBe(0)
    expect(r.stdout.trim().length, "pi printed its answer").toBeGreaterThan(0)
    expect(liveFiles(liveDir).filter((f) => f.terminal && f.mode !== "tui")).toEqual([])
    expect(seen.length).toBe(before)
  })

  it("pi-live with control off: the client still gets the rows, and every action is refused with the sentence", async () => {
    const t = startPi("no-control", ["PI_LIVE_CONTROL=0"])
    const s = await until("the thread", () => lastSeen(t), 90_000)
    expect(s.ready.control).toBe(false)
    expect(s.ready.disabled).toBe(NO_CONTROL)
    expect(s.thread.snapshot().capabilities).toMatchObject({ send: false, disabled: NO_CONTROL })
    await expect(s.thread.send("hello")).rejects.toThrow(NO_CONTROL)
    hc("kill", t)
  })

  describe("one agent in a terminal", () => {
    let terminal = ""
    let s!: Seen

    // Nothing may be written to pi while a model other than the local one is selected (pi's list holds paid providers).
    beforeEach(() => {
      if (s) expect(current(s).model, "pi is on the local model before every test").toBe(LOCAL_MODEL)
    })

    it("identifies itself: terminal, folder, model list, effort levels", async () => {
      terminal = startPi("agent-1")
      s = await until("the thread", () => lastSeen(terminal), 90_000)
      const snap = s.snapshot
      expect(snap.identity).toMatchObject({ agent: "pi", terminalId: terminal, cwd: fs.realpathSync(work) })
      expect(snap.rows).toEqual([])
      expect(snap.hasMore).toBe(false)
      expect(snap.capabilities.send).toBe(true)
      expect(snap.capabilities.models?.current).toBe(LOCAL_MODEL)
      expect(snap.capabilities.models?.list.length).toBeGreaterThan(1)
      expect(snap.capabilities.efforts).toEqual({ list: ["off"], current: "off" })
    })

    it("a message from the app: working, live text growing, then the row replaces it with no moment of both", async () => {
      const text = "Count from 1 to 40, one number per line, and say nothing else. Do not use any tool."
      await s.thread.clearInput()
      clock.start("count to 40")
      await s.thread.send(text)
      await until("working", () => current(s).working || undefined)
      await until("settled", () => (!current(s).working && current(s).rows.some((r) => r.kind === "assistant")) || undefined, MODEL_WAIT_MS)

      // replay every change and look at each state the app would have shown
      const live: string[] = []
      let rows: Row[] = [...s.snapshot.rows]
      let reply: string | null = null
      const states: { rows: Row[]; reply: string | null }[] = []
      for (const c of s.changes) {
        if (c.type === "reset") continue
        for (const r of c.rows ?? []) {
          const i = rows.findIndex((x) => x.id === r.id)
          if (i >= 0) rows = rows.map((x, j) => (j === i ? r : x))
          else rows = [...rows, r]
        }
        if (c.live) reply = c.live.reply ? c.live.reply.blocks.filter((b) => b.kind === "text").map((b) => b.text).join("") : null
        states.push({ rows, reply })
        if (reply) live.push(reply)
      }
      expect(rows.filter((r) => r.kind === "user").map((r) => (r.kind === "user" ? r.text : ""))).toEqual([text])
      // the message, then an answer after it: structure, not the model's words
      const kinds = rows.map((r) => r.kind)
      expect(kinds.indexOf("assistant"), "an assistant row after the user row").toBeGreaterThan(kinds.indexOf("user"))
      // live text came in pieces, each a growth of the one before
      expect(new Set(live).size).toBeGreaterThan(1)
      for (let i = 1; i < live.length; i++) expect(live[i]!.startsWith(live[i - 1]!.slice(0, 10))).toBe(true)
      // never the reply on screen twice: while a row holds the answer the live reply is gone
      for (const st of states) {
        const done = st.rows.filter((r) => r.kind === "assistant").map((r) => (r.kind === "assistant" ? r.text.trim() : ""))
        if (st.reply && done.includes(st.reply.trim())) throw new Error("the finished reply was shown both live and as a row")
      }
      expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
      // seq is gapless
      const seqs = s.changes.map((c) => c.seq)
      expect(seqs).toEqual(seqs.map((_, i) => s.snapshot.seq + 1 + i))
      expect(current(s).working).toBe(false)
    })

    it("a tool call: a running row, then ok with the result", async () => {
      const before = current(s).rows.length
      clock.start("bash tool")
      await s.thread.send("Use the bash tool to run exactly: echo hw-live-$((6*7))  Then say done.")
      const tool = await until("the tool row", () => current(s).rows.slice(before).find((r) => r.kind === "tool"), MODEL_WAIT_MS)
      expect(tool.kind).toBe("tool")
      await until("settled", () => !current(s).working || undefined, MODEL_WAIT_MS)
      const done = current(s).rows.find((r) => r.kind === "tool" && r.id === tool.id)
      expect(done).toMatchObject({ kind: "tool", status: "ok", name: "bash" })
      expect(done?.kind === "tool" && done.result?.text).toContain("hw-live-42")
      // it was seen running before it finished
      expect(s.changes.some((c) => c.type === "update" && c.rows?.some((r) => r.id === tool.id && r.kind === "tool" && r.status === "running") || (c.type === "update" && (c.live?.tools.length ?? 0) > 0))).toBe(true)
    })

    it("stop: a long answer is cut short and the agent settles", async () => {
      // Cut at the first live text or the first tool that is running, whichever comes first: a model may reach for a tool
      // however the prompt is worded, and the stop has to settle the agent either way.
      clock.start("long story, stopped")
      await sendUntilStreaming(
        () => s.thread.send("Write a very long story, at least 3000 words, about a lighthouse. Do not use any tool."),
        { working: () => current(s).working, streaming: () => (current(s).reply?.length ?? 0) > 40 || current(s).running > 0 },
      )
      await s.thread.stop()
      await until("settled", () => !current(s).working || undefined, 30_000)
      expect(current(s).reply).toBeNull()
      expect(current(s).running, "no tool left running").toBe(0)
    })

    it("effort: a reasoning model offers levels, a change is reported back, and the local model offers only off again", async () => {
      const models = s.thread.snapshot().capabilities.models!.list
      const reasoning = models.find((m) => m.reasoning && m.id !== LOCAL_MODEL)
      expect(reasoning, "a reasoning model in pi's list").toBeDefined()
      // Only the model is selected: no message is sent while it is, and the local model is selected again whatever happens.
      try {
        await s.thread.setModel(reasoning!.id)
        await until("model", () => current(s).model === reasoning!.id || undefined, 15_000)
        const levels = s.thread.snapshot().capabilities.efforts!.list
        expect(levels.length).toBeGreaterThan(1)
        const pick = levels.find((l) => l !== "off" && l !== s.thread.snapshot().capabilities.efforts!.current)!
        await s.thread.setEffort(pick)
        await until("effort", () => current(s).efforts === pick || undefined, 15_000)
        await expect(s.thread.setEffort("not-a-level")).rejects.toThrow()
      } finally {
        await s.thread.setModel(LOCAL_MODEL)
        await until("local again", () => current(s).model === LOCAL_MODEL || undefined, 15_000)
      }
      expect(s.thread.snapshot().capabilities.efforts?.list).toEqual(["off"])
    })

    it("/new typed into the terminal: the old thread ends, a new one starts empty", async () => {
      const first = s
      await first.thread.clearInput()
      hc("send", terminal, "/new")
      const next = await until("the new thread", () => (lastSeen(terminal) !== first ? lastSeen(terminal) : undefined), 30_000)
      expect(first.thread.closed || (await until("old closed", () => first.thread.closed || undefined, 10_000))).toBeTruthy()
      expect(first.end, "pi-live's goodbye named what ended the session").toMatchObject({ shutdown: "new" })
      expect(next.snapshot.rows).toEqual([])
      expect(next.snapshot.identity.sessionId).not.toBe(first.snapshot.identity.sessionId)
      s = next
      // and it works: a message goes through the new connection
      const text = "Say hello in one short sentence."
      clock.start("hello after /new")
      await s.thread.send(text)
      // our message and one finished assistant reply on the new session, whatever its words
      await until("a finished reply", () => (!current(s).working && current(s).rows.some((r) => r.kind === "assistant")) || undefined, MODEL_WAIT_MS)
      const kinds = current(s).rows.map((r) => r.kind)
      expect(current(s).rows.find((r) => r.kind === "user")).toMatchObject({ kind: "user", text })
      expect(kinds.indexOf("assistant")).toBeGreaterThan(kinds.indexOf("user"))
      expect(new Set(current(s).rows.map((r) => r.id)).size).toBe(kinds.length)
    })

    it("/reload keeps the session: the new connection opens on the same rows", async () => {
      const before = s
      await until("settled", () => !current(s).working || undefined, 30_000)
      await before.thread.clearInput()
      hc("send", terminal, "/reload")
      const next = await until("the new thread", () => (lastSeen(terminal) !== before ? lastSeen(terminal) : undefined), 30_000)
      expect(next.snapshot.identity.sessionId).toBe(before.snapshot.identity.sessionId)
      expect(next.startedAt, "a new session file for the same session id").not.toBe(before.startedAt)
      expect(before.end).toMatchObject({ shutdown: "reload" })
      expect(next.snapshot.rows.map((r) => r.id)).toEqual(current(before).rows.map((r) => r.id))
      s = next
    })

    it("/compact is pi-live's action, not typed: the thread's compact() is answered and nothing is typed into the terminal", async () => {
      await until("settled", () => !current(s).working || undefined, 30_000)
      const screenBefore = hc("read", terminal)
      await s.thread.compact("keep it short")
      await until("pi idle again", () => !current(s).working || undefined, 120_000)
      expect(hc("read", terminal)).not.toContain("/compact keep it short")
      expect(screenBefore).not.toContain("/compact keep it short")
    })

    it("/name is pi-live's action: the thread's name follows", async () => {
      await s.thread.setName("hw live name")
      await until("the name", () => s.thread.snapshot().identity.title === "hw live name" || undefined, 15_000)
    })

    it("/quit typed into the terminal: the goodbye says quit, so nothing is about to come back", async () => {
      const last = s
      await last.thread.clearInput()
      hc("send", terminal, "/quit")
      const end = (await until("the connection to end", () => last.end, 30_000))!
      expect(end.shutdown).toBe("quit")
      expect(last.thread.closed).toBe(true)
      await sleep(1500)
      expect(lastSeen(terminal), "no new connection after quit").toBe(last)
    })
  })

  it("left pi's settings, extensions and own sessions folder alone, and the real core running", () => {
    expect(fingerprint()).toBe(fingerprintBefore) // settings.json and the extensions folder
    expect(strayedLiveFiles(root), "no file of Devendra's own pis in ~/.pi/agent/live names the scratch root").toEqual([])
    expect(strayedSessions(root, startedAt)).toEqual([]) // no session of the test in pi's own sessions folder
    expect(fs.readdirSync(sessions).filter((f) => f.endsWith(".jsonl")).length).toBeGreaterThan(0) // they went where --session-dir said
    const now = corePids()
    for (const pid of corePidsBefore) expect(now, `real core pid ${pid}`).toContain(pid)
  })
})
