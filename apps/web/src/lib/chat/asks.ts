import type { Ask, AskBatchAnswer, AskResponse, ToolRow } from "@herdr-web/agents/rows"

// What the thread shows of an `ask_user` call and what the panel sends for it. Pure: no React.

/** How long a running `ask_user` call may go without an open prompt before it is shown as one that can only be answered in the terminal. */
export const ASK_GRACE_MS = 1000

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v)
const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)

export interface AskOptionView {
  title: string
  description?: string
}

/** What was answered to one question. */
export type AskAnswerView = { kind: "selection"; selections: string[]; comment?: string } | { kind: "freeform"; text: string } | { kind: "skipped" }

/** One question as the thread shows it: what was asked, the options, and what came back (null while there is no answer to show). */
export interface AskQuestionView {
  question: string
  context?: string
  options: AskOptionView[]
  answer: AskAnswerView | null
}

function optionsOf(value: unknown): AskOptionView[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((o): AskOptionView[] => {
    if (typeof o === "string") return [{ title: o }]
    if (isObj(o) && typeof o["title"] === "string") return [{ title: o["title"], ...(typeof o["description"] === "string" && { description: o["description"] }) }]
    return []
  })
}

function responseOf(value: unknown): AskAnswerView | null {
  if (!isObj(value)) return null
  if (value["kind"] === "freeform" && typeof value["text"] === "string") return { kind: "freeform", text: value["text"] }
  if (value["kind"] === "selection" && Array.isArray(value["selections"])) {
    const comment = text(value["comment"])
    return { kind: "selection", selections: value["selections"].filter((s): s is string => typeof s === "string"), ...(comment !== undefined && comment !== "" && { comment }) }
  }
  return null
}

function questionOf(value: unknown, answer: AskAnswerView | null): AskQuestionView | null {
  if (!isObj(value) || typeof value["question"] !== "string") return null
  const context = text(value["context"])
  return { question: value["question"], ...(context !== undefined && context !== "" && { context }), options: optionsOf(value["options"]), answer }
}

/** What the tool result's `details` say: a batch or one question, answered or not. Null when they are not in a shape we know. */
export interface AskOutcome {
  batch: boolean
  cancelled: boolean
  questions: AskQuestionView[]
}

export function readDetails(details: unknown): AskOutcome | null {
  if (!isObj(details) || typeof details["cancelled"] !== "boolean") return null
  const cancelled = details["cancelled"]
  if (details["kind"] === "batch") {
    if (!Array.isArray(details["questions"]) || !Array.isArray(details["answers"])) return null
    const answers = details["answers"]
    const questions = details["questions"].map((q, i): AskQuestionView | null => {
      const a = answers[i]
      const answer: AskAnswerView | null = isObj(a) ? (a["status"] === "skipped" ? { kind: "skipped" } : a["status"] === "answered" ? responseOf(a["response"]) : null) : null
      return questionOf(q, answer)
    })
    if (questions.some((q) => q === null)) return null
    return { batch: true, cancelled, questions: questions as AskQuestionView[] }
  }
  const question = questionOf(details, responseOf(details["response"]))
  if (!question) return null
  if (!cancelled && question.answer === null) return null
  return { batch: false, cancelled, questions: [question] }
}

/** What a call asked, from its arguments: one question, or a batch with its heading. Null when they have neither. */
export function readArgs(args: Obj): { batch: boolean; heading: string | null; questions: AskQuestionView[] } | null {
  if (Array.isArray(args["questions"])) {
    const questions = args["questions"].flatMap((q) => questionOf(q, null) ?? [])
    return { batch: true, heading: text(args["heading"]) ?? null, questions }
  }
  const one = questionOf(args, null)
  return one ? { batch: false, heading: null, questions: [one] } : null
}

/** The words of an answer on one line: the selections joined, `+ comment` when one came with them, or the text typed. */
export function answerText(answer: AskAnswerView): string {
  if (answer.kind === "freeform") return answer.text
  if (answer.kind === "skipped") return "skipped"
  return answer.selections.join(", ") + (answer.comment ? " + comment" : "")
}

