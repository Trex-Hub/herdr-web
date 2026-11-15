// Session entries on the active branch → rows. Pure: the same entries give the same rows with the
// same ids. A row's id is its entry's id, plus `.<n>` for the n-th block of an assistant message.
import { TOOL_ARG_CUT, TOOL_RESULT_CUT, type Row, type ToolRow } from "../rows.js"
import { isRecord, type Entry } from "./session-log.js"

export interface BuiltRows {
  rows: Row[]
  /** Tool row id → the entry holding its full result. */
  resultEntry: Map<string, Entry>
}

/** What the walk down the branch has seen so far that later entries depend on. */
interface Walk {
  /** The thinking level in force; null until a `thinking_level_change` entry. */
  effort: string | null
  /** The model of the latest `model_change` entry; null until the first, which is the session's start and is not shown. */
  model: string | null
}

export function buildRows(path: Entry[], broken: number[], working: boolean, unreadable: string | null = null): BuiltRows {
  const walk: Walk = { effort: null, model: null }
  // Pieces keyed by file line, so unreadable lines land where they sit in the file.
  const pieces: { line: number; rows: Row[] }[] = []
  const toolRows = new Map<string, ToolRow>()
  const resultEntry = new Map<string, Entry>()

  for (const entry of path) {
    let rows: Row[]
    try {
      rows = entryRows(entry, toolRows, resultEntry, walk)
    } catch {
      rows = [{ kind: "notice", id: `${entry.id}.error`, at: at(entry), level: "warning", text: "This part of the session file could not be shown." }]
    }
    pieces.push({ line: entry.line, rows })
  }
  for (const line of broken) {
    pieces.push({ line, rows: [{ kind: "notice", id: `broken:${line}`, at: null, level: "warning", text: `Line ${line} of the session file could not be read.` }] })
  }
  // Stable sort: path order is kept, a broken line goes before the first entry written after it.
  const placed: { line: number; rows: Row[] }[] = []
  const pathPieces = pieces.slice(0, path.length)
  const brokenPieces = pieces.slice(path.length)
  let b = 0
  const sortedBroken = brokenPieces.sort((x, y) => x.line - y.line)
  for (const piece of pathPieces) {
    while (b < sortedBroken.length && sortedBroken[b]!.line < piece.line) placed.push(sortedBroken[b++]!)
    placed.push(piece)
  }
  while (b < sortedBroken.length) placed.push(sortedBroken[b++]!)

  if (unreadable) placed.unshift({ line: 0, rows: [{ kind: "notice", id: "unreadable", at: null, level: "warning", text: unreadable }] })

  for (const tool of toolRows.values()) {
    if (tool.status === "running" && !working) tool.status = "interrupted"
  }
  return { rows: placed.flatMap((p) => p.rows), resultEntry }
}

function entryRows(entry: Entry, toolRows: Map<string, ToolRow>, resultEntry: Map<string, Entry>, walk: Walk): Row[] {
  switch (entry.type) {
    case "message":
      return messageRows(entry, toolRows, resultEntry, walk)
    case "thinking_level_change":
      walk.effort = typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : walk.effort
      return []
    case "model_change": {
      if (typeof entry.modelId !== "string") return []
      const model = typeof entry.provider === "string" ? `${entry.provider}/${entry.modelId}` : entry.modelId
      const previous = walk.model
      walk.model = model
      // The first one is how the session started; choosing the model already in use writes an entry too.
      if (previous === null || previous === model) return []
      return [{ kind: "model", id: entry.id, at: at(entry), model }]
    }
    case "compaction":
      return [
        {
          kind: "compaction",
          id: entry.id,
          at: at(entry),
          summary: typeof entry.summary === "string" ? entry.summary : "",
          tokensBefore: typeof entry.tokensBefore === "number" ? entry.tokensBefore : null,
        },
      ]
    case "branch_summary":
      return [
        {
          kind: "notice",
          id: entry.id,
          at: at(entry),
          level: "info",
          text: `Summary of the branch left: ${typeof entry.summary === "string" ? entry.summary : ""}`,
        },
      ]
    case "custom_message":
      // `display: false` is context for the model only.
      if (entry.display !== true) return []
      return [{ kind: "notice", id: entry.id, at: at(entry), level: "info", text: contentText(entry.content).text }]
    default:
      // usage, custom, label, session_info, context_edit, …
      return []
  }
}

