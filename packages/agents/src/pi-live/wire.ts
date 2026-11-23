// What a pi-live 0.2 socket says to a chat client, and what the client says back. The contract is
// pi-live's docs/protocol.md; this file reads only the parts herdr-web uses and ignores the rest
// (unknown fields are dropped, unknown message types are not messages here). Node-free, like rows.ts.
import { z } from "zod"

/** The one protocol version this client speaks. */
export const PI_LIVE_PROTOCOL = 1
/** The longest line read from a pi-live socket. pi-live puts no limit on what it sends. */
export const PI_LIVE_MAX_LINE_BYTES = 64 * 1024 * 1024
/** The longest line pi-live accepts from a client; it closes the connection on a longer one. */
export const PI_LIVE_MAX_SEND_BYTES = 1024 * 1024

const Level = z.enum(["info", "warning", "error"])

/** A model pi can switch to. `efforts` are the levels it accepts. */
export const PiLiveModelSchema = z.object({
  provider: z.string(),
  id: z.string(),
  name: z.string(),
  reasoning: z.boolean(),
  efforts: z.array(z.string()).default([]),
})
export type PiLiveModel = z.infer<typeof PiLiveModelSchema>

const StateFields = {
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
}
/** The whole of what changes without a session entry. `waitingForUser` is not read. */
export const PiLiveStateSchema = z.object({ type: z.literal("state"), ...StateFields })
export type PiLiveState = z.infer<typeof PiLiveStateSchema>

export const PiLiveModelsSchema = z.object({ type: z.literal("models"), list: z.array(PiLiveModelSchema) })

const Block = z.object({ kind: z.enum(["text", "thinking"]), text: z.string() })
/** The reply being written, whole so far. An empty list means none. */
export const PiLiveReplySchema = z.object({ type: z.literal("reply"), blocks: z.array(Block) })

export const PiLiveToolSchema = z.object({
  type: z.literal("tool"),
  phase: z.enum(["start", "end"]),
  callId: z.string(),
  name: z.string(),
  argument: z.string().optional(),
  isError: z.boolean().optional(),
})

/** "Something was appended to the session file or the leaf moved; read it." */
export const PiLiveEntriesSchema = z.object({ type: z.literal("entries"), leafId: z.string().nullable(), replyDone: z.boolean() })

export const PiLiveNoticeSchema = z.object({ type: z.literal("notice"), level: Level, text: z.string() })

/** The chat messages a Thread is fed with, as pi-live sends them (`welcome.chat` is made of the same parts). */
export const PiLiveChatMessageSchema = z.discriminatedUnion("type", [
  PiLiveStateSchema,
  PiLiveModelsSchema,
  PiLiveReplySchema,
  PiLiveToolSchema,
  PiLiveEntriesSchema,
  PiLiveNoticeSchema,
])
export type PiLiveChatMessage = z.infer<typeof PiLiveChatMessageSchema>

export const PiLiveSessionSchema = z.object({
  id: z.string(),
  file: z.string().optional(),
  cwd: z.string().optional(),
  pid: z.number().int(),
  mode: z.string().optional(),
  terminal: z.string().optional(),
  name: z.string().optional(),
})
export type PiLiveSession = z.infer<typeof PiLiveSessionSchema>

/** The first picture of a chat client: the parts, without `type`. `commands` and `items` are not read. */
export const PiLiveSnapshotSchema = z.object({
  state: z.object(StateFields),
  models: z.array(PiLiveModelSchema),
  reply: z.object({ blocks: z.array(Block) }),
  tools: z.array(z.object({ callId: z.string(), name: z.string(), argument: z.string().optional() })),
})

/** A parked wait (an open prompt), as pi-live lists and announces it. `view` and `owner`'s meaning are the parker's own. */
export const PiLiveItemSchema = z.object({
  id: z.string(),
  owner: z.string(),
  kind: z.string(),
  title: z.string(),
  view: z.unknown(),
  openedAt: z.number(),
  expiresAt: z.number().nullish(),
})
export type PiLiveItem = z.infer<typeof PiLiveItemSchema>

export const PiLiveItemOpenedSchema = z.object({ type: z.literal("item_opened"), item: z.unknown() })
export const PiLiveItemClosedSchema = z.object({ type: z.literal("item_closed"), id: z.string() })

export const PiLiveAnswerResultSchema = z.object({
  type: z.literal("answer_result"),
  reqId: z.string(),
  id: z.string(),
  status: z.enum(["delivered", "invalid", "closed", "not_found"]),
  reason: z.string().optional(),
})

export const PiLiveWelcomeSchema = z.object({
  type: z.literal("welcome"),
  protocol: z.number(),
  version: z.string().optional(),
  features: z.array(z.string()).optional(),
  control: z.boolean().optional(),
  session: PiLiveSessionSchema,
  /** Open items, oldest first. Each is read on its own, so one that is odd does not spoil the welcome. */
  items: z.array(z.unknown()).optional(),
  chat: PiLiveSnapshotSchema.optional(),
})
export type PiLiveWelcome = z.infer<typeof PiLiveWelcomeSchema>

export const PiLiveActionResultSchema = z.union([
  z.object({ type: z.literal("action_result"), reqId: z.string(), ok: z.literal(true) }),
  z.object({ type: z.literal("action_result"), reqId: z.string(), ok: z.literal(false), error: z.string() }),
])

export const PiLiveGoodbyeSchema = z.object({
  type: z.literal("goodbye"),
  reason: z.string().optional(),
  shutdown: z.string().optional(),
})

/** What the thread asks of pi: the fields of an `action`, before an id is put on it. */
export type PiLiveOp =
  | { op: "send"; text: string; deliverAs?: "steer" | "followUp" }
  | { op: "stop" }
  | { op: "set_model"; model: string }
  | { op: "set_effort"; effort: string }
  | { op: "set_name"; name: string }
  | { op: "compact"; instructions?: string }
  | { op: "clear_input" }

/** An answer as the thread hands it to its transport: `reqId` is ours, `id` the item's. */
export interface ThreadAnswer {
  reqId: string
  id: string
  answer: unknown
}

/** An action as the thread hands it to its transport, which puts it on the wire. */
export type ThreadAction = { type: "action"; id: string } & PiLiveOp

/**
 * pi's own slash commands, as pi-live's protocol.md lists them: pi-live refuses these in `send` (they open pi's own screens), so a
 * composer that starts with one of them goes to the terminal, except `/compact` and `/name`, which have actions of their own.
 */
export const PI_BUILTIN_COMMANDS: readonly string[] = "settings model thinking scoped-models login logout llama new resume name session tree fork clone compact import copy export share bug trust mcp reload hotkeys changelog quit".split(" ")
