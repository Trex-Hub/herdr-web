// Fixture threads for the development page. Rows are shaped like the ones the pi adapter builds from
// a session file (packages/agents/test/fixtures/pi); long text is written out here so every kind shows.
import { EMPTY_LIVE, type Capabilities, type Identity, type Live, type Row, type ThreadChange, type ThreadSnapshot, type ToolRow } from "@herdr-web/agents/rows"

export const identity: Identity = { agent: "pi", terminalId: "t17", sessionId: "s-1", sessionFile: null, title: "ayra-ventures · refactor the importer", cwd: "/Users/dev/Desktop/ayra-ventures/app" }

export const capabilities: Capabilities = {
  send: true,
  stop: true,
  models: {
    list: [
      { id: "llama-swap/zorro-davidau-3.8-flash-next", name: "Zorro 3.8 flash", reasoning: true },
      { id: "llama-swap/local", name: "Local", reasoning: false },
    ],
    current: "llama-swap/zorro-davidau-3.8-flash-next",
  },
  efforts: { list: ["off", "low", "medium", "high"], current: "medium" },
}

export const MODEL = "llama-swap/zorro-davidau-3.8-flash-next"
const T0 = 1_794_693_900_000

export const MARKDOWN_ANSWER = `The importer fails because \`parseRow\` assumes every line has a date. Here is what I changed:

## Changes

1. Skip blank lines before parsing.
2. Return \`null\` for a malformed date instead of throwing.
3. Count skipped rows and report them at the end.

\`\`\`ts
export function parseRow(line: string): Row | null {
  if (!line.trim()) return null
  const [date, amount] = line.split(",")
  const when = Date.parse(date ?? "")
  return Number.isNaN(when) ? null : { when, amount: Number(amount) }
}
\`\`\`

| File | Change | Lines |
|---|---|---|
| \`src/import.ts\` | tolerate bad dates | +12 −3 |
| \`src/report.ts\` | print skipped count | +6 |

See the [pi docs](https://example.com/docs) for the \`/compact\` command. Tests pass: \`pnpm test\` → **42 passed**.`

// Ids count up from the start of each thread built here, so the server and the browser build the same ids.
let n = 0
const id = (p: string) => `${p}-${++n}`

export const user = (text: string, extra: Partial<Extract<Row, { kind: "user" }>> = {}): Row => ({ kind: "user", id: id("u"), at: T0 + n * 1000, text, images: 0, ...extra })
export const assistant = (text: string, model: string | null = MODEL, effort: string | null = "medium"): Row => ({ kind: "assistant", id: id("a"), at: T0 + n * 1000, text, model, effort })
export const modelChange = (model: string): Row => ({ kind: "model", id: id("m"), at: T0 + n * 1000, model })
export const thinking = (text: string): Row => ({ kind: "thinking", id: id("th"), at: T0 + n * 1000, text })
export const tool = (name: string, args: Record<string, unknown>, status: ToolRow["status"], result: string | null, durationMs: number | null, extra: Partial<ToolRow> = {}): Row => ({
  kind: "tool",
  id: id("tool"),
  at: T0 + n * 1000,
  callId: `call-${n}`,
  name,
  args,
  argsTruncated: false,
  status,
  result: result === null ? null : { text: result, truncated: false, totalChars: result.length },
  durationMs,
  byUser: false,
  ...extra,
})

const usage: Live["usage"] = { tokens: 54_300, window: 128_000, percent: 42.4 }

export function snapshotOf(rows: Row[], over: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
  return { seq: 1, identity, rows, hasMore: false, live: { ...EMPTY_LIVE, usage }, capabilities, ...over }
}

