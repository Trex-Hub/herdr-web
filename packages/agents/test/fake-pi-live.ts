// A pi-live 0.2 socket, written from its docs/protocol.md, for tests of the client. It listens on a
// unix socket in a folder of its own, answers a chat client's hello with a welcome, and answers
// actions by the protocol's refusal rules. What a test wants to force (a welcome of its own, held
// answers, raw lines, a close with or without goodbye) it does through the methods below.
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

export interface FakeConfig {
  /** `welcome.features`; undefined leaves the field out (a pi-live older than 0.2). Default ["chat", "control"]. */
  features?: string[] | undefined
  control?: boolean
  session?: Record<string, unknown>
  /** `welcome.chat`; null leaves it out. */
  chat?: Record<string, unknown> | null
  /** Answer actions as the protocol says. When false the test answers them with `result()`. Default true. */
  autoReply?: boolean
  /** A refusal sentence per op, in place of ok. */
  refusals?: Record<string, string>
  /** `welcome.items`: prompts already open (their `id`, `owner`, `kind`, `title`, `view`, `openedAt`). */
  items?: Record<string, unknown>[]
  /** Answers the fake refuses as invalid, by item id: the reason it gives. Anything else open is delivered. */
  invalidAnswers?: Record<string, string>
  /** Replace the whole welcome. */
  welcome?: Record<string, unknown>
  /** Send no welcome at all. */
  silent?: boolean
}

export const BUILT_INS = "settings model thinking scoped-models login logout llama new resume name session tree fork clone compact import copy export share bug trust mcp reload hotkeys changelog quit".split(" ")

export function chatPicture(overrides: Record<string, unknown> = {}) {
  return {
    state: {
      leafId: null,
      model: { provider: "llama-swap", id: "local", name: "Local", reasoning: false },
      effort: "off",
      efforts: ["off"],
      working: false,
      pending: [],
      usage: null,
      name: null,
      waitingForUser: null,
    },
    models: [{ provider: "llama-swap", id: "local", name: "Local", reasoning: false, efforts: ["off"] }],
    commands: [{ name: "review", description: "Review", source: "prompt" }],
    reply: { blocks: [] },
    tools: [],
    ...overrides,
  }
}

let counter = 0

