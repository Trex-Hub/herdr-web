import type { Capabilities, Row, ThinkingRow, ToolRow } from "@herdr-web/agents/rows"
import { TOOLS_WITH_VIEW } from "./tool-views"

/** Keys that say what a tool call is about, in the order they are tried. */
const ARGUMENT_KEYS = ["command", "path", "file_path", "filePath", "pattern", "query", "url", "name"]

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? ""
  const trimmed = line.trim()
  // pi-live cuts the same argument at 200 for the live line; the web must too, so the two agree (test/chat/pi-live-agree.test.ts).
  return trimmed.length <= 200 ? trimmed : `${trimmed.slice(0, 199)}…`
}

/** The one argument that says what a tool call is about: the command, the path, the query. */
export function mainArgument(tool: Pick<ToolRow, "name" | "args">): string {
  return mainArgumentParts(tool).value
}

/** The value shown on a tool's line and the key it came from (so an expanded row can leave it out). */
export function mainArgumentParts(tool: Pick<ToolRow, "name" | "args">): { key: string; value: string } {
  const a = tool.args
  for (const key of ARGUMENT_KEYS) {
    const v = a[key]
    if (typeof v === "string" && v) return { key, value: firstLine(v) }
  }
  for (const [key, v] of Object.entries(a)) if (typeof v === "string" && v) return { key, value: firstLine(v) }
  return { key: "", value: "" }
}

