import fs from "node:fs"
import net from "node:net"
import path from "node:path"

/**
 * What a pi with pi-live 0.2 looks like from the backend, with no pi and no model: a socket of its own and a `<sessionId>.json` in
 * pi-live's folder (the scratch root's `live`, which the backend under test watches), the `welcome` that carries the first
 * picture of the chat, and answers (`action_result`, matched by `reqId`) to what the backend asks of it. A `send` plays a turn
 * recorded from a live pi (packages/agents/test/fixtures/pi/session-b-tools.jsonl: thinking, two tool calls of which one fails,
 * a final answer), with the reply written in pieces. Only the words of the user's message are new.
 */

const RECORDED = path.resolve(import.meta.dirname, "../../../packages/agents/test/fixtures/pi/session-b-tools.jsonl")

interface Model {
  provider: string
  id: string
  name: string
  reasoning: boolean
  efforts: string[]
}
const MODELS: Model[] = [
  { provider: "stand", id: "alpha", name: "Alpha", reasoning: true, efforts: ["off", "low", "high"] },
  { provider: "stand", id: "beta", name: "Beta", reasoning: false, efforts: ["off"] },
]

/** An action as it is on pi-live's wire. */
export type Action = { type: "action"; reqId: string } & (
  | { op: "send"; text: string }
  | { op: "stop" }
  | { op: "set_model"; model: string }
  | { op: "set_effort"; effort: string }
  | { op: "clear_input" }
  | { op: "compact"; instructions?: string }
  | { op: "set_name"; name: string }
)

