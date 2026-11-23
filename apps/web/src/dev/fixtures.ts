// Fixture threads for the development page. Rows are shaped like the ones the pi adapter builds from
// a session file (packages/agents/test/fixtures/pi); long text is written out here so every kind shows.
import { EMPTY_LIVE, type Ask, type Capabilities, type Identity, type Live, type Row, type ThreadChange, type ThreadSnapshot, type ToolRow } from "@herdr-web/agents/rows"

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
    tool("web_fetch", { url: "https://example.com/csv-spec" }, "ok", "200 OK\n", 380),
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

// ---- ask_user ------------------------------------------------------------------------------------------------------

export type AskMode = "lines" | "single" | "multiple" | "comment" | "freeform" | "batch" | "context" | "two"
export const ASK_MODES: readonly AskMode[] = ["lines", "single", "multiple", "comment", "freeform", "batch", "context", "two"]

const COLORS = [{ title: "Green", description: "the calm one" }, { title: "Blue" }, { title: "Red", description: "loud, and it prints in the logs" }]
const CONTEXT = "# Context\n\nThe importer has **three** ways to read a date:\n\n- `Date.parse`, which is lenient\n- a strict ISO parser\n- the locale parser, which depends on the machine\n\n## Trade-offs\n\nLenient accepts `3/4/26` and reads it as March in one locale and April in another.\n\n```ts\nDate.parse(\"3/4/26\")\n```\n\nThe strict one rejects it and the row is skipped.\n\nNothing else depends on this choice, and it can be changed later."

type QuestionView = Extract<Ask, { kind: "ask_user.question" }>["view"]
const questionAsk = (id: string, view: Partial<QuestionView> = {}, extra: Partial<Ask> = {}): Ask => ({
  id,
  kind: "ask_user.question",
  title: "Which color?",
  view: { question: "Which color should the report header be?", options: COLORS, allowMultiple: false, allowFreeform: true, allowComment: false, ...view },
  openedAt: T0,
  expiresAt: null,
  ...extra,
}) as Ask
const batchAsk = (id: string): Ask => ({
  id,
  kind: "ask_user.batch",
  title: "Project setup",
  view: {
    heading: "Project setup",
    allowComment: false,
    questions: [
      { question: "What channel(s) do you want to use for cold outreach?", options: [{ title: "Email only", description: "Cold email sequences via Gmail with follow-ups" }, { title: "LinkedIn + Email", description: "LinkedIn outreach via Chrome automation + email follow-ups" }, { title: "Email + Calendar", description: "Cold emails that include calendar booking links for meetings" }], allowMultiple: false, allowFreeform: true },
      { question: "Which checks should run?", options: [{ title: "lint" }, { title: "test" }, { title: "types" }], allowMultiple: true, allowFreeform: false },
      { question: "Anything else?", options: [], allowMultiple: false, allowFreeform: true },
    ],
  },
  openedAt: T0,
  expiresAt: null,
})

const askRow = (callId: string, args: Record<string, unknown>, status: ToolRow["status"], result: string | null, details?: unknown): Row =>
  tool("ask_user", args, status, result, status === "running" ? null : 4200, { callId, ...(details !== undefined && { details }) })
const colorArgs = { question: "Which color should the report header be?", options: ["Green", "Blue", "Red"] }
const colorDetails = (response: unknown, cancelled = false) => ({ question: colorArgs.question, options: COLORS, response, cancelled })

/** A thread with `ask_user` calls: every way a finished one reads, or an open one in the mode given (the panel replaces the composer). */
export function asksThread(mode: AskMode): ThreadSnapshot {
  n = 0
  const head = [user("Set up the importer for the new export format."), assistant("I need a few decisions before I change anything.")]
  if (mode === "lines") {
    const batch = batchAsk("x") as Extract<Ask, { kind: "ask_user.batch" }>
    const batchArgs = { heading: "Project setup", questions: batch.view.questions }
    return snapshotOf(
      [
        ...head,
        askRow("c-1", colorArgs, "ok", "User answered: Green", colorDetails({ kind: "selection", selections: ["Green"] })),
        askRow("c-2", colorArgs, "ok", "User answered: Teal", colorDetails({ kind: "freeform", text: "Teal" })),
        askRow("c-3", colorArgs, "ok", "User answered: Blue", colorDetails({ kind: "selection", selections: ["Blue"], comment: "it matches the logo" })),
        askRow("c-4", batchArgs, "ok", "User answered: 2 of 3", { kind: "batch", questions: batch.view.questions, answers: [{ status: "answered", response: { kind: "selection", selections: ["Email only"] } }, { status: "skipped" }, { status: "answered", response: { kind: "freeform", text: "No" } }], cancelled: false }),
        askRow("c-5", colorArgs, "ok", "User cancelled the question(s)", colorDetails(null, true)),
        askRow("c-6", colorArgs, "interrupted", null),
        askRow("c-7", colorArgs, "error", "ask_user needs an interactive session", { error: "ask_user needs an interactive session" }),
        askRow("c-8", colorArgs, "ok", "User answered: Blue"),
        assistant("Going with green for the header."),
        // an open prompt pi-live never reported: after a moment a read-only card
        askRow("c-9", colorArgs, "running", null),
      ],
      { live: { ...EMPTY_LIVE, usage, working: true } },
    )
  }
  const asks: Ask[] =
    mode === "batch"
      ? [batchAsk("c-open")]
      : mode === "multiple"
        ? [questionAsk("c-open", { question: "Which checks should run before every commit?", options: [{ title: "lint", description: "eslint and tsc" }, { title: "test", description: "the unit suite" }, { title: "build" }], allowMultiple: true, allowFreeform: false })]
        : mode === "comment"
          ? [questionAsk("c-open", { allowComment: true })]
          : mode === "freeform"
            ? [questionAsk("c-open", { question: "What should the output file be called?", options: [], allowFreeform: true })]
            : mode === "context"
              ? [questionAsk("c-open", { context: CONTEXT, question: "Which date parser should the importer use?", options: [{ title: "Lenient", description: "Date.parse" }, { title: "Strict ISO" }], allowFreeform: false })]
              : mode === "two"
                ? [questionAsk("c-open"), questionAsk("c-open-2", { question: "Second question?" }, { openedAt: T0 + 1000 })]
                : [questionAsk("c-open")]
  const args = asks[0]!.kind === "ask_user.batch" ? { heading: "Project setup", questions: (asks[0] as Extract<Ask, { kind: "ask_user.batch" }>).view.questions } : { question: (asks[0] as Extract<Ask, { kind: "ask_user.question" }>).view.question, options: (asks[0] as Extract<Ask, { kind: "ask_user.question" }>).view.options }
  return snapshotOf([...head, askRow("c-open", args, "running", null)], { live: { ...EMPTY_LIVE, usage, working: true, asks } })
}
