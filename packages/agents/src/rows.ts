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
/** Characters of JSON kept of a row's `details` (a tool result's, a custom message's); above this the row carries none. */
export const DETAILS_CUT = 16_000

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
  /** The tool result's `details`, carried only for `ask_user` (the answer is in it), the pi-link tools and `todo` (its tasks, trimmed), and left out above DETAILS_CUT. */
  details: z.unknown().optional(),
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
  /** For a message an extension showed (a `custom_message`): its `customType`, such as `link` for pi-link. */
  source: z.string().optional(),
  /** That message's `details`, left out above DETAILS_CUT. */
  details: z.unknown().optional(),
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

// --- ask_user prompts (pi-live items) -----------------------------------------------------------

export const AskOptionSchema = z.object({ title: z.string(), description: z.string().optional() })

/** Not `.strict()`: pi-ask-user may add fields to a view. */
export const AskQuestionViewSchema = z.object({
  question: z.string(),
  context: z.string().optional(),
  options: z.array(AskOptionSchema),
  allowMultiple: z.boolean(),
  allowFreeform: z.boolean(),
  allowComment: z.boolean(),
})

export const AskBatchViewSchema = z.object({
  heading: z.string().optional(),
  allowComment: z.boolean(),
  questions: z.array(AskQuestionViewSchema.omit({ allowComment: true })),
})

/** A prompt that is open now. `id` is the `ask_user` tool call's id, so it matches the tool's row and live tool. */
export const AskSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), kind: z.literal("ask_user.question"), title: z.string(), view: AskQuestionViewSchema, openedAt: z.number(), expiresAt: z.number().nullable() }),
  z.object({ id: z.string(), kind: z.literal("ask_user.batch"), title: z.string(), view: AskBatchViewSchema, openedAt: z.number(), expiresAt: z.number().nullable() }),
])
export type Ask = z.infer<typeof AskSchema>

/** What the app sends to answer a question; for building answers type-safely. The backend does not check them: pi-ask-user does. */
export const AskResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("selection"), selections: z.array(z.string()), comment: z.string().optional() }),
  z.object({ kind: z.literal("freeform"), text: z.string() }),
])
export type AskResponse = z.infer<typeof AskResponseSchema>

/** One entry of a batch's answers: answered, or skipped. */
export const AskBatchAnswerSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("answered"), response: AskResponseSchema }),
  z.object({ status: z.literal("skipped") }),
])
export type AskBatchAnswer = z.infer<typeof AskBatchAnswerSchema>

/** One answer a guardrails prompt offers, as it offers it. `result` is what is sent back; a disabled one says why. */
export const ApprovalOptionSchema = z.object({
  result: z.string(),
  label: z.string(),
  disabled: z.boolean().optional(),
  disabledReason: z.string().optional(),
})
export type ApprovalOption = z.infer<typeof ApprovalOptionSchema>

/** Which tool call a prompt is about. A call made by another tool (codemode) has an id that is never a row: the parent's is. */
const ApprovalCallFields = {
  toolCallId: z.string().optional(),
  parentToolCallId: z.string().optional(),
}

export const ApprovalCommandViewSchema = z.object({
  ...ApprovalCallFields,
  toolName: z.string(),
  /** Raw and whole: what runs. */
  command: z.string(),
  reason: z.string(),
  options: z.array(ApprovalOptionSchema),
})

export const ApprovalPathViewSchema = z.object({
  ...ApprovalCallFields,
  toolName: z.string(),
  /** Absolute. */
  path: z.string(),
  displayPath: z.string(),
  /** What a directory grant covers. */
  directory: z.string(),
  cwd: z.string(),
  target: z.enum(["file", "directory"]),
  /** The raw shell command, when a shell tool asked. */
  command: z.string().optional(),
  reason: z.string(),
  alwaysSavedTo: z.enum(["project", "global"]),
  options: z.array(ApprovalOptionSchema),
})

