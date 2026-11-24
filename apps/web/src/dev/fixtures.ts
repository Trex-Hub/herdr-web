// Fixture threads for the development page. Rows are shaped like the ones the pi adapter builds from
// a session file (packages/agents/test/fixtures/pi); long text is written out here so every kind shows.
import { EMPTY_LIVE, type Approval, type ApprovalRecord, type Ask, type Capabilities, type Identity, type Live, type Row, type ThreadChange, type ThreadSnapshot, type TodoTask, type Todos, type ToolRow } from "@herdr-web/agents/rows"

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
    const batchArgs = { question: "Project setup", questions: batch.view.questions }
    return snapshotOf(
      [
        ...head,
        askRow("c-1", colorArgs, "ok", "User answered: Green", colorDetails({ kind: "selection", selections: ["Green"] })),
        askRow("c-2", colorArgs, "ok", "User answered: Teal", colorDetails({ kind: "freeform", text: "Teal" })),
        askRow("c-3", colorArgs, "ok", "User answered: Blue", colorDetails({ kind: "selection", selections: ["Blue"], comment: "it matches the logo" })),
        askRow("c-4", batchArgs, "ok", "User answered: 2 of 3", { kind: "batch", heading: "Project setup", questions: batch.view.questions, answers: [{ status: "answered", response: { kind: "selection", selections: ["Email only"] } }, { status: "skipped" }, { status: "answered", response: { kind: "freeform", text: "No" } }], cancelled: false }),
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
  const args = asks[0]!.kind === "ask_user.batch" ? { question: "Project setup", questions: (asks[0] as Extract<Ask, { kind: "ask_user.batch" }>).view.questions } : { question: (asks[0] as Extract<Ask, { kind: "ask_user.question" }>).view.question, options: (asks[0] as Extract<Ask, { kind: "ask_user.question" }>).view.options }
  return snapshotOf([...head, askRow("c-open", args, "running", null)], { live: { ...EMPTY_LIVE, usage, working: true, asks } })
}

// ---- pi waiting on a dialog of its own --------------------------------------------------------------------------------

export type WaitingMode = "confirm" | "short" | "untitled" | "ask" | "card"
export const WAITING_MODES: readonly WaitingMode[] = ["confirm", "short", "untitled", "ask", "card"]

/**
 * A thread whose agent has stopped on a dialog only its terminal can answer: the line shows ("confirm" with a long title, "short", "untitled").
 * "ask" has the same wait behind an open `ask_user` prompt, and "card" behind an `ask_user` call pi-live never reported:
 * those chats already show the wait, so the line stays hidden.
 */
export function waitingThread(mode: WaitingMode): ThreadSnapshot {
  n = 0
  const head = [user("Deploy the importer to production."), assistant("I'll run the deploy script now."), tool("bash", { command: "./scripts/build.sh" }, "ok", "built 3 packages", 5200)]
  const base = { ...EMPTY_LIVE, usage, working: true }
  if (mode === "ask") {
    const ask = questionAsk("c-open")
    return snapshotOf([...head, askRow("c-open", { question: "Which color should the report header be?", options: ["Green", "Blue", "Red"] }, "running", null)], { live: { ...base, asks: [ask], waiting: { kind: "custom", title: "Which color should the report header be?" } } })
  }
  if (mode === "card") {
    return snapshotOf([...head, askRow("c-open", colorArgs, "running", null)], { live: { ...base, waiting: { kind: "custom", title: colorArgs.question } } })
  }
  return snapshotOf([...head, tool("deploy", { environment: "production" }, "running", null, null)], {
    live: { ...base, waiting: { kind: mode === "untitled" ? "select" : "confirm", title: mode === "confirm" ? "Deploy to production?" : mode === "short" ? "Deploy?" : null } },
  })
}

// ---- guardrails prompts ------------------------------------------------------------------------------------------------

export type ApprovalMode = "command" | "long" | "path" | "untrusted" | "two" | "nested" | "unpinned" | "lines"
export const APPROVAL_MODES: readonly ApprovalMode[] = ["command", "long", "path", "untrusted", "two", "nested", "unpinned", "lines"]

const COMMAND_OPTIONS = [
  { result: "allow", label: "Allow once" },
  { result: "allow-session", label: "Allow for session" },
  { result: "deny", label: "Deny" },
  { result: "stop", label: "Decline and stop" },
]

export const commandApproval = (id: string, command: string, callId: string | undefined, over: Partial<Approval["view"]> = {}): Approval => ({
  id,
  kind: "guardrails.command",
  title: "Dangerous command: recursive delete",
  view: { toolName: "bash", command, reason: "recursive delete", options: COMMAND_OPTIONS, ...(callId ? { toolCallId: callId } : {}), ...over } as Extract<Approval, { kind: "guardrails.command" }>["view"],
  openedAt: T0 + 5000,
})

export const pathApproval = (id: string, callId: string, untrusted = false): Approval => {
  const off = untrusted ? { disabled: true, disabledReason: "project not trusted" } : {}
  return {
    id,
    kind: "guardrails.path",
    title: "Outside workspace: ~/.ssh/config",
    view: {
      toolCallId: callId,
      toolName: "read",
      path: "/Users/dev/.ssh/config",
      displayPath: "~/.ssh/config",
      directory: "/Users/dev/.ssh",
      cwd: "/Users/dev/projects/importer",
      target: "file",
      reason: "outside the workspace",
      alwaysSavedTo: "project",
      options: [
        { result: "allow-file-once", label: "Allow once" },
        { result: "allow-dir-once", label: "Allow folder once" },
        { result: "allow-file-session", label: "Allow file for session" },
        { result: "allow-dir-session", label: "Allow folder for session" },
        { result: "allow-file-always", label: "Always allow file", ...off },
        { result: "allow-dir-always", label: "Always allow folder", ...off },
        { result: "deny", label: "Deny" },
      ],
    },
    openedAt: T0 + 5000,
  }
}

export const LONG_COMMAND = Array.from({ length: 30 }, (_, i) => (i === 0 ? "set -e" : i === 29 ? "rm -rf ./build ./dist ./node_modules/.cache" : `echo "step ${i}: cleaning workspace part ${i}" && ls -la ./part-${i}`)).join("\n")

const record = (id: string, callId: string | null, subject: string, by: ApprovalRecord["by"], result: string | null = null, label: string | null = null): ApprovalRecord => ({ id, kind: "guardrails.command", callId, subject, by, result, label })

/** A thread stopped on a guardrails prompt. "lines" has none open, only the lines past ones left under their calls. */
export function approvalThread(mode: ApprovalMode): ThreadSnapshot {
  n = 0
  const head = [user("Clean the build output and check the ssh config."), assistant("I'll clear the build folders first.")]
  const base = { ...EMPTY_LIVE, usage, working: true }
  if (mode === "lines") {
    const calls = ["allow", "allow-session", "deny", "stop", "keyboard", "abort", "shutdown"].map((r) => tool("bash", { command: `rm -rf ./build-${r}` }, r === "deny" || r === "stop" || r === "abort" ? "error" : "ok", r === "deny" ? "Blocked by user" : "done", 300))
    const ids = calls.map((c) => (c as ToolRow).callId)
    const approved: ApprovalRecord[] = [
      record("a1", ids[0]!, "rm -rf ./build-allow", "client", "allow", "Allow once"),
      record("a2", ids[1]!, "rm -rf ./build-allow-session", "client", "allow-session", "Allow for session"),
      record("a3", ids[2]!, "rm -rf ./build-deny", "client", "deny", "Deny"),
      record("a4", ids[3]!, "rm -rf ./build-stop", "client", "stop", "Decline and stop"),
      record("a5", ids[4]!, "rm -rf ./build-keyboard", "keyboard"),
      record("a6", ids[5]!, "rm -rf ./build-abort", "abort"),
      record("a7", ids[6]!, "rm -rf ./build-shutdown", "shutdown"),
    ]
    return snapshotOf([...head, ...calls], { live: { ...EMPTY_LIVE, usage, approved } })
  }
  if (mode === "path" || mode === "untrusted") {
    const call = tool("read", { path: "/Users/dev/.ssh/config" }, "running", null, null)
    return snapshotOf([...head, call], { live: { ...base, approvals: [pathApproval("g-path", (call as ToolRow).callId, mode === "untrusted")] } })
  }
  if (mode === "nested") {
    const call = tool("codemode", { code: "await tools.bash({ command: 'rm -rf ./build' })" }, "running", null, null)
    const parent = (call as ToolRow).callId
    return snapshotOf([...head, call], { live: { ...base, approvals: [commandApproval("g-nested", "rm -rf ./build", `${parent}/1`, { parentToolCallId: parent })] } })
  }
  const command = mode === "long" ? LONG_COMMAND : "rm -rf ./build ./dist"
  const call = tool("bash", { command }, "running", null, null)
  const callId = (call as ToolRow).callId
  if (mode === "unpinned") return snapshotOf([...head, call], { live: { ...base, approvals: [commandApproval("g-unpinned", command, undefined)] } })
  const approvals = mode === "two" ? [commandApproval("g-1", command, callId), { ...pathApproval("g-2", "call-other"), openedAt: T0 + 6000 }] : [commandApproval("g-1", command, callId)]
  return snapshotOf([...head, call], { live: { ...base, approvals } })
}

/** A pi-link batch as pi-link writes it: `[Link: N message(s) received]`, then the items joined by blank lines. */
export const linkMessage = (items: string[], count = items.length): Row => ({
  kind: "notice",
  id: id("link"),
  at: T0 + n * 1000,
  level: "info",
  text: `[Link: ${count} message(s) received]\n\n${items.join("\n\n")}`,
  source: "link",
  details: { batched: true, count },
})

const LONG_LINK = `CP4 done at \`857fffa\`.

Clean clone:
- install, build, lint, test: exit 0
- e2e: 57 passed
- agents.live 14, backend.live 17+1

Not passed yet: the web live spec \`chat-live.spec.ts\`. The model server (cachyos:8001) died mid-run; the command is on the ticket.

\`\`\`sh
pnpm test:agents
\`\`\`

Report on DEV-35. Waiting for you.`

/**
 * A lead agent talking to others over pi-link: what it sent (sent, failed, sending), a terminal list, a single message, a batch of
 * three from two senders with a compaction outcome, a long message, a batch that cannot be split, and an unknown custom message.
 */
export function linkThread(): ThreadSnapshot {
  n = 0
  const send = (to: string, message: string, status: ToolRow["status"], result: string | null, details?: unknown) =>
    tool("link_send", { to, message }, status, result, status === "running" ? null : 3, details === undefined ? {} : { details })
  return snapshotOf([
    user("Check where DEV-35 is with the engineer, and get the tester on the final round."),
    assistant("Asking both now."),
    tool("bash", { command: "git log --oneline -3" }, "ok", "857fffa CP4", 40),
    tool("read", { path: "docs/chat.md" }, "ok", "# Chat", 12),
    send("herdr-web-engineer", "Status on **DEV-35 CP4**? Please include:\n- the clean clone result\n- the e2e count\n- anything not passed yet", "ok", 'Sent to hub for delivery to "herdr-web-engineer"', { to: "herdr-web-engineer" }),
    send("herdr-web-tester", "Can you run the final browser round on `857fffa` against a real pi?", "ok", 'Terminal "herdr-web-tester" not found. Connected: herdr-web-engineer, ui-ux-engineer', { to: "herdr-web-tester", error: "not_found" }),
    tool("link_list", {}, "ok", "Connected terminals: …", 2, {
      details: { terminals: ["herdr-web-architect", "herdr-web-engineer", "ui-ux-engineer"], statuses: { "herdr-web-engineer": "working", "ui-ux-engineer": "idle" }, cwds: {}, contexts: {}, self: "herdr-web-architect", role: "hub" },
    }),
    assistant("The tester is offline, so I'll wait for the engineer."),
    linkMessage(['From "herdr-web-engineer":\nOn it, checking the clean clone now.']),
    linkMessage([`From "herdr-web-engineer":\n${LONG_LINK}`, 'From "herdr-web-engineer":\nAlso: the flaky backend test is `ws reconnect`. I\'ll look at it next.', 'From "ui-ux-engineer":\nLooks good from the design side. **Ship it.**']),
    linkMessage(['link_compact "herdr-web-tester" [r-81]: compacted', 'link_compact "ui-ux-engineer" [r-82]: not done: busy']),
    assistant("The last checkpoint of DEV-35 is built, and nearly everything passes. Two things are left before it can merge: one flaky backend test, and the live browser test."),
    tool("link_compact", { to: "herdr-web-engineer" }, "ok", 'Compact request sent to "herdr-web-engineer" [r-90]; the result will arrive as a link notification.', 2, { details: { to: "herdr-web-engineer", id: "r-90" } }),
    // A body that quotes another message: the split finds two items where pi-link counted one, so it is shown whole.
    linkMessage(['From "herdr-web-tester":\nBack online. Quoting the engineer so we agree on what was claimed:\n\nFrom "herdr-web-engineer":\nCP4 done at 857fffa.\n\nI\'ll start the final round now.'], 1),
    { kind: "notice", id: id("n"), at: T0 + n * 1000, level: "info", text: "An extension's own message of a type the chat does not know.", source: "something-else" },
    send("herdr-web-engineer", "Thanks. Look at `ws reconnect` first, in its own commit.", "running", null),
  ], { live: { ...EMPTY_LIVE, usage, working: true } })
}

export const TODO_MODES = ["statuses", "long", "empty", "turn"] as const
export type TodoMode = (typeof TODO_MODES)[number]

const task = (id: number, status: TodoTask["status"], subject: string, extra: Partial<TodoTask> = {}): TodoTask => ({ id, subject, status, ...extra })

/** One of each status, with an in-progress label and a task waiting on another. */
export const TODO_STATUSES: TodoTask[] = [
  task(1, "completed", "Read the importer and its tests"),
  task(2, "completed", "Reproduce the three skipped rows"),
  task(3, "in_progress", "Make parseRow tolerate a bad date", { activeForm: "Making parseRow tolerate a bad date" }),
  task(4, "pending", "Report the skipped count at the end", { blockedBy: [3] }),
  task(5, "pending", "Run the whole suite"),
]

/** More than five tasks, so the card folds. */
export const TODO_LONG: TodoTask[] = [
  task(1, "completed", "Read the importer"),
  task(2, "completed", "Reproduce the three skipped rows"),
  task(3, "completed", "Write a failing test for blank lines"),
  task(4, "in_progress", "Skip blank lines before parsing", { activeForm: "Skipping blank lines before parsing" }),
  task(5, "pending", "Return null for a malformed date"),
  task(6, "pending", "Report the skipped count", { blockedBy: [4, 5] }),
  task(7, "pending", "Update the importer docs"),
  task(8, "pending", "Run the whole suite"),
  task(9, "pending", "Open the pull request", { blockedBy: [8] }),
]

const todoCall = (args: Record<string, unknown>, tasks: TodoTask[]): Row =>
  tool("todo", args, "ok", "ok", 2, { details: { action: String(args["action"]), tasks } })

/** What the agent writes across a turn: a list created, a task started, one done, the next started, the rest done. */
export const TODO_TURN: { todos: Todos; row: Row }[] = (() => {
  const base = [task(1, "pending", "Read the importer"), task(2, "pending", "Fix parseRow"), task(3, "pending", "Run the suite")]
  const steps: [Record<string, unknown>, TodoTask[]][] = [
    [{ action: "create", tasks: base.map((t) => ({ subject: t.subject })) }, base],
    [{ action: "update", id: 1, status: "in_progress" }, [task(1, "in_progress", base[0]!.subject, { activeForm: "Reading the importer" }), base[1]!, base[2]!]],
    [{ action: "update", id: 1, status: "completed" }, [task(1, "completed", base[0]!.subject), base[1]!, base[2]!]],
    [{ action: "update", id: 2, status: "in_progress" }, [task(1, "completed", base[0]!.subject), task(2, "in_progress", base[1]!.subject, { activeForm: "Fixing parseRow" }), base[2]!]],
    [{ action: "update", id: 2, status: "completed" }, [task(1, "completed", base[0]!.subject), task(2, "completed", base[1]!.subject), base[2]!]],
    [{ action: "update", id: 3, status: "completed" }, [task(1, "completed", base[0]!.subject), task(2, "completed", base[1]!.subject), task(3, "completed", base[2]!.subject)]],
  ]
  n = 1000
  return steps.map(([args, tasks]) => ({ todos: { tasks }, row: todoCall(args, tasks) }))
})()

/** The agent's todo list in the card above the composer: every status, a long list that folds, no list, and one that changes across a turn. */
export function todoThread(mode: TodoMode): ThreadSnapshot {
  n = 0
  const rows: Row[] = [user("Fix the importer so it stops skipping rows."), assistant("I'll plan it first.")]
  if (mode === "empty") {
    rows.push(todoCall({ action: "clear" }, []), assistant("Nothing to track for this one."))
    return snapshotOf(rows)
  }
  if (mode === "turn") return snapshotOf(rows.slice(0, 1), { live: { ...EMPTY_LIVE, usage, working: true } })
  const tasks = mode === "long" ? TODO_LONG : TODO_STATUSES
  rows.push(todoCall({ action: "create", tasks: tasks.map((t) => ({ subject: t.subject })) }, tasks), todoCall({ action: "update", id: 3, status: "in_progress" }, tasks), assistant("Working through it."))
  return snapshotOf(rows, { todos: { tasks }, live: { ...EMPTY_LIVE, usage, working: true } })
}