function messageRows(entry: Entry, toolRows: Map<string, ToolRow>, resultEntry: Map<string, Entry>, walk: Walk): Row[] {
  const message = entry.message
  if (!isRecord(message) || typeof message.role !== "string") throw new Error("no message")
  switch (message.role) {
    case "user": {
      const { text, images } = contentText(message.content)
      return [{ kind: "user", id: entry.id, at: at(entry), text, images }]
    }
    case "assistant":
      return assistantRows(entry, message, toolRows, walk.effort)
    case "toolResult": {
      const callId = typeof message.toolCallId === "string" ? message.toolCallId : ""
      const row = toolRows.get(callId)
      const result = cutText(contentText(message.content).text, TOOL_RESULT_CUT)
      const isError = message.isError === true
      const durationMs = typeof message.durationMs === "number" ? message.durationMs : null
      if (row) {
        row.result = result
        row.status = isError ? "error" : "ok"
        row.durationMs = durationMs
        resultEntry.set(row.id, entry)
        return []
      }
      // A result whose call is not on this branch: show it alone rather than lose it.
      const orphan: ToolRow = {
        kind: "tool",
        id: entry.id,
        at: at(entry),
        callId,
        name: typeof message.toolName === "string" ? message.toolName : "tool",
        args: {},
        argsTruncated: false,
        status: isError ? "error" : "ok",
        result,
        durationMs,
        byUser: false,
      }
      resultEntry.set(orphan.id, entry)
      return [orphan]
    }
    case "bashExecution": {
      const output = typeof message.output === "string" ? message.output : ""
      const failed = message.cancelled === true || (typeof message.exitCode === "number" && message.exitCode !== 0)
      const row: ToolRow = {
        kind: "tool",
        id: entry.id,
        at: at(entry),
        callId: entry.id,
        name: "bash",
        args: { command: typeof message.command === "string" ? message.command : "" },
        argsTruncated: false,
        status: failed ? "error" : "ok",
        result: cutText(output, TOOL_RESULT_CUT),
        durationMs: null,
        byUser: true,
      }
      resultEntry.set(row.id, entry)
      return [row]
    }
    case "custom":
      return message.display === true ? [{ kind: "notice", id: entry.id, at: at(entry), level: "info", text: contentText(message.content).text }] : []
    default:
      // system, compactionSummary, branchSummary: not conversation.
      return []
  }
}

function assistantRows(entry: Entry, message: Record<string, unknown>, toolRows: Map<string, ToolRow>, effort: string | null): Row[] {
  const rows: Row[] = []
  const model = typeof message.model === "string" ? (typeof message.provider === "string" ? `${message.provider}/${message.model}` : message.model) : null
  const blocks = Array.isArray(message.content) ? message.content : []
  blocks.forEach((block: unknown, index: number) => {
    if (!isRecord(block)) return
    const id = `${entry.id}.${index}`
    if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
      rows.push({ kind: "assistant", id, at: at(entry), text: block.text, model, effort })
    } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim() !== "") {
      rows.push({ kind: "thinking", id, at: at(entry), text: block.thinking })
    } else if (block.type === "toolCall" && typeof block.id === "string") {
      const { value, truncated } = cutArgs(block.arguments)
      const row: ToolRow = {
        kind: "tool",
        id,
        at: at(entry),
        callId: block.id,
        name: typeof block.name === "string" ? block.name : "tool",
        args: value,
        argsTruncated: truncated,
        status: "running",
        result: null,
        durationMs: null,
        byUser: false,
      }
      toolRows.set(block.id, row)
      rows.push(row)
    }
  })
  if (message.stopReason === "aborted") {
    rows.push({ kind: "notice", id: `${entry.id}.stop`, at: at(entry), level: "info", text: "Stopped." })
  } else if (message.stopReason === "error") {
    const why = typeof message.errorMessage === "string" && message.errorMessage ? message.errorMessage : "The model returned an error."
    rows.push({ kind: "notice", id: `${entry.id}.stop`, at: at(entry), level: "error", text: why })
  }
  return rows
}

function at(entry: Entry): number | null {
  if (typeof entry.timestamp !== "string") return null
  const ms = Date.parse(entry.timestamp)
  return Number.isNaN(ms) ? null : ms
}

/** The text of user, tool-result or custom content: a string, or blocks of which text ones count. */
export function contentText(content: unknown): { text: string; images: number } {
  if (typeof content === "string") return { text: content, images: 0 }
  if (!Array.isArray(content)) return { text: "", images: 0 }
  const parts: string[] = []
  let images = 0
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text)
    else if (block.type === "image") images++
  }
  return { text: parts.join("\n"), images }
}

/** Cut `text` to at most `max` characters without splitting a surrogate pair. */
export function cutText(text: string, max: number): { text: string; truncated: boolean; totalChars: number } {
  if (text.length <= max) return { text, truncated: false, totalChars: text.length }
  let end = max
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end--
  return { text: text.slice(0, end), truncated: true, totalChars: text.length }
}

function cutArgs(args: unknown): { value: Record<string, unknown>; truncated: boolean } {
  if (!isRecord(args)) return { value: {}, truncated: false }
  let truncated = false
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") {
      const cut = cutText(v, TOOL_ARG_CUT)
      if (cut.truncated) truncated = true
      return cut.text
    }
    if (depth > 6) return null
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1))
    if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, depth + 1)]))
    return v
  }
  return { value: walk(args, 0) as Record<string, unknown>, truncated }
}