/** A guardrails prompt that is open now: a dangerous command, or a path outside the workspace. `id` is the prompt's own. */
export const ApprovalSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), kind: z.literal("guardrails.command"), title: z.string(), view: ApprovalCommandViewSchema, openedAt: z.number() }),
  z.object({ id: z.string(), kind: z.literal("guardrails.path"), title: z.string(), view: ApprovalPathViewSchema, openedAt: z.number() }),
])
export type Approval = z.infer<typeof ApprovalSchema>

/**
 * A guardrails prompt that has closed, kept for the line under its call. `by`: `client` answered from a chat (`result` and
 * `label` are known when it was this app), `keyboard` in the terminal, `abort` the agent was stopped (it ends as deny),
 * `error`, `shutdown`, or `gone` when pi left without saying.
 */
export const ApprovalRecordSchema = z.object({
  id: z.string(),
  kind: z.enum(["guardrails.command", "guardrails.path"]),
  /** The row the line goes under: the parent's call for a nested one. Null when the prompt did not say. */
  callId: z.string().nullable(),
  /** The command's first line, or the path, cut to a line. */
  subject: z.string(),
  by: z.enum(["client", "keyboard", "abort", "error", "shutdown", "gone"]),
  result: z.string().nullable(),
  label: z.string().nullable(),
})
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>

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
  /** Open `ask_user` prompts, oldest first. */
  asks: z.array(AskSchema),
  /** One of pi's own dialogs is open (a confirm, a picker, an extension's form, `ask_user` too) and only the terminal can answer it. Null when none. */
  waiting: z.object({ kind: z.string(), title: z.string().nullable() }).nullable(),
  /** Open guardrails prompts, oldest first. Absent from an older backend: none. */
  approvals: z.array(ApprovalSchema).default([]),
  /** Guardrails prompts that closed while this backend watched, newest last, at most `APPROVAL_RECORDS`. */
  approved: z.array(ApprovalRecordSchema).default([]),
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

// --- the agent's todo list (the `todo` tool of @juicesharp/rpiv-todo) -----------------------------

export const TodoStatusSchema = z.enum(["pending", "in_progress", "completed"])

export const TodoTaskSchema = z.object({
  id: z.number().int(),
  subject: z.string(),
  /** The present-continuous label the agent gave the task for while it is in progress. */
  activeForm: z.string().optional(),
  status: TodoStatusSchema,
  /** Ids of the tasks this one waits for. */
  blockedBy: z.array(z.number().int()).optional(),
})

/**
 * The list as the agent last wrote it, without the tasks it deleted: always the whole list, replaced as a
 * whole, never a delta. The thread carries it apart from the rows, since the call that wrote it may be
 * on an older page than the one held.
 */
export const TodosSchema = z.object({ tasks: z.array(TodoTaskSchema) })
export type TodoTask = z.infer<typeof TodoTaskSchema>
export type Todos = z.infer<typeof TodosSchema>

/** What a subscription starts with. `rows` is the last page; `hasMore` says older ones exist. */
export const ThreadSnapshotSchema = z.object({
  seq: z.number().int().nonnegative(),
  identity: IdentitySchema,
  rows: z.array(RowSchema),
  hasMore: z.boolean(),
  live: LiveSchema,
  capabilities: CapabilitiesSchema,
  /** The agent's todo list; null or absent when it has none to show. */
  todos: TodosSchema.nullable().optional(),
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
    /** The whole list as it is now, or null when there is none to show any more. */
    todos: TodosSchema.nullable().optional(),
  }),
  z.object({ type: z.literal("reset"), seq: z.number().int().positive(), snapshot: ThreadSnapshotSchema }),
])
export type ThreadChange = z.infer<typeof ThreadChangeSchema>

export const EMPTY_LIVE: Live = { working: false, reply: null, tools: [], pending: [], usage: null, notice: null, asks: [], waiting: null, approvals: [], approved: [] }

/** How many closed guardrails prompts `live.approved` keeps. */
export const APPROVAL_RECORDS = 30
