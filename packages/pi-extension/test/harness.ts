// A stand-in for pi (its extension API and context) and for the backend's agents socket.
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { ExtensionMessageSchema, encodeLine, type ExtensionMessage } from "@herdr-web/agents/wire"
import herdrWeb from "../src/index.js"

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function until(f: () => boolean, ms = 2500): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end && !f()) await sleep(10)
  if (!f()) throw new Error(`timed out after ${ms} ms`)
}

let n = 0
export function tmpSocket(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hw-ext-test-${process.pid}-${n++}-`))
  return path.join(dir, "agents.sock")
}

export interface Conn {
  socket: net.Socket
  raw: unknown[]
  messages: ExtensionMessage[]
  invalid: unknown[]
  closed: boolean
  send(m: unknown): void
}

/** The backend's side of the agents socket: everything an extension says, validated against the schemas in packages/agents. */
export class FakeBackend {
  conns: Conn[] = []
  private server = net.createServer()
  constructor(readonly path: string) {}
  async listen(): Promise<this> {
    this.server.on("connection", (socket) => {
      const conn: Conn = { socket, raw: [], messages: [], invalid: [], closed: false, send: (m) => socket.write(typeof m === "string" ? m : encodeLine(m as never)) }
      let buf = ""
      socket.setEncoding("utf8")
      socket.on("data", (d: string) => {
        buf += d
        let i
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          const value = JSON.parse(line)
          conn.raw.push(value)
          const parsed = ExtensionMessageSchema.safeParse(value)
          if (parsed.success) conn.messages.push(parsed.data)
          else conn.invalid.push(value)
        }
      })
      socket.on("close", () => (conn.closed = true))
      socket.on("error", () => {})
      this.conns.push(conn)
    })
    await new Promise<void>((r) => this.server.listen(this.path, r))
    return this
  }
  get all(): ExtensionMessage[] {
    return this.conns.flatMap((c) => c.messages)
  }
  of<T extends ExtensionMessage["type"]>(type: T, conn = this.conns.at(-1)): Extract<ExtensionMessage, { type: T }>[] {
    return (conn?.messages ?? []).filter((m) => m.type === type) as never
  }
  async close(): Promise<void> {
    for (const c of this.conns) c.socket.destroy()
    await new Promise<void>((r) => this.server.close(() => r()))
  }
}

export interface FakeModel {
  provider: string
  id: string
  name?: string
  reasoning?: boolean
  thinkingLevelMap?: Record<string, unknown>
}

export const LOCAL: FakeModel = { provider: "llama-swap", id: "local", name: "Local", reasoning: false }
export const THINKER: FakeModel = { provider: "or", id: "think", name: "Think", reasoning: true, thinkingLevelMap: { minimal: null, xhigh: "x" } }

/** pi, as far as the extension uses it. */
export class FakePi {
  handlers = new Map<string, ((e: any, c: any) => unknown)[]>()
  sent: { content: string; options?: unknown }[] = []
  aborted = 0
  editorTexts: string[] = []
  thinking = "off"
  modelSet: FakeModel[] = []
  setModelResult = true
  idle = true
  leaf: string | null = null
  models: FakeModel[] = [LOCAL, THINKER]
  model: FakeModel | undefined = LOCAL
  hasUI = true
  throwing = false
  sessionName: string | undefined

  api = {
    on: (event: string, handler: (e: any, c: any) => unknown) => {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
    },
    sendUserMessage: (content: string, options?: unknown) => {
      this.sent.push({ content, options })
    },
    setModel: async (m: FakeModel) => {
      this.modelSet.push(m)
      if (this.setModelResult) this.model = m
      return this.setModelResult
    },
    setThinkingLevel: (l: string) => {
      this.thinking = l
    },
    getThinkingLevel: () => this.thinking,
    getSessionName: () => this.sessionName,
  }

  ctx = () => {
    const self = this
    const guard = <T,>(v: T): T => {
      if (self.throwing) throw new Error("pi is broken")
      return v
    }
    return {
      get model() {
        return self.model
      },
      thinkingLevel: this.thinking,
      scopedModels: [] as { model: FakeModel }[],
      cwd: "/tmp/work",
      get hasUI() {
        return self.hasUI
      },
      ui: { setEditorText: (t: string) => self.editorTexts.push(t) },
      modelRegistry: {
        getAvailable: () => guard(self.models),
        find: (p: string, id: string) => self.models.find((m) => m.provider === p && m.id === id),
      },
      sessionManager: {
        getSessionFile: () => guard("/tmp/work/s.jsonl"),
        getSessionId: () => "sid-1",
        getLeafId: () => guard(self.leaf),
      },
      isIdle: () => guard(self.idle),
      abort: () => {
        self.aborted++
      },
      getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
    }
  }

  load(): void {
    herdrWeb(this.api as never)
  }

  /** Deliver one event the way pi does: every handler of that name, in order. */
  emit(name: string, event: Record<string, unknown> = {}): unknown[] {
    return (this.handlers.get(name) ?? []).map((h) => h({ type: name, ...event }, this.ctx()))
  }
}

export function withEnv<T>(env: Record<string, string | undefined>, f: () => Promise<T>): Promise<T> {
  const before: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) {
    before[k] = process.env[k]
    if (env[k] === undefined) delete process.env[k]
    else process.env[k] = env[k]
  }
  return f().finally(() => {
    for (const k of Object.keys(env)) {
      if (before[k] === undefined) delete process.env[k]
      else process.env[k] = before[k]
    }
  })
}