export class FakePi {
  /** Every line a client sent, parsed. */
  readonly received: any[] = []
  /** Lines the fake could not parse. */
  readonly junk: string[] = []
  readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), `hw-fake-pi-${process.pid}-${counter++}-`))
  readonly path = path.join(this.dir, "pi.sock")
  private server = net.createServer((socket) => this.accept(socket))
  private sockets = new Set<net.Socket>()
  private client: net.Socket | null = null
  /** Items open now and ids closed before, as pi-live keeps them (`answer` to a closed id is `closed`, to an unknown one `not_found`). */
  private openItems = new Map<string, Record<string, unknown>>()
  private closedItems = new Set<string>()
  /** Set when a client sent a line longer than 1 MiB: pi-live answers it with an error and closes. */
  tooLong = false

  private constructor(readonly config: FakeConfig) {
    for (const item of config.items ?? []) this.openItems.set(String(item.id), item)
  }

  static async start(config: FakeConfig = {}): Promise<FakePi> {
    const fake = new FakePi(config)
    await new Promise<void>((resolve) => fake.server.listen(fake.path, resolve))
    return fake
  }

  /** Connections open now. */
  get connections(): number {
    return this.sockets.size
  }

  welcome(): Record<string, unknown> {
    const c = this.config
    if (c.welcome) return c.welcome
    const features = "features" in c ? c.features : ["chat", "control"]
    const chat = c.chat === null ? undefined : (c.chat ?? chatPicture())
    return {
      type: "welcome",
      protocol: 1,
      version: "0.2.0",
      ...(features !== undefined && { features }),
      control: c.control ?? true,
      session: { id: "s-1", cwd: "/tmp/work", pid: 4242, mode: "tui", terminal: "t1", ...c.session },
      connId: "c1",
      items: [...this.openItems.values()],
      ...(chat !== undefined && { chat }),
    }
  }

  private accept(socket: net.Socket): void {
    this.sockets.add(socket)
    socket.on("close", () => this.sockets.delete(socket))
    socket.on("error", () => {})
    let buffer = Buffer.alloc(0)
    let said = false
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        const at = buffer.indexOf(0x0a)
        if (at < 0) break
        const line = buffer.subarray(0, at).toString("utf8")
        buffer = buffer.subarray(at + 1)
        if (line.length > 1024 * 1024) return this.refuseLong(socket)
        let message: any
        try {
          message = JSON.parse(line)
        } catch {
          this.junk.push(line)
          continue
        }
        this.received.push(message)
        if (!said && message.type === "hello") {
          said = true
          this.client = socket
          if (!this.config.silent) this.send(this.welcome())
        } else if (message.type === "action") this.onAction(message)
        else if (message.type === "answer") this.onAnswer(message)
      }
      if (buffer.length > 1024 * 1024) this.refuseLong(socket)
    })
  }

  private refuseLong(socket: net.Socket): void {
    this.tooLong = true
    socket.end(JSON.stringify({ type: "error", message: "line too long" }) + "\n")
  }

  /** The protocol's answers to an `answer`; a delivered one closes the item, after its result. */
  private onAnswer(message: any): void {
    if (this.config.autoReply === false) return
    const id = String(message.id)
    const reason = this.config.invalidAnswers?.[id]
    if (this.openItems.has(id) && reason === undefined) {
      this.answerResult(message.reqId, id, "delivered")
      this.closeItem(id, { by: "client", client: { connId: "c1", name: "herdr-web" } })
    } else if (this.openItems.has(id)) this.answerResult(message.reqId, id, "invalid", reason)
    else this.answerResult(message.reqId, id, this.closedItems.has(id) ? "closed" : "not_found")
  }

  private onAction(action: any): void {
    if (this.config.autoReply === false) return
    this.result(action.reqId, this.verdict(action))
  }

  /** The protocol's answer to an action: null is ok, a string is the refusal sentence. */
  private verdict(action: any): string | null {
    if (this.config.control === false) return "Control is off for this pi."
    const refusal = this.config.refusals?.[action.op]
    if (refusal) return refusal
    switch (action.op) {
      case "send": {
        const text = String(action.text ?? "").trim()
        if (text === "") return "There is nothing to send."
        const first = text.split(/\s/)[0]!
        if (first.startsWith("/") && BUILT_INS.includes(first.slice(1))) return `pi-live can't run ${first}. Use the matching action, or type it in pi's terminal.`
        return null
      }
      case "set_name":
        return String(action.name ?? "").trim() === "" ? "The name is empty." : null
      case "stop":
      case "set_model":
      case "set_effort":
      case "compact":
      case "clear_input":
        return null
      default:
        return `Unknown action “${String(action.op)}”.`
    }
  }

  // ---- what a test does ------------------------------------------------------------------------

  /** The actions received so far, in order. */
  actions(): any[] {
    return this.received.filter((m) => m.type === "action")
  }

  send(message: object): void {
    this.sendRaw(JSON.stringify(message) + "\n")
  }

  sendRaw(text: string): void {
    this.client?.write(text)
  }

  result(reqId: string, error: string | null = null): void {
    this.send(error === null ? { type: "action_result", reqId, ok: true } : { type: "action_result", reqId, ok: false, error })
  }

  /** An item opens: pi-live tells every client. */
  openItem(item: Record<string, unknown>): void {
    this.openItems.set(String(item.id), item)
    this.send({ type: "item_opened", item })
  }

  /** An item closes, by whoever `outcome` says. */
  closeItem(id: string, outcome: Record<string, unknown> = { by: "keyboard" }): void {
    this.openItems.delete(id)
    this.closedItems.add(id)
    this.send({ type: "item_closed", id, outcome })
  }

  answerResult(reqId: string, id: string, status: string, reason?: string): void {
    this.send({ type: "answer_result", reqId, id, status, ...(reason !== undefined && { reason }) })
  }

  /** The `answer` messages received so far, in order. */
  answers(): any[] {
    return this.received.filter((m) => m.type === "answer")
  }

  /** pi-live ending the session: goodbye, then the close. */
  goodbye(shutdown?: string): void {
    this.send({ type: "goodbye", reason: "session_shutdown", ...(shutdown !== undefined && { shutdown }) })
    this.client?.end()
  }

  /** Close with no goodbye, as a crashed pi does. */
  crash(): void {
    this.client?.destroy()
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

/** Poll until `check` holds. */
export async function until(check: () => boolean, what = "the condition", ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}
