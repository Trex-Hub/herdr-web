import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { PiLiveChatMessage, PiLiveState, ThreadAction } from "../src/pi-live/wire.js"
import { PiThread, type PiThreadOptions } from "../src/pi/thread.js"
import type { ThreadChange } from "../src/rows.js"

export const FIXTURES = path.join(import.meta.dirname, "fixtures", "pi")

export function fixturePath(name: string): string {
  return path.join(FIXTURES, name)
}

/** Events recorded from a live pi, one per line. */
export function recordedEvents(name: string): { name: string; t: number; payload: any }[] {
  return fs
    .readFileSync(fixturePath(`events-${name}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

let counter = 0
/** A fresh folder under the OS temp dir (never the repo), for session files a test grows. */
export function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hw-agents-test-${process.pid}-${counter++}-`))
  return dir
}

/** Copy a recorded session into a folder of its own, so a test can append to it. */
export function copySession(name: string, dir = tmpDir()): string {
  const file = path.join(dir, `${name}.jsonl`)
  fs.copyFileSync(fixturePath(`session-${name}.jsonl`), file)
  return file
}

export function state(overrides: Partial<PiLiveState> = {}): PiLiveState {
  return {
    type: "state",
    leafId: null,
    model: { provider: "llama-swap", id: "local", name: "Local", reasoning: false },
    effort: "off",
    efforts: ["off"],
    working: false,
    pending: [],
    usage: null,
    name: null,
    ...overrides,
  }
}

export function ext<T extends PiLiveChatMessage>(message: T): T {
  return message
}

/** A thread on a session file, with what it sent to pi and what it told its subscribers. */
export function openThread(file: string | null, options: Partial<PiThreadOptions> = {}, initial: Partial<PiLiveState> = {}) {
  const sent: ThreadAction[] = []
  const changes: ThreadChange[] = []
  const thread = new PiThread({ terminalId: "t1", session: { id: "s-1", file, name: null, cwd: "/tmp/work" } }, { send: (m) => sent.push(m), actionTimeoutMs: 200, entryWaitMs: 150, ...options })
  thread.handle(state(initial))
  const snapshot = thread.snapshot()
  thread.subscribe((c) => changes.push(c))
  return { thread, sent, changes, snapshot }
}

export function appendEntries(file: string, ...entries: unknown[]): void {
  fs.appendFileSync(file, entries.map((e) => (typeof e === "string" ? e : JSON.stringify(e)) + "\n").join(""))
}

let idCounter = 0
export function userEntry(parentId: string | null, text: string, id = `u${++idCounter}`) {
  return { type: "message", id, parentId, timestamp: "2026-11-15T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } }
}
export function assistantEntry(parentId: string | null, blocks: unknown[], id = `a${++idCounter}`, extra: Record<string, unknown> = {}) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-11-15T10:00:01.000Z",
    message: { role: "assistant", content: blocks, provider: "p", model: "m", stopReason: "stop", timestamp: 2, ...extra },
  }
}
export function toolResultEntry(parentId: string | null, callId: string, text: string, isError = false, id = `r${++idCounter}`, name = "bash", details?: unknown) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-11-15T10:00:02.000Z",
    message: { role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text }], isError, timestamp: 3, ...(details !== undefined && { details }) },
  }
}
export const sessionHeader = { type: "session", version: 3, id: "s-1", timestamp: "2026-11-15T10:00:00.000Z", cwd: "/tmp/work" }
