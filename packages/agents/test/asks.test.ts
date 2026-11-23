import { describe, expect, it } from "vitest"
import { AskBatchAnswerSchema, AskResponseSchema, AskSchema, EMPTY_LIVE, LiveSchema, ToolRowSchema } from "../src/rows.js"

const question = {
  id: "call_1",
  kind: "ask_user.question",
  title: "Which color?",
  view: { question: "Which color?", options: [{ title: "Green" }, { title: "Blue", description: "Like the sky" }], allowMultiple: false, allowFreeform: true, allowComment: false },
  openedAt: 1731600000000,
  expiresAt: null,
}
const batch = {
  id: "call_2",
  kind: "ask_user.batch",
  title: "Setup",
  view: { heading: "Setup", allowComment: true, questions: [{ question: "Which color?", options: [{ title: "Green" }], allowMultiple: true, allowFreeform: false }] },
  openedAt: 1731600000001,
  expiresAt: 1731600120000,
}

describe("ask prompts", () => {
  it("parses a question and a batch", () => {
    expect(AskSchema.safeParse(question).success).toBe(true)
    expect(AskSchema.safeParse(batch).success).toBe(true)
  })

  it("keeps a question's extra view fields out, and does not mind them (pi-ask-user adds `answer`)", () => {
    const parsed = AskSchema.parse({ ...question, view: { ...question.view, answer: { kind: "selection" } } })
    expect(parsed.view).not.toHaveProperty("answer")
  })

  it.each([
    ["an unknown kind", { ...question, kind: "ask_user.form" }],
    ["a question view on a batch", { ...batch, view: question.view }],
    ["an option with no title", { ...question, view: { ...question.view, options: [{ description: "x" }] } }],
    ["no openedAt", { ...question, openedAt: undefined }],
    ["an expiresAt that is not a number or null", { ...question, expiresAt: "soon" }],
  ])("refuses %s", (_name, ask) => {
    expect(AskSchema.safeParse(ask).success).toBe(false)
  })

  it("a batch question carries no allowComment of its own", () => {
    const parsed = AskSchema.parse({ ...batch, view: { ...batch.view, questions: [{ ...batch.view.questions[0], allowComment: true }] } })
    expect((parsed.view as { questions: object[] }).questions[0]).not.toHaveProperty("allowComment")
  })

  it("live holds asks, and starts with none", () => {
    expect(EMPTY_LIVE.asks).toEqual([])
    expect(LiveSchema.safeParse({ ...EMPTY_LIVE, asks: [question, batch] }).success).toBe(true)
    const { asks: _asks, ...without } = EMPTY_LIVE
    expect(LiveSchema.safeParse(without).success).toBe(false)
  })
})

describe("ask answers", () => {
  it("builds each shape pi-ask-user takes", () => {
    expect(AskResponseSchema.safeParse({ kind: "selection", selections: ["Blue"], comment: "ok" }).success).toBe(true)
    expect(AskResponseSchema.safeParse({ kind: "freeform", text: "Teal" }).success).toBe(true)
    expect(AskBatchAnswerSchema.safeParse({ status: "answered", response: { kind: "freeform", text: "x" } }).success).toBe(true)
    expect(AskBatchAnswerSchema.safeParse({ status: "skipped" }).success).toBe(true)
  })

  it.each([
    [AskResponseSchema, { kind: "selection" }],
    [AskResponseSchema, { kind: "selection", selections: "Blue" }],
    [AskResponseSchema, { kind: "freeform" }],
    [AskBatchAnswerSchema, { status: "answered" }],
    [AskBatchAnswerSchema, { status: "pending" }],
  ])("refuses a wrong shape", (schema, input) => {
    expect(schema.safeParse(input).success).toBe(false)
  })
})

describe("a tool row's details", () => {
  const row = { kind: "tool", id: "e1", at: 1, callId: "call_1", name: "ask_user", args: {}, argsTruncated: false, status: "ok", result: null, durationMs: 5, byUser: false }

  it("is optional, and whatever the tool put there", () => {
    expect(ToolRowSchema.safeParse(row).success).toBe(true)
    expect(ToolRowSchema.parse({ ...row, details: { cancelled: false } })).toHaveProperty("details", { cancelled: false })
  })
})