/** One name per model: the display name from `capabilities.models.list`, else the id. */
export function modelName(models: NonNullable<Capabilities["models"]>["list"] | null | undefined, id: string): string {
  const byId = models?.find((m) => m.id === id)
  if (byId) return byId.name
  // ids may differ by provider prefix (`anthropic/claude` vs `claude`): match the part after `provider/`.
  const bare = id.replace(/^[^/]+\//, "")
  const byBare = models?.find((m) => m.id === bare || m.id.replace(/^[^/]+\//, "") === bare)
  return byBare ? byBare.name : id
}

/** `off` → `Off`, `high` → `High`. Only how the level is shown; what is sent to the agent is unchanged. */
export function capitalise(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1)
}

/** A one-line notice that is a single sentence is shown without its trailing period (`Stopped`). */
export function noticeText(text: string): string {
  const trimmed = text.trimEnd()
  if (trimmed.includes("\n") || !trimmed.endsWith(".")) return text
  // only the final period: anything earlier that ends a sentence keeps them all
  const body = trimmed.slice(0, -1)
  return /[.!?]/.test(body) ? text : body.trimEnd()
}

/** `14 ms`, `1.2 s`, `2 min 5 s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`
  const s = ms / 1000
  if (s < 10) return `${s.toFixed(1)} s`
  if (s < 60) return `${Math.round(s)} s`
  const m = Math.floor(s / 60)
  return `${m} min ${Math.round(s - m * 60)} s`
}

/** Whole seconds for the live elapsed clock: under a second is nothing, then `3 s` … `59 s`, then `1 min 5 s`. */
export function formatElapsedSeconds(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  if (s < 1) return ""
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  return `${m} min ${s - m * 60} s`
}

/** `1.2k`, `128k`, `1.5M`. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 100_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
}

/**
 * Pi's commands that open a picker or a screen of their own, so the answer is in the terminal.
 * From pi's docs/slash-commands.md; `/model` and `/thinking` do that only without an argument.
 */
const OPENS_PICKER = new Set([
  "settings", "scoped-models", "login", "logout", "llama", "resume", "tree", "fork", "mcp", "trust", "hotkeys", "changelog", "session", "share", "bug",
])
const PICKER_WITHOUT_ARGUMENT = new Set(["model", "thinking"])

export interface SlashCommand {
  name: string
  opensPicker: boolean
}

/**
 * pi's own commands, which the backend types into the terminal (the list in pi-live's protocol.md). `/compact` and `/name <name>`
 * are not among the ones typed: pi-live has an action for each. Any other `/text` is a message pi runs. The backend decides by
 * the same words (apps/backend/src/chat-operations.ts), case included; test/chat/slash-agree.test.ts keeps the lists together.
 */
export const TYPED_COMMANDS: ReadonlySet<string> = new Set([
  "settings", "model", "thinking", "scoped-models", "login", "logout", "llama", "new", "resume", "name", "session", "tree", "fork", "clone", "compact",
  "import", "copy", "export", "share", "bug", "trust", "mcp", "reload", "hotkeys", "changelog", "quit",
])

/** Null when the text is not a command that is typed into the terminal. */
export function parseSlash(text: string): SlashCommand | null {
  const m = /^\/([^\s/]+)(?:\s+(.*))?$/s.exec(text.trim())
  if (!m) return null
  const name = m[1]!
  const hasArgument = (m[2] ?? "").trim() !== ""
  if (!TYPED_COMMANDS.has(name) || name === "compact" || (name === "name" && hasArgument)) return null
  return { name, opensPicker: OPENS_PICKER.has(name) || (PICKER_WITHOUT_ARGUMENT.has(name) && !hasArgument) }
}

/** Rows that belong to the same turn as the one before them (what an assistant row's footer looks past). */
const WITHIN_TURN = new Set<Row["kind"]>(["thinking", "tool", "assistant"])

/**
 * Which assistant rows end a reply: the next row is not part of the same turn. The last row of the
 * thread counts unless the turn visibly goes on (`continuing`: reply text or a tool is live), so the
 * footer of the previous reply stays put while a new turn starts and its first row is on the way.
 */
export function replyEnds(rows: readonly Row[], continuing: boolean): Set<string> {
  const ends = new Set<string>()
  rows.forEach((row, i) => {
    if (row.kind !== "assistant") return
    const next = rows[i + 1]
    if (next ? !WITHIN_TURN.has(next.kind) : !continuing) ends.add(row.id)
  })
  return ends
}

// ---- groups of steps ---------------------------------------------------------------------------------------------

/** A run of two or more consecutive tool and thinking rows, shown as one line. Its id is its first row's id. */
export type GroupItem = { type: "group"; id: string; rows: ReadonlyArray<ToolRow | ThinkingRow> }
export type RowItem = { type: "row"; row: Row }
export type ThreadItem = RowItem | GroupItem

/** A step that can be folded into a group: a thought, or a tool that has no view of its own. */
const isStep = (r: Row): r is ToolRow | ThinkingRow => r.kind === "thinking" || (r.kind === "tool" && !TOOLS_WITH_VIEW.has(r.name))

/** The rows the page has, with each run of 2 or more steps made one group; a lone step, and every other row, stays a row. */
export function groupRows(rows: readonly Row[]): ThreadItem[] {
  const items: ThreadItem[] = []
  for (let i = 0; i < rows.length; ) {
    const row = rows[i]!
    if (!isStep(row)) {
      items.push({ type: "row", row })
      i++
      continue
    }
    let j = i
    while (j < rows.length && isStep(rows[j]!)) j++
    const run = rows.slice(i, j) as Array<ToolRow | ThinkingRow>
    items.push(run.length >= 2 ? { type: "group", id: run[0]!.id, rows: run } : { type: "row", row })
    i = j
  }
  return items
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** "Thought, ran 5 commands, read 1 file": counts by kind of step, in order of first appearance. */
export function groupSummary(rows: ReadonlyArray<ToolRow | ThinkingRow>): string {
  const counts = new Map<string, number>()
  for (const r of rows) {
    const key = r.kind === "thinking" ? "thought" : r.name === "bash" ? "bash" : r.name === "read" ? "read" : r.name === "edit" || r.name === "write" ? "edit" : r.name === "grep" || r.name === "find" || r.name === "ls" ? "search" : `other:${r.name}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const parts = [...counts].map(([key, n]) => {
    if (key === "thought") return "thought"
    if (key === "bash") return `ran ${plural(n, "command", "commands")}`
    if (key === "read") return `read ${plural(n, "file", "files")}`
    if (key === "edit") return `edited ${plural(n, "file", "files")}`
    if (key === "search") return `searched ${n === 1 ? "once" : n === 2 ? "twice" : `${n} times`}`
    return `used ${key.slice("other:".length)}${n > 1 ? ` × ${n}` : ""}`
  })
  const text = parts.join(", ")
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** What the group line shows at its right: the failed and stopped steps, and the summed duration of those that have one. */
export function groupMeta(rows: ReadonlyArray<ToolRow | ThinkingRow>): { failed: number; stopped: number; durationMs: number | null } {
  let failed = 0
  let stopped = 0
  let durationMs: number | null = null
  for (const r of rows) {
    if (r.kind !== "tool") continue
    if (r.status === "error") failed++
    if (r.status === "interrupted") stopped++
    if (r.durationMs !== null) durationMs = (durationMs ?? 0) + r.durationMs
  }
  return { failed, stopped, durationMs }
}
