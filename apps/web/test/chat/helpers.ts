import { EMPTY_LIVE, type Capabilities, type Identity, type Live, type Row, type ThreadChange, type ThreadSnapshot } from "@herdr-web/agents/rows"
import type { ChatActions } from "@/lib/chat/actions"
import { ThreadStore } from "@/lib/chat/thread-store"

export const identity: Identity = { agent: "pi", terminalId: "t1", sessionId: "s", sessionFile: null, title: "my-project", cwd: "/work/my-project" }
export const noCaps: Capabilities = { send: true, stop: true, models: null, efforts: null }
export const fullCaps: Capabilities = {
  send: true,
  stop: true,
  models: { list: [{ id: "p/a", name: "Model A", reasoning: true }, { id: "p/b", name: "Model B", reasoning: false }], current: "p/a" },
  efforts: { list: ["off", "low", "high"], current: "low" },
}

export const user = (id: string, text = `question ${id}`): Row => ({ kind: "user", id, at: 1, text, images: 0 })
export const assistant = (id: string, text = `answer ${id}`, model: string | null = "p/a"): Row => ({ kind: "assistant", id, at: 2, text, model })
export const thinking = (id: string, text = `thoughts ${id}`): Row => ({ kind: "thinking", id, at: 2, text })
export const tool = (id: string, over: Partial<Extract<Row, { kind: "tool" }>> = {}): Row => ({
  kind: "tool", id, at: 3, callId: `call-${id}`, name: "bash", args: { command: "ls -la" }, argsTruncated: false, status: "ok",
  result: { text: "total 0\n", truncated: false, totalChars: 8 }, durationMs: 14, byUser: false, ...over,
})

export const live = (over: Partial<Live> = {}): Live => ({ ...EMPTY_LIVE, ...over })

export function snapshot(rows: Row[] = [], over: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
  return { seq: 1, identity, rows, hasMore: false, live: live(), capabilities: noCaps, ...over }
}

/** Updates arrive with the next `seq`; this keeps count. */
export function feeder(store: ThreadStore) {
  return (change: Omit<Extract<ThreadChange, { type: "update" }>, "seq" | "type">) => {
    const result = store.apply({ type: "update", seq: store.getState().seq + 1, ...change })
    store.flush()
    return result
  }
}

/** A store whose notifications are delivered by the test, standing in for animation frames. */
export function manualStore(snap: ThreadSnapshot) {
  const queue: Array<() => void> = []
  const store = new ThreadStore(snap, (run) => {
    queue.push(run)
    return () => {
      const i = queue.indexOf(run)
      if (i >= 0) queue.splice(i, 1)
    }
  })
  return { store, frame: () => queue.splice(0).forEach((f) => f()), pending: () => queue.length }
}

export function fakeActions(over: Partial<ChatActions> = {}): ChatActions & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {}
  const log = <T,>(name: string, result: T) => (...args: unknown[]) => {
    ;(calls[name] ??= []).push(args)
    return Promise.resolve(result)
  }
  return {
    calls,
    send: log("send", undefined),
    stop: log("stop", undefined),
    setModel: log("setModel", undefined),
    setEffort: log("setEffort", undefined),
    loadOlder: log("loadOlder", { rows: [] as Row[], hasMore: false }),
    fullToolResult: log("fullToolResult", "the whole result"),
    ...over,
  }
}