/** Every row kind and state the view knows. */
export function everyKind(): ThreadSnapshot {
  n = 0
  const long = "line of output\n".repeat(400)
  return snapshotOf([
    user("The importer crashes on the March export. Can you find out why and fix it?"),
    thinking("The user says the importer crashes on one file. I should look at the parser first, then run it on the March export and read the error.\n"),
    tool("bash", { command: "pnpm --filter importer test -- --run march" }, "ok", "✓ 12 passed (1.3s)\n", 1342),
    tool("read", { path: "src/import.ts" }, "ok", "export function parseRow(line: string) {\n  const [date, amount] = line.split(',')\n  return { when: Date.parse(date), amount: Number(amount) }\n}\n", 14),
    tool("bash", { command: "node scripts/import.js exports/2026-03.csv" }, "error", "TypeError: Cannot read properties of undefined (reading 'split')\n    at parseRow (src/import.ts:2:30)\n\n\nCommand exited with code 1", 212),
    tool("grep", { pattern: "parseRow", path: "src" }, "ok", "src/import.ts:1\nsrc/report.ts:9\n", 31),
    tool("bash", { command: "sleep 600" }, "interrupted", null, null),
    tool("bash", { command: "cat build.log" }, "ok", long.slice(0, 4000), 40, { result: { text: long.slice(0, 4000), truncated: true, totalChars: long.length } }),
    tool("bash", { command: "git status --short" }, "ok", " M src/import.ts\n", 22, { byUser: true }),
    tool("edit", { path: "src/import.ts", oldText: "const [date, amount] = line.split(',')", newText: "if (!line.trim()) return null" }, "ok", "Edited src/import.ts", 9),
    thinking("Both fixes are small. The blank line is the real cause; a bad date should be skipped and counted."),
    assistant(MARKDOWN_ANSWER),
    user("Thanks. Here is the screenshot of the failing page.", { images: 2 }),
    { kind: "compaction", id: id("c"), at: T0 + n * 1000, summary: "## Goal\n- Fix the importer crash on the March export.\n\n## Done\n- Blank lines skipped, bad dates counted.", tokensBefore: 126_480 },
    { kind: "notice", id: id("n"), at: T0 + n * 1000, level: "info", text: "Stopped." },
    { kind: "notice", id: id("n"), at: T0 + n * 1000, level: "warning", text: "The model was slow to answer." },
    { kind: "notice", id: id("n"), at: T0 + n * 1000, level: "error", text: "Provider error: connection reset." },
    modelChange("anthropic/claude-sonnet"),
    user("Run the tests again."),
    assistant("All 42 tests pass.", "anthropic/claude-sonnet", "high"),
  ])
}

/** A thread of `turns` turns, four rows each (user, thinking, tool, assistant), for the smoothness measurement. */
export function longThread(turns: number): ThreadSnapshot {
  n = 0
  const rows: Row[] = []
  for (let i = 0; i < turns; i++) {
    rows.push(user(`Question ${i + 1}: how does step ${i + 1} of the pipeline behave when the input is empty?`))
    rows.push(thinking(`Looking at step ${i + 1}. It reads the input, checks its length, and returns early when it is empty.\n`))
    rows.push(tool("bash", { command: `grep -n "step${i + 1}" src/pipeline.ts` }, "ok", `src/pipeline.ts:${i + 10}: export function step${i + 1}(input) {\n`, 20 + (i % 50)))
    rows.push(assistant(`Step ${i + 1} returns early on empty input.\n\n\`\`\`ts\nexport function step${i + 1}(input: string[]) {\n  if (input.length === 0) return []\n  return input.map(run)\n}\n\`\`\`\n\nNothing else changes: the report still prints a header.`))
  }
  return snapshotOf(rows, { hasMore: false })
}

// ---- a recorded turn, played back ---------------------------------------------------------

const CHUNK = 6

export interface Step {
  /** Wait this long before applying the change. */
  after: number
  change: Omit<Extract<ThreadChange, { type: "update" }>, "seq" | "type">
}

const live = (over: Partial<Live>): Live => ({ ...EMPTY_LIVE, usage, ...over })

/** One turn as the adapter would send it: working, thinking written, a tool starts and ends, the reply is written, then it settles. */
export function turnSteps(prompt: string, answer: string, speed = 1): Step[] {
  const steps: Step[] = []
  const d = (ms: number) => Math.round(ms / speed)
  const userRow = user(prompt)
  const thinkingText = "The user wants to know how the importer behaves. I will read the parser, run it on the failing file, then explain.\n"
  const callId = `call-live-${++n}`
  const toolRow = (status: ToolRow["status"], result: string | null, durationMs: number | null): Row => ({ kind: "tool", id: `${callId}.row`, at: T0, callId, name: "bash", args: { command: "node scripts/import.js exports/2026-03.csv" }, argsTruncated: false, status, result: result === null ? null : { text: result, truncated: false, totalChars: result.length }, durationMs, byUser: false })
  steps.push({ after: d(100), change: { rows: [userRow], live: live({ working: true }) } })
  for (let i = CHUNK; i <= thinkingText.length + CHUNK - 1; i += CHUNK) {
    steps.push({ after: d(30), change: { live: live({ working: true, reply: { blocks: [{ kind: "thinking", text: thinkingText.slice(0, i) }] } }) } })
  }
  const thinkingRow = thinking(thinkingText)
  steps.push({ after: d(60), change: { rows: [thinkingRow], live: live({ working: true, tools: [{ callId, name: "bash", argument: "node scripts/import.js exports/2026-03.csv" }] }) } })
  steps.push({ after: d(900), change: { rows: [toolRow("ok", "Imported 118 rows, skipped 3.\n", 902)], live: live({ working: true }) } })
  for (let i = CHUNK; i <= answer.length + CHUNK - 1; i += CHUNK) {
    steps.push({ after: d(25), change: { live: live({ working: true, reply: { blocks: [{ kind: "text", text: answer.slice(0, i) }] } }) } })
  }
  steps.push({ after: d(60), change: { rows: [assistant(answer)], live: live({ working: false }) } })
  return steps
}
