import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { WIRE_VERSION, encodeLine, type Action, type ExtensionMessage, type WireModel } from "@herdr-web/agents/wire"

/**
 * What the pi extension looks like from the backend's agents socket, with no pi and no model: it says hello, reports a
 * model and an effort, and answers what the backend asks of it. A `send` plays a turn recorded from a live pi
 * (packages/agents/test/fixtures/pi/session-b-tools.jsonl: thinking, two tool calls of which one fails, a final answer),
 * with the reply written in pieces. Only the words of the user's message are new.
 */

const RECORDED = path.resolve(import.meta.dirname, "../../../packages/agents/test/fixtures/pi/session-b-tools.jsonl")

const MODELS: WireModel[] = [
  { provider: "stand", id: "alpha", name: "Alpha", reasoning: true, efforts: ["off", "low", "high"] },
  { provider: "stand", id: "beta", name: "Beta", reasoning: false, efforts: ["off"] },
]

type Entry = { id: string; parentId: string | null; message?: { content: { type: string; thinking?: string; text?: string; id?: string; name?: string }[] } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface StandInOptions {
  socketPath: string
  terminalId: string
  /** Where the session file this agent "writes" lives (a folder under /tmp). */
  dir: string
  /** Pause between the steps of a turn. */
  stepMs?: number
}

export class StandIn {
  /** Every action the backend asked for, in order. */
  readonly actions: Action[] = []
  closed = false
  private buffer = ""
  private model = MODELS[0]!
  private effort = "low"
  private working = false
  private cancelled = false
  private readonly file: string
  private readonly recorded: string[]
  private pending: Promise<void> = Promise.resolve()
  private constructor(
    private readonly socket: net.Socket,
    private readonly opts: StandInOptions,
  ) {
    this.recorded = fs.readFileSync(RECORDED, "utf8").split("\n").filter(Boolean)
    this.file = path.join(opts.dir, `stand-in-${opts.terminalId}-${Date.now()}.jsonl`)
    // The session so far: the header and the first exchange (lines 0 to 5); the turn that is played is the one after it.
    fs.writeFileSync(this.file, this.recorded.slice(0, 6).join("\n") + "\n")
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => this.read(chunk))
    socket.on("close", () => (this.closed = true))
    socket.on("error", () => {})
  }

  static async connect(opts: StandInOptions): Promise<StandIn> {
    fs.mkdirSync(opts.dir, { recursive: true })
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(opts.socketPath)
      s.once("connect", () => resolve(s))
      s.once("error", reject)
    })
    const agent = new StandIn(socket, opts)
    agent.hello()
    return agent
  }

  private send(message: Record<string, unknown>): void {
    if (!this.socket.destroyed) this.socket.write(encodeLine({ v: WIRE_VERSION, ...message } as ExtensionMessage))
  }

  private hello(): void {
    this.send({
      type: "hello",
      agent: "pi",
      terminalId: this.opts.terminalId,
      pid: process.pid,
      extension: "stand-in",
      reason: "startup",
      session: { id: "stand-in-session", file: this.file, name: null, cwd: "/tmp" },
    })
    this.send({ type: "models", list: MODELS })
    this.state()
  }

  private leaf: string | null = "98ad1ba9"
  private turns = 0

  private state(): void {
    this.send({
      type: "state",
      leafId: this.leaf,
      model: { provider: this.model.provider, id: this.model.id, name: this.model.name, reasoning: this.model.reasoning },
      effort: this.effort,
      efforts: this.model.efforts,
      working: this.working,
      pending: [],
      usage: { tokens: 54_000, window: 128_000, percent: 42 },
      name: null,
    })
  }

  private read(chunk: string): void {
    this.buffer += chunk
    for (let at = this.buffer.indexOf("\n"); at >= 0; at = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, at)
      this.buffer = this.buffer.slice(at + 1)
      const message = JSON.parse(line) as { type: string }
      if (message.type === "action") this.act(message as unknown as Action)
    }
  }

  private result(id: string, error?: string): void {
    this.send(error === undefined ? { type: "result", id, ok: true } : { type: "result", id, ok: false, error })
  }

  private act(action: Action): void {
    this.actions.push(action)
    switch (action.op) {
      case "send":
        this.result(action.id)
        this.pending = this.play(action.text)
        return
      case "stop":
        this.cancelled = true
        this.result(action.id)
        return
      case "set_model": {
        const model = MODELS.find((m) => `${m.provider}/${m.id}` === action.model)
        if (!model) return this.result(action.id, `Unknown model ${action.model}.`)
        this.model = model
        if (!model.efforts.includes(this.effort)) this.effort = "off"
        this.result(action.id)
        this.state()
        return
      }
      case "set_effort":
        if (!this.model.efforts.includes(action.effort)) return this.result(action.id, `This model does not take the effort “${action.effort}”. It takes: ${this.model.efforts.join(", ")}.`)
        this.effort = action.effort
        this.result(action.id)
        this.state()
        return
      case "clear_input":
        this.result(action.id)
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

  /** Goes away, as an extension does when pi exits or reloads. */
  close(): void {
    this.socket.destroy()
  }
}
