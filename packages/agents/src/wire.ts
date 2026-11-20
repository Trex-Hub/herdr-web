// The lines spoken on the agents socket between the pi extension and the backend. One JSON object
// per line, every one carrying `v`. The extension cannot import this file (it may import only
// Node built-ins and pi's API), so it writes the same shapes by hand and a test holds the two
// together.
import os from "node:os"
import path from "node:path"
import { z } from "zod"

/** The one version both sides speak. A connection that says another is refused. */
export const WIRE_VERSION = 1
/** The longest line either side accepts. */
export const MAX_LINE_BYTES = 4 * 1024 * 1024

/** `$HERDR_WEB_AGENTS_SOCKET`, else `$XDG_STATE_HOME/herdr-web/agents.sock`, else `~/.local/state/…`. */
export function agentsSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HERDR_WEB_AGENTS_SOCKET) return env.HERDR_WEB_AGENTS_SOCKET
  const state = env.XDG_STATE_HOME || path.join(env.HOME || os.homedir(), ".local", "state")
  return path.join(state, "herdr-web", "agents.sock")
}

const V = z.literal(WIRE_VERSION)

const Level = z.enum(["info", "warning", "error"])

/** A model pi can switch to. `efforts` are the levels it accepts. */
export const WireModelSchema = z.object({
  provider: z.string(),
  id: z.string(),
  name: z.string(),
  reasoning: z.boolean(),
  efforts: z.array(z.string()),
})
export type WireModel = z.infer<typeof WireModelSchema>

// ---- extension → backend ---------------------------------------------------------------------

/** First line of every connection, and again on every new connection (pi reloads the extension on /new, /resume, /fork, /reload). */
export const HelloSchema = z.object({
  v: V,
  type: z.literal("hello"),
  agent: z.literal("pi"),
  terminalId: z.string().min(1),
  pid: z.number().int(),
  extension: z.string(),
  reason: z.string(),
  session: z.object({
    id: z.string().nullable(),
    file: z.string().nullable(),
    name: z.string().nullable(),
    cwd: z.string().nullable(),
  }),
})

/** The whole of what changes without a session entry. Sent after any change; the receiver replaces its copy. */
export const StateSchema = z.object({
  v: V,
  type: z.literal("state"),
  /** The session tree's current leaf. The file does not say (after `/tree` it does not move). */
  leafId: z.string().nullable(),
  model: z.object({ provider: z.string(), id: z.string(), name: z.string(), reasoning: z.boolean() }).nullable(),
  effort: z.string().nullable(),
  /** The levels the current model accepts. */
  efforts: z.array(z.string()),
  working: z.boolean(),
  pending: z.array(z.object({ id: z.string(), text: z.string(), mode: z.enum(["steer", "followUp"]) })),
  usage: z.object({ tokens: z.number().nullable(), window: z.number(), percent: z.number().nullable() }).nullable(),
  name: z.string().nullable(),
})

export const ModelsSchema = z.object({ v: V, type: z.literal("models"), list: z.array(WireModelSchema) })

/** The reply being written, accumulated; at most every 50 ms. An empty list means none. */
export const ReplySchema = z.object({
  v: V,
  type: z.literal("reply"),
  blocks: z.array(z.object({ kind: z.enum(["text", "thinking"]), text: z.string() })),
})

export const ToolEventSchema = z.object({
  v: V,
  type: z.literal("tool"),
  phase: z.enum(["start", "end"]),
  callId: z.string(),
  name: z.string(),
  /** The call's main argument (command, path, …), for the live line. Optional: an old extension sends without it. */
  argument: z.string().optional(),
  isError: z.boolean().optional(),
})

/** "Something was appended to the session file or the leaf moved; read it." Sent after pi has written. */
export const EntriesSchema = z.object({
  v: V,
  type: z.literal("entries"),
  leafId: z.string().nullable(),
  /** An assistant message just finished: its reply becomes rows. */
  replyDone: z.boolean(),
})

export const NoticeSchema = z.object({ v: V, type: z.literal("notice"), level: Level, text: z.string() })

export const ResultSchema = z.union([
  z.object({ v: V, type: z.literal("result"), id: z.string(), ok: z.literal(true) }),
  z.object({ v: V, type: z.literal("result"), id: z.string(), ok: z.literal(false), error: z.string() }),
])

export const ExtensionMessageSchema = z.union([
  HelloSchema,
  StateSchema,
  ModelsSchema,
  ReplySchema,
  ToolEventSchema,
  EntriesSchema,
  NoticeSchema,
  ResultSchema,
])
export type ExtensionMessage = z.infer<typeof ExtensionMessageSchema>
export type Hello = z.infer<typeof HelloSchema>
export type PiState = z.infer<typeof StateSchema>

// ---- backend → extension ---------------------------------------------------------------------

export const WelcomeSchema = z.object({ v: V, type: z.literal("welcome") })
export const RefusedSchema = z.object({ v: V, type: z.literal("refused"), reason: z.string() })

const ActionBase = { v: V, type: z.literal("action"), id: z.string() }

export const ActionSchema = z.discriminatedUnion("op", [
  z.object({ ...ActionBase, op: z.literal("send"), text: z.string() }),
  z.object({ ...ActionBase, op: z.literal("stop") }),
  z.object({ ...ActionBase, op: z.literal("set_model"), model: z.string() }),
  z.object({ ...ActionBase, op: z.literal("set_effort"), effort: z.string() }),
  /** Empty pi's input box, so a `/command` typed into the terminal is not appended to a draft. */
  z.object({ ...ActionBase, op: z.literal("clear_input") }),
])
export type Action = z.infer<typeof ActionSchema>

export const BackendMessageSchema = z.union([WelcomeSchema, RefusedSchema, ActionSchema])
export type BackendMessage = z.infer<typeof BackendMessageSchema>

/** One line, newline included. */
export function encodeLine(message: ExtensionMessage | BackendMessage): string {
  return JSON.stringify(message) + "\n"
}
