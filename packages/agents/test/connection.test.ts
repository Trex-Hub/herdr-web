import { spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { describe, expect, it, afterEach } from "vitest"
import { ActionSchema, BackendMessageSchema, WIRE_VERSION, agentsSocketPath, encodeLine, MAX_LINE_BYTES } from "../src/wire.js"
import { serveAgents, type AgentsServer } from "../src/serve.js"
import type { Thread } from "../src/thread.js"
import type { AgentConnection } from "../src/pi/connection.js"
import { hello, state, tmpDir } from "./helpers.js"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class Peer {
  lines: any[] = []
  closed = false
  private buf = ""
  socket: net.Socket
  constructor(socketPath: string) {
    this.socket = net.connect(socketPath)
    this.socket.setEncoding("utf8")
    this.socket.on("data", (d: string) => {
      this.buf += d
      let i
      while ((i = this.buf.indexOf("\n")) >= 0) {
        this.lines.push(JSON.parse(this.buf.slice(0, i)))
        this.buf = this.buf.slice(i + 1)
      }
    })
    this.socket.on("close", () => (this.closed = true))
    this.socket.on("error", () => {})
  }
  ready(): Promise<void> {
    return new Promise((res, rej) => {
      this.socket.once("connect", () => res())
      this.socket.once("error", rej)
    })
  }
  send(m: unknown) {
    this.socket.write(typeof m === "string" ? m : encodeLine(m as never))
  }
  async until(f: () => boolean, ms = 1500) {
    const end = Date.now() + ms
    while (Date.now() < end && !f()) await sleep(10)
    expect(f()).toBe(true)
  }
}

let server: AgentsServer | null = null
const peers: Peer[] = []
const logs: string[] = []
const threads: { thread: Thread; connection: AgentConnection }[] = []

async function start(socketPath = path.join(tmpDir(), "x", "agents.sock")) {
  server = await serveAgents(socketPath, { log: (l) => logs.push(l), onThread: (thread, connection) => threads.push({ thread, connection }) })
  return socketPath
}
async function connect(socketPath: string): Promise<Peer> {
  const p = new Peer(socketPath)
  peers.push(p)
  await p.ready()
  return p
}

afterEach(async () => {
  for (const p of peers.splice(0)) p.socket.destroy()
  await server?.close()
  server = null
  logs.length = 0
  threads.length = 0
})

describe("socket path", () => {
  it("takes HERDR_WEB_AGENTS_SOCKET, else the state folder, else ~/.local/state", () => {
    expect(agentsSocketPath({ HERDR_WEB_AGENTS_SOCKET: "/a/b.sock", XDG_STATE_HOME: "/s" })).toBe("/a/b.sock")
    expect(agentsSocketPath({ XDG_STATE_HOME: "/s" })).toBe("/s/herdr-web/agents.sock")
    expect(agentsSocketPath({ HOME: "/home/x" })).toBe("/home/x/.local/state/herdr-web/agents.sock")
  })
})

describe("serveAgents", () => {
  it("makes its folder mode 700 and the socket mode 600", async () => {
    const p = await start()
    expect(fs.statSync(path.dirname(p)).mode & 0o777).toBe(0o700)
    expect(fs.statSync(p).mode & 0o777).toBe(0o600)
  })

  it("removes a stale socket a dead backend left, and refuses to take a live one", async () => {
    const dir = tmpDir()
    const p = path.join(dir, "agents.sock")
    // a backend that is killed leaves its socket file behind
    const child = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(p)}, () => console.log("up"))`], { stdio: ["ignore", "pipe", "ignore"] })
    await new Promise<void>((r) => child.stdout!.once("data", () => r()))
    child.kill("SIGKILL")
    await new Promise((r) => child.once("exit", r))
    expect(fs.existsSync(p)).toBe(true)
    await start(p) // stale: taken over
    await expect(serveAgents(p, { onThread: () => {} })).rejects.toThrow(/already listening/)
  })
})

describe("one connection", () => {
  it("welcome after hello; the thread is handed over only after the first state, with a complete snapshot", async () => {
    const p = await start()
    const peer = await connect(p)
    peer.send(hello(null, { terminalId: "t7" }))
    await peer.until(() => peer.lines.length === 1)
    expect(BackendMessageSchema.parse(peer.lines[0])).toEqual({ v: 1, type: "welcome" })
    await sleep(30)
    expect(threads).toHaveLength(0)
    peer.send(state({ working: true }))
    await peer.until(() => threads.length === 1)
    expect(threads[0]!.thread.terminalId).toBe("t7")
    expect(threads[0]!.thread.snapshot().live.working).toBe(true)
  })

  it("lines arriving in pieces and several lines in one chunk are both read", async () => {
    const p = await start()
    const peer = await connect(p)
    const a = encodeLine(hello(null))
    peer.send(a.slice(0, 20))
    await sleep(20)
    peer.send(a.slice(20) + encodeLine(state()))
    await peer.until(() => threads.length === 1)
  })

  it("an action from the backend side reaches the extension as a valid line, and its result settles it", async () => {
    const p = await start()
    const peer = await connect(p)
    peer.send(hello(null))
    peer.send(state())
    await peer.until(() => threads.length === 1)
    const done = threads[0]!.thread.send("hi")
    await peer.until(() => peer.lines.some((l) => l.type === "action"))
    const action = ActionSchema.parse(peer.lines.find((l) => l.type === "action"))
    expect(action).toMatchObject({ op: "send", text: "hi" })
    peer.send({ v: 1, type: "result", id: action.id, ok: true })
    await done
  })

  it("a wire version the backend does not speak is refused with a reason, logged in one line, and closed", async () => {
    const p = await start()
    const peer = await connect(p)
    peer.send({ ...hello(null), v: 2 })
    await peer.until(() => peer.lines.length === 1)
    expect(peer.lines[0]).toMatchObject({ v: WIRE_VERSION, type: "refused" })
    expect(peer.lines[0].reason).toMatch(/version 2/)
    await peer.until(() => peer.closed)
    expect(logs).toEqual(["agents: refused a connection: the extension speaks wire version 2, this backend speaks 1"])
    expect(threads).toHaveLength(0)
  })

  it("a first line that is not JSON, not an object, or not a hello is refused", async () => {
    for (const first of ["not json\n", "null\n", "[]\n", encodeLine(state() as never), encodeLine({ ...hello(null), terminalId: "" } as never)]) {
      const p = await start()
      const peer = await connect(p)
      peer.send(first)
      await peer.until(() => peer.closed)
      expect(peer.lines[0]).toMatchObject({ type: "refused" })
      expect(threads).toHaveLength(0)
      peers.length = 0
      await server!.close()
      server = null
    }
  })

  it("a line that is junk after hello is ignored and logged; the connection and the thread live on", async () => {
    const p = await start()
    const peer = await connect(p)
    peer.send(hello(null))
    peer.send(state())
    await peer.until(() => threads.length === 1)
    peer.send("garbage\n")
    peer.send({ v: 1, type: "nonsense" })
    peer.send({ v: 9, type: "state" })
    peer.send({ v: 1, type: "reply", blocks: "no" })
    peer.send({ v: 1, type: "reply", blocks: [{ kind: "text", text: "still here" }] })
    await peer.until(() => threads[0]!.thread.snapshot().live.reply !== null)
    expect(peer.closed).toBe(false)
    expect(logs.length).toBe(4)
  })

  it("no hello in time closes the connection", async () => {
    const { acceptAgentConnection } = await import("../src/pi/connection.js")
    const { PassThrough } = await import("node:stream")
    const log: string[] = []
    const c = acceptAgentConnection(new PassThrough() as never, { helloTimeoutMs: 40, log: (l) => log.push(l) })
    await expect(c.identified).rejects.toThrow()
    await c.closed
    expect(log[0]).toMatch(/did not say hello/)
  })

  it("a hello that never gets a state does not become a thread, and the connection ends after the timeout", async () => {
    const { acceptAgentConnection } = await import("../src/pi/connection.js")
    const { PassThrough } = await import("node:stream")
    const a = new PassThrough()
    const c = acceptAgentConnection(a as never, { helloTimeoutMs: 60 })
    a.write(encodeLine(hello(null)))
    await expect(c.identified).rejects.toThrow(/before it was ready/)
  })

  it("a line longer than MAX_LINE_BYTES without a newline ends the connection", async () => {
    const p = await start()
    const peer = await connect(p)
    peer.send(hello(null))
    peer.send(state())
    await peer.until(() => threads.length === 1)
    const chunk = "x".repeat(1024 * 1024)
    for (let i = 0; i <= MAX_LINE_BYTES / chunk.length + 1; i++) peer.send(chunk)
    await peer.until(() => peer.closed, 4000)
    expect(threads[0]!.thread.closed).toBe(true)
    expect(logs.join("\n")).toMatch(/longer than/)
  })

  it("the extension going away closes the thread and `closed` resolves; a second connection of the same terminal (/new, /reload) is a new thread", async () => {
    const p = await start()
    const one = await connect(p)
    one.send(hello(null, { terminalId: "t3", reason: "startup" }))
    one.send(state())
    await one.until(() => threads.length === 1)
    let closed = 0
    threads[0]!.thread.onClose(() => closed++)
    one.socket.destroy()
    await threads[0]!.connection.closed
    expect(closed).toBe(1)
    const two = await connect(p)
    two.send(hello(null, { terminalId: "t3", reason: "new" }))
    two.send(state())
    await two.until(() => threads.length === 2)
    expect(threads[1]!.thread).not.toBe(threads[0]!.thread)
    expect(threads[1]!.thread.closed).toBe(false)
  })

  it("closing the server closes every connection and its thread", async () => {
    const p = await start()
    const peer = await connect(p)
    peer.send(hello(null))
    peer.send(state())
    await peer.until(() => threads.length === 1)
    await server!.close()
    server = null
    await peer.until(() => peer.closed)
    expect(threads[0]!.thread.closed).toBe(true)
  })

  it("forty connections at once each become their own thread and none sees another's state", async () => {
    const p = await start()
    const many = await Promise.all(Array.from({ length: 40 }, () => connect(p)))
    many.forEach((peer, i) => {
      peer.send(hello(null, { terminalId: `t${i + 1}` }))
      peer.send(state({ name: `n${i}` }))
    })
    await many[0]!.until(() => threads.length === 40)
    for (const { thread } of threads) expect(thread.snapshot().identity.title).toBe(`n${Number(thread.terminalId.slice(1)) - 1}`)
  })
})