type Entry = { id: string; parentId: string | null; message?: { content: { type: string; thinking?: string; text?: string; id?: string; name?: string }[] } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface StandInOptions {
  /** pi-live's folder: where the backend looks for session files. */
  liveDir: string
  terminalId: string
  /** `welcome.features`; default chat and control. */
  features?: string[]
  /** `welcome.control`; default true. */
  control?: boolean
  /** Where the session file this agent "writes" lives (a folder under /tmp). */
  dir: string
  /** Pause between the steps of a turn. */
  stepMs?: number
}

export class StandIn {
  /** Every action the backend asked for, in order. */
  readonly actions: Action[] = []
  closed = false
  /** Connections the backend has made to this pi. */
  hellos = 0
  readonly sessionId: string
  private readonly socketDir: string
  private readonly jsonPath: string
  private readonly server: net.Server
  private client: net.Socket | null = null
  private readonly sockets = new Set<net.Socket>()
  private buffer = ""
  private model = MODELS[0]!
  private effort = "low"
  private working = false
  private cancelled = false
  private readonly file: string
  private readonly recorded: string[]
  private pending: Promise<void> = Promise.resolve()
  private constructor(private readonly opts: StandInOptions) {
    this.recorded = fs.readFileSync(RECORDED, "utf8").split("\n").filter(Boolean)
    this.sessionId = `stand-${opts.terminalId}-${Date.now()}`
    this.file = path.join(opts.dir, `${this.sessionId}.jsonl`)
    this.socketDir = fs.mkdtempSync("/tmp/hw-pl-") // short on purpose: a unix socket path must stay under ~100 characters
    this.jsonPath = path.join(opts.liveDir, `${this.sessionId}.json`)
    // The session so far: the header and the first exchange (lines 0 to 5); the turn that is played is the one after it.
    fs.writeFileSync(this.file, this.recorded.slice(0, 6).join("\n") + "\n")
    this.server = net.createServer((socket) => this.accept(socket))
  }

  static async connect(opts: StandInOptions): Promise<StandIn> {
    fs.mkdirSync(opts.dir, { recursive: true })
    fs.mkdirSync(opts.liveDir, { recursive: true })
    const pi = new StandIn(opts)
    const socketPath = path.join(pi.socketDir, "pi.sock")
    await new Promise<void>((resolve) => pi.server.listen(socketPath, resolve))
    pi.publish(socketPath)
    return pi
  }

  /** Writes the session file the way pi-live does: whole, by a rename. */
  private publish(socketPath: string): void {
    const body = {
      protocol: 1,
      sessionId: this.sessionId,
      sessionFile: this.file,
      cwd: "/tmp",
      pid: process.pid,
      startedAt: new Date().toISOString(),
      socketPath,
      mode: "tui",
      terminal: this.opts.terminalId,
      version: "0.2.0",
    }
    const tmp = `${this.jsonPath}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(body) + "\n", { mode: 0o600 })
    fs.renameSync(tmp, this.jsonPath)
  }

  private accept(socket: net.Socket): void {
    this.sockets.add(socket)
    socket.setEncoding("utf8")
    let said = false
    socket.on("data", (chunk: string) => {
      this.buffer += chunk
      for (let at = this.buffer.indexOf("\n"); at >= 0; at = this.buffer.indexOf("\n")) {
        const line = this.buffer.slice(0, at)
        this.buffer = this.buffer.slice(at + 1)
        const message = JSON.parse(line) as { type: string }
        if (message.type === "hello" && !said) {
          said = true
          this.hellos++
          this.client = socket
          this.send(this.welcome())
        } else if (message.type === "action") this.act(message as unknown as Action)
      }
    })
    socket.on("close", () => {
      this.sockets.delete(socket)
      if (this.client === socket) this.client = null
    })
    socket.on("error", () => {})
  }

  private send(message: Record<string, unknown>): void {
    if (this.client && !this.client.destroyed) this.client.write(JSON.stringify(message) + "\n")
  }

  private chatPicture() {
    return {
      state: this.stateBody(),
      models: MODELS,
      commands: [],
      reply: { blocks: [] },
      tools: [],
    }
  }

  private welcome(): Record<string, unknown> {
    const { features = ["chat", "control"], control = true } = this.opts
    return {
      type: "welcome",
      protocol: 1,
      version: "0.2.0",
      features,
      control,
      session: { id: this.sessionId, file: this.file, cwd: "/tmp", pid: process.pid, mode: "tui", terminal: this.opts.terminalId },
      connId: "stand-in",
      items: [],
      ...(features.includes("chat") && { chat: this.chatPicture() }),
    }
  }

  private leaf: string | null = "98ad1ba9"
  private turns = 0

  private state(): void {
    this.send({ type: "state", ...this.stateBody() })
  }

  private stateBody() {
    return {
      leafId: this.leaf,
      model: { provider: this.model.provider, id: this.model.id, name: this.model.name, reasoning: this.model.reasoning },
      effort: this.effort,
      efforts: this.model.efforts,
      working: this.working,
      pending: [],
      usage: { tokens: 54_000, window: 128_000, percent: 42 },
      name: null,
      waitingForUser: null,
    }
  }

  private result(reqId: string, error?: string): void {
    this.send(error === undefined ? { type: "action_result", reqId, ok: true } : { type: "action_result", reqId, ok: false, error })
  }

  private act(action: Action): void {
    this.actions.push(action)
    switch (action.op) {
      case "send":
        this.result(action.reqId)
        this.pending = this.play(action.text)
        return
      case "stop":
        this.cancelled = true
        this.result(action.reqId)
        return
      case "set_model": {
        const model = MODELS.find((m) => `${m.provider}/${m.id}` === action.model)
        if (!model) return this.result(action.reqId, `Unknown model ${action.model}.`)
        this.model = model
        if (!model.efforts.includes(this.effort)) this.effort = "off"
        this.result(action.reqId)
        this.state()
        return
      }
      case "set_effort":
        if (!this.model.efforts.includes(action.effort)) return this.result(action.reqId, `This model does not take the effort “${action.effort}”. It takes: ${this.model.efforts.join(", ")}.`)
        this.effort = action.effort
        this.result(action.reqId)
        this.state()
        return
      case "clear_input":
      case "compact":
      case "set_name":
        this.result(action.reqId)
        return
    }
  }

  private append(...lines: string[]): void {
    fs.appendFileSync(this.file, lines.join("\n") + "\n")
  }

  private async pieces(blocks: { kind: "text" | "thinking"; text: string }[], upto: number, step: number): Promise<void> {
    // The last block grows a few words at a time.
    const last = blocks[blocks.length - 1]!
    const words = last.text.split(/(?<= )/)
    const size = Math.max(1, Math.ceil(words.length / upto))
    for (let i = size; i < words.length + size; i += size) {
      if (this.cancelled) return
      this.send({ type: "reply", blocks: [...blocks.slice(0, -1), { kind: last.kind, text: words.slice(0, i).join("") }] })
      await sleep(step)
    }
  }

  /** The recorded turn (lines 6 to 10), after the user's own words in place of the recorded ones. */
  private async play(text: string): Promise<void> {
    const step = this.opts.stepMs ?? 150
    this.cancelled = false
    this.working = true
    // Every turn is the recorded one again under new ids, on top of wherever the session is now.
    const n = ++this.turns
    let lines = this.recorded.slice(6, 11).join("\n")
    for (const id of new Set([...lines.matchAll(/"(?:id|toolCallId|parentId)":\s*"([^"]+)"/g)].map((m) => m[1]!))) lines = lines.split(`"${id}"`).join(`"${id}-${n}"`)
    const [user, call, resultA, resultB, answer] = lines.split("\n").map((l) => JSON.parse(l) as Entry)
    user!.parentId = this.leaf
    const typed = { ...user!, message: { ...(user!.message as object), content: [{ type: "text", text }] } }
    this.state()
    this.append(JSON.stringify(typed))
    this.leaf = user!.id
    this.send({ type: "entries", leafId: this.leaf, replyDone: false })
    const thinking = (e: Entry) => e.message!.content.find((c) => c.type === "thinking")!.thinking!
    await this.pieces([{ kind: "thinking", text: thinking(call!) }], 3, step)
    if (this.cancelled) return this.stopped()

    const tools = call!.message!.content.filter((c) => c.type === "toolCall")
    this.append(JSON.stringify(call))
    this.leaf = call!.id
    this.send({ type: "entries", leafId: this.leaf, replyDone: true })
    this.send({ type: "reply", blocks: [] })
    for (const t of tools) this.send({ type: "tool", phase: "start", callId: t.id, name: t.name })
    await sleep(step * 3)
    if (this.cancelled) return this.stopped()

    this.append(JSON.stringify(resultA), JSON.stringify(resultB))
    this.leaf = resultB!.id
    this.send({ type: "entries", leafId: this.leaf, replyDone: false })
    this.send({ type: "tool", phase: "end", callId: tools[0]!.id, name: "bash", isError: false })
    this.send({ type: "tool", phase: "end", callId: tools[1]!.id, name: "bash", isError: true })
    await sleep(step)

    const finalText = answer!.message!.content.find((c) => c.type === "text")?.text ?? "Done."
    await this.pieces([{ kind: "thinking", text: thinking(answer!) }, { kind: "text", text: finalText }], 5, step)
    if (this.cancelled) return this.stopped()

    this.append(JSON.stringify(answer))
    this.leaf = answer!.id
    this.send({ type: "entries", leafId: this.leaf, replyDone: true })
    this.send({ type: "reply", blocks: [] })
    this.working = false
    this.state()
  }

  private stopped(): void {
    this.send({ type: "reply", blocks: [] })
    this.send({ type: "notice", level: "info", text: "Stopped." })
    this.working = false
    this.state()
  }

  /** Resolves when the turn that is playing has ended (finished or stopped). */
  idle(): Promise<void> {
    return this.pending
  }

  /** pi-live ending the session: `goodbye` (`quit`, or `new`, `reload` and so on), the file removed when it is a quit, and the close. */
  goodbye(shutdown: string = "quit"): void {
    this.send({ type: "goodbye", reason: "session_shutdown", shutdown })
    for (const s of this.sockets) s.end()
    if (shutdown === "quit") fs.rmSync(this.jsonPath, { force: true })
  }

  /** Goes away, as pi does when it quits: goodbye, the file gone, the socket closed. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.goodbye("quit")
    for (const s of this.sockets) s.destroy()
    this.server.close()
    try {
      fs.rmSync(path.join(this.socketDir, "pi.sock"), { force: true })
      fs.rmdirSync(this.socketDir)
    } catch {
      // not ours to insist on
    }
  }
}
