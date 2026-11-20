import type { Capabilities, Row, ToolRow } from "@herdr-web/agents/rows"

/** The one argument that says what a tool call is about: the command, the path, the query. */
export function mainArgument(tool: Pick<ToolRow, "name" | "args">): string {
  const a = tool.args
  for (const key of ["command", "path", "file_path", "filePath", "pattern", "query", "url", "name"]) {
    const v = a[key]
    if (typeof v === "string" && v) return firstLine(v)
  }
  for (const v of Object.values(a)) if (typeof v === "string" && v) return firstLine(v)
  return ""
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? ""
  return line.trim()
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

/** Null when the text is not a slash command. */
export function parseSlash(text: string): SlashCommand | null {
  const m = /^\/([^\s/]+)(?:\s+(.*))?$/s.exec(text.trim())
  if (!m) return null
  const name = m[1]!.toLowerCase()
  const hasArgument = (m[2] ?? "").trim() !== ""
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