/** What the line says the call asked: the question, or a batch's heading (without one, how many questions). */
export function askSubject(row: Pick<ToolRow, "args" | "details">): string {
  const args = readArgs(row.args)
  const outcome = readDetails(row.details)
  if (outcome && !outcome.batch) return outcome.questions[0]!.question
  if (args && !args.batch) return args.questions[0]!.question
  const count = outcome?.questions.length ?? args?.questions.length ?? 0
  return args?.heading || (count > 0 ? `${count} ${count === 1 ? "question" : "questions"}` : "a question")
}

/** The line's answer part for an answered call: one answer, or how many of a batch were answered. */
export function answeredText(outcome: AskOutcome): string {
  if (outcome.batch) {
    const answered = outcome.questions.filter((q) => q.answer !== null && q.answer.kind !== "skipped").length
    return `${answered} of ${outcome.questions.length} answered`
  }
  return outcome.questions[0]!.answer ? answerText(outcome.questions[0]!.answer) : ""
}

/** The result text of a call with no details, without the `User answered: ` pi-ask-user starts it with. */
export function resultWithoutPrefix(result: ToolRow["result"]): string {
  return (result?.text ?? "").replace(/^User answered:\s*/, "").trim()
}

export type AskLineState = "open" | "sent" | "no-item" | "answered" | "not-answered" | "stopped" | "error" | "no-details"

/**
 * Which line an `ask_user` row is: from its status and details once it has ended, and while it runs from whether its prompt is
 * open, was open before (the answer is on its way), or never was (not after the grace: `graceOver`).
 */
export function askLineState(row: Pick<ToolRow, "status" | "details">, open: boolean, seen: boolean, graceOver: boolean): AskLineState {
  switch (row.status) {
    case "running":
      if (open) return "open"
      if (seen) return "sent"
      return graceOver ? "no-item" : "open"
    case "error":
      return "error"
    case "interrupted":
      return "stopped"
    case "ok": {
      const outcome = readDetails(row.details)
      if (!outcome) return "no-details"
      return outcome.cancelled ? "not-answered" : "answered"
    }
  }
}

/** "expires in 2 min", counted up so it never says 0; null without a deadline. */
export function expiresText(expiresAt: number | null, now: number): string | null {
  if (expiresAt === null) return null
  const ms = expiresAt - now
  if (ms <= 0) return "expiring"
  if (ms < 60_000) return "expires in under a minute"
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `expires in ${minutes} min`
  return `expires in ${Math.ceil(minutes / 60)} h`
}

// ---- the panel's answers -------------------------------------------------------------------------------------------

/** What the reader has put in for one question. */
export interface AskDraft {
  selected: string[]
  text: string
  comment: string
}

export const emptyDraft = (): AskDraft => ({ selected: [], text: "", comment: "" })

/** Whether a draft says anything: text typed, or an option picked. */
export const hasAnswer = (d: AskDraft): boolean => d.text.trim() !== "" || d.selected.length > 0

/** The answer pi-ask-user takes for one question. Typed text takes the place of the options; selections go in the order the options are offered. */
export function responseFor(draft: AskDraft, options: readonly AskOptionView[]): AskResponse {
  const typed = draft.text.trim()
  if (typed !== "") return { kind: "freeform", text: typed }
  const selections = options.map((o) => o.title).filter((t) => draft.selected.includes(t))
  const comment = draft.comment.trim()
  return { kind: "selection", selections, ...(comment !== "" && { comment }) }
}

/** The body of a batch's answer: every question, in order, answered or skipped. */
export function batchAnswer(ask: Extract<Ask, { kind: "ask_user.batch" }>, drafts: readonly AskDraft[], skipped: ReadonlySet<number>): { answers: AskBatchAnswer[] } {
  return {
    answers: ask.view.questions.map((q, i): AskBatchAnswer => (skipped.has(i) || !drafts[i] || !hasAnswer(drafts[i]!) ? { status: "skipped" } : { status: "answered", response: responseFor(drafts[i]!, q.options) })),
  }
}
