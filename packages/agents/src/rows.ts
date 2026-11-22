// The thread a chat view renders: rows, live state, capabilities, identity, and the changes between
// snapshots. Browser-safe on purpose: this file imports nothing but zod, so the web app and
// packages/protocol can take it through the "@herdr-web/agents/rows" subpath.
import { z } from "zod"

/** Rows per page. The thread opens with the last page; older pages are asked for. */
export const PAGE_SIZE = 50
/** Characters of a tool result kept in its row. The rest is asked for with `toolResult`. */
export const TOOL_RESULT_CUT = 4000
/** Characters kept of one string inside a tool call's arguments (a `write` call can carry a file). */
export const TOOL_ARG_CUT = 1000

const At = z.number().nullable()

export const UserRowSchema = z.object({
  kind: z.literal("user"),
  id: z.string(),
  at: At,
  text: z.string(),
  /** Images attached to the message; their data is not carried. */
  images: z.number().int().nonnegative(),
})

export const AssistantRowSchema = z.object({
  kind: z.literal("assistant"),
  id: z.string(),
  at: At,
  text: z.string(),
  model: z.string().nullable(),
  /** The thinking level the session was at when the reply was written (`high`, `off`, …); null when the file does not say. */
  effort: z.string().nullable(),
})

export const ThinkingRowSchema = z.object({
  kind: z.literal("thinking"),
  id: z.string(),
  at: At,
  text: z.string(),
})

export const ToolStatusSchema = z.enum(["running", "ok", "error", "interrupted"])

export const ToolRowSchema = z.object({
  kind: z.literal("tool"),
  id: z.string(),
  at: At,
  callId: z.string(),
  name: z.string(),
  /** The call's arguments, with any string longer than TOOL_ARG_CUT cut (see `argsTruncated`). */
  args: z.record(z.string(), z.unknown()),
  argsTruncated: z.boolean(),
  /** `interrupted`: no result and the agent is no longer working (stopped, or pi went away). */
  status: ToolStatusSchema,
  result: z.object({ text: z.string(), truncated: z.boolean(), totalChars: z.number().int().nonnegative() }).nullable(),
  durationMs: z.number().nullable(),
  /** Run by the user with `!command` rather than by the model. */
  byUser: z.boolean(),
})

export const CompactionRowSchema = z.object({
  kind: z.literal("compaction"),
  id: z.string(),
  at: At,
  summary: z.string(),
  tokensBefore: z.number().nullable(),
})

export const NoticeRowSchema = z.object({
  kind: z.literal("notice"),
  id: z.string(),
  at: At,
  level: z.enum(["info", "warning", "error"]),
  text: z.string(),
})

/** The model was changed inside the session: `provider/id` of the new one. Not the model the session started with. */
export const ModelRowSchema = z.object({
  kind: z.literal("model"),
  id: z.string(),
  at: At,
  model: z.string(),
})

export const RowSchema = z.discriminatedUnion("kind", [
  UserRowSchema,
  AssistantRowSchema,
  ThinkingRowSchema,
  ToolRowSchema,
  CompactionRowSchema,
  NoticeRowSchema,
  ModelRowSchema,
])

export type UserRow = z.infer<typeof UserRowSchema>
export type AssistantRow = z.infer<typeof AssistantRowSchema>
export type ThinkingRow = z.infer<typeof ThinkingRowSchema>
export type ToolRow = z.infer<typeof ToolRowSchema>
export type CompactionRow = z.infer<typeof CompactionRowSchema>
export type NoticeRow = z.infer<typeof NoticeRowSchema>
export type ModelRow = z.infer<typeof ModelRowSchema>
export type Row = z.infer<typeof RowSchema>

export const PendingMessageSchema = z.object({
  id: z.string(),
  text: z.string(),
  /** `steer`: taken after the current tool or turn. `followUp`: taken when the agent is done. */
  mode: z.enum(["steer", "followUp"]),
})
export type PendingMessage = z.infer<typeof PendingMessageSchema>

/** What is happening now and is not a row yet. Always replaced as a whole. */
export const LiveSchema = z.object({
  working: z.boolean(),
  /** The reply being written, as accumulated so far. Null when none. */
  reply: z.object({ blocks: z.array(z.object({ kind: z.enum(["text", "thinking"]), text: z.string() })) }).nullable(),
  /** Tools that started and have not ended. Optional `argument`: pi-live may send a tool without it. */
  tools: z.array(z.object({ callId: z.string(), name: z.string(), argument: z.string().optional() })),
  /** Messages the user sent while the agent worked that it has not taken yet. */
  pending: z.array(PendingMessageSchema),
  usage: z.object({ tokens: z.number().nullable(), window: z.number(), percent: z.number().nullable() }).nullable(),
  /** One line the agent could not put in the session file, such as a failed compaction. */
  notice: z.object({ level: z.enum(["info", "warning", "error"]), text: z.string() }).nullable(),
})
export type Live = z.infer<typeof LiveSchema>

export const ModelOptionSchema = z.object({
  /** `provider/id`, the form `setModel` takes. */
  id: z.string(),
  name: z.string(),
  reasoning: z.boolean(),
})
export type ModelOption = z.infer<typeof ModelOptionSchema>

/** Each part may be null: the agent cannot do it, so the control is hidden. */
export const CapabilitiesSchema = z.object({
  send: z.boolean(),
  stop: z.boolean(),
  models: z.object({ list: z.array(ModelOptionSchema), current: z.string().nullable() }).nullable(),
  /** The levels the current model accepts. One level means there is nothing to choose. */
  efforts: z.object({ list: z.array(z.string()), current: z.string().nullable() }).nullable(),
  /** The sentence for why this agent cannot be chatted with (pi without chat, or with control off); absent or null when it can. The rows are still there. */
  disabled: z.string().nullable().optional(),
})
export type Capabilities = z.infer<typeof CapabilitiesSchema>

export const IdentitySchema = z.object({
  agent: z.string(),
  terminalId: z.string(),
  sessionId: z.string().nullable(),
  sessionFile: z.string().nullable(),
  title: z.string().nullable(),
  cwd: z.string().nullable(),
})
export type Identity = z.infer<typeof IdentitySchema>

/** What a subscription starts with. `rows` is the last page; `hasMore` says older ones exist. */
export const ThreadSnapshotSchema = z.object({
  seq: z.number().int().nonnegative(),
  identity: IdentitySchema,
  rows: z.array(RowSchema),
  hasMore: z.boolean(),
  live: LiveSchema,
  capabilities: CapabilitiesSchema,
})
export type ThreadSnapshot = z.infer<typeof ThreadSnapshotSchema>

/**
 * Changes after a snapshot, in `seq` order. An `update` carries any of its parts, applied together:
 * `rows` are upserts by id (a known id is replaced where it is, a new one goes at the end), and a
 * reply that just became a row arrives in the same update as the row, so there is never a moment
 * with both or neither. `reset` means the branch moved, so the snapshot replaces everything.
 */
export const ThreadChangeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("update"),
    seq: z.number().int().positive(),
    rows: z.array(RowSchema).optional(),
    live: LiveSchema.optional(),
    capabilities: CapabilitiesSchema.optional(),
    identity: IdentitySchema.optional(),
  }),
  z.object({ type: z.literal("reset"), seq: z.number().int().positive(), snapshot: ThreadSnapshotSchema }),
])
export type ThreadChange = z.infer<typeof ThreadChangeSchema>

export const EMPTY_LIVE: Live = { working: false, reply: null, tools: [], pending: [], usage: null, notice: null }
