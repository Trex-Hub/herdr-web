// A real pi, started by a scratch core, with the extension of this repo loaded, talking to the
// backend's side of the agents socket (served by this package, with this file standing in for the
// backend). Run with `pnpm test:agents` from the repo root. Needs `hc`, `pi` and the local model.
//
// It never touches the real core: every `hc` call runs under scripts/scratch-env.mjs with a root
// of its own under /tmp, and the real core's pid is checked before and after. It never writes
// pi's own configuration: settings.json, the extensions folder and the sessions folder are
// checksummed before and after.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { assistantMessages, corePids, extension, fingerprint, LLAMA, LOCAL_MODEL, scratch, strayedSessions, until } from "./support.js"
import { serveAgents, type AgentsServer } from "../src/serve.js"
import type { AgentConnection } from "../src/pi/connection.js"
import type { Row, ThreadChange, ThreadSnapshot } from "../src/rows.js"
import type { Thread } from "../src/thread.js"

const { root, env, work, sessions, hc, stopCore } = scratch("hw-ag-live-")
const socketPath = path.join(root, "agents.sock")

// ---- the backend side ----------------------------------------------------------------------

interface Seen {
  thread: Thread
  connection: AgentConnection
  snapshot: ThreadSnapshot
  changes: ThreadChange[]
  /** `rows` as the app would hold them: the snapshot, then every change applied. */
  at: number
}
const seen: Seen[] = []
let server: AgentsServer
const logs: string[] = []

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
  server = await serveAgents(socketPath, {
    log: (l) => logs.push(l),
    onThread: (thread, connection) => {
      const snapshot = thread.snapshot()
      const entry: Seen = { thread, connection, snapshot, changes: [], at: Date.now() }
      thread.subscribe((c) => entry.changes.push(c)) // same tick as the snapshot: nothing is lost
      seen.push(entry)
    },
  })
})

afterAll(async () => {
  await server?.close()
  stopCore()
})

function startPi(name: string, extra: { socket?: string } = {}): string {
  const args = [
    "run", "--bg", "--name", name, "--cwd", work, "--", "env", `HERDR_WEB_AGENTS_SOCKET=${extra.socket ?? socketPath}`,
    "pi", "-ne", "-e", LLAMA, "-e", extension, "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files",
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
  it("pi starts and answers normally with the extension loaded and no backend listening", async () => {
    const t = startPi("no-socket", { socket: path.join(root, "nobody-listens.sock") })
    await until("pi's prompt", () => hc("read", t).includes("zorro") || hc("read", t).includes("llama-swap") || undefined, 90_000)
    const since = Date.now() - 1000
    hc("send", t, "Say hello in one short sentence.")
    // pi answered (an assistant message in its own session file), whatever it said
    await until("an answer in the session file", () => assistantMessages(sessions, since) >= 1 || undefined, 120_000)
    expect(seen.filter((s) => s.thread.terminalId === t)).toHaveLength(0)
    hc("kill", t)
  })

  it("outside herdr-core (no HC_TERMINAL_ID) the extension makes no connection and pi still answers", async () => {
    const before = seen.length
    const clean = { ...process.env }
    for (const k of ["HC_TERMINAL_ID", "HC_SOCKET", "HC_SCOPE", "HC_TERMINAL_SOCKET"]) delete clean[k]
    const r = spawnSync("pi", ["-ne", "-e", LLAMA, "-e", extension, "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--session-dir", sessions, "--model", LOCAL_MODEL, "--thinking", "off", "-p", "Say hello in one short sentence."], {
      env: { ...clean, HERDR_WEB_AGENTS_SOCKET: socketPath },
      encoding: "utf8",
      timeout: 150_000,
    })
    expect(r.status).toBe(0)
    expect(r.stdout.trim().length, "pi printed its answer").toBeGreaterThan(0)
    expect(seen.length).toBe(before)
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
      await s.thread.send(text)
      await until("working", () => current(s).working || undefined)
      await until("settled", () => (!current(s).working && current(s).rows.some((r) => r.kind === "assistant")) || undefined, 120_000)

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
      await s.thread.send("Use the bash tool to run exactly: echo hw-live-$((6*7))  Then say done.")
      const tool = await until("the tool row", () => current(s).rows.slice(before).find((r) => r.kind === "tool"), 120_000)
      expect(tool.kind).toBe("tool")
      await until("settled", () => !current(s).working || undefined, 120_000)
      const done = current(s).rows.find((r) => r.kind === "tool" && r.id === tool.id)
      expect(done).toMatchObject({ kind: "tool", status: "ok", name: "bash" })
      expect(done?.kind === "tool" && done.result?.text).toContain("hw-live-42")
      // it was seen running before it finished
      expect(s.changes.some((c) => c.type === "update" && c.rows?.some((r) => r.id === tool.id && r.kind === "tool" && r.status === "running") || (c.type === "update" && (c.live?.tools.length ?? 0) > 0))).toBe(true)
    })

    it("stop: a long answer is cut short and the agent settles", async () => {
      // Cut at the first live text or the first tool that is running, whichever comes first: a model may reach for a tool
      // however the prompt is worded, and the stop has to settle the agent either way.
      await s.thread.send("Write a very long story, at least 3000 words, about a lighthouse. Do not use any tool.")
      await until("live text or a running tool", () => (current(s).reply?.length ?? 0) > 40 || current(s).running > 0 || undefined, 90_000)
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
      expect(next.snapshot.rows).toEqual([])
      expect(next.snapshot.identity.sessionId).not.toBe(first.snapshot.identity.sessionId)
      s = next
      // and it works: a message goes through the new connection
      const text = "Say hello in one short sentence."
      await s.thread.send(text)
      // our message and one finished assistant reply on the new session, whatever its words
      await until("a finished reply", () => (!current(s).working && current(s).rows.some((r) => r.kind === "assistant")) || undefined, 120_000)
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
      expect(next.snapshot.rows.map((r) => r.id)).toEqual(current(before).rows.map((r) => r.id))
    })

    it("a version the backend does not speak is refused in one log line (a second extension, wire 2, by hand)", async () => {
      const net = await import("node:net")
      const sock = net.connect(socketPath)
      await new Promise<void>((r) => sock.once("connect", () => r()))
      sock.write(JSON.stringify({ v: 2, type: "hello" }) + "\n")
      const reply = await new Promise<string>((r) => sock.once("data", (d) => r(String(d))))
      expect(JSON.parse(reply)).toMatchObject({ type: "refused" })
      expect(logs.filter((l) => /refused a connection/.test(l))).toHaveLength(1)
    })
  })

  it("left pi's settings, extensions and own sessions folder alone, and the real core running", () => {
    expect(fingerprint()).toBe(fingerprintBefore) // settings.json and the extensions folder
    expect(strayedSessions(root, startedAt)).toEqual([]) // no session of the test in pi's own sessions folder
    expect(fs.readdirSync(sessions).filter((f) => f.endsWith(".jsonl")).length).toBeGreaterThan(0) // they went where --session-dir said
    const now = corePids()
    for (const pid of corePidsBefore) expect(now, `real core pid ${pid}`).toContain(pid)
  })
})
