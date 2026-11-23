import { describe, expect, it } from "vitest"
import type { ToolRow } from "@herdr-web/agents/rows"
import {
  answerText,
  answeredText,
  askLineState,
  askSubject,
  batchAnswer,
  emptyDraft,
  expiresText,
  readArgs,
  readDetails,
  resultWithoutPrefix,
  responseFor,
} from "@/lib/chat/asks"
import { TOOLS_WITH_VIEW } from "@/lib/chat/tool-views"
import { toolViews, toolView } from "@/components/chat/tools"
import { batchAsk, singleDetails } from "./helpers"

const blue = { kind: "selection", selections: ["Blue"] }
const batchDetails = (answers: unknown[], cancelled = false) => ({ kind: "batch", questions: [{ question: "One?", options: [{ title: "a" }] }, { question: "Two?", options: [{ title: "b" }] }, { question: "Three?", options: [] }], answers, cancelled })

describe("the registry", () => {
  it("lists exactly the tools the grouping leaves alone", () => {
    expect(Object.keys(toolViews).sort()).toEqual([...TOOLS_WITH_VIEW].sort())
  })
  it("answers for a name it has and for no other, `constructor` and `toString` included", () => {
    expect(toolView("ask_user")).toBeDefined()
    for (const name of ["bash", "constructor", "toString", "__proto__", "hasOwnProperty", ""]) expect(toolView(name)).toBeUndefined()
  })
})

describe("readDetails", () => {
  it("reads a single answer, selection or typed, with its comment", () => {
    expect(readDetails(singleDetails(blue))).toMatchObject({ batch: false, cancelled: false, questions: [{ question: "Which color?", answer: blue }] })
    expect(readDetails(singleDetails({ kind: "selection", selections: ["Blue"], comment: "sky" }))!.questions[0]!.answer).toEqual({ kind: "selection", selections: ["Blue"], comment: "sky" })
    expect(readDetails(singleDetails({ kind: "freeform", text: "Teal" }))!.questions[0]!.answer).toEqual({ kind: "freeform", text: "Teal" })
  })
  it("reads a cancelled one, with no response", () => {
    expect(readDetails(singleDetails(null, true))).toMatchObject({ cancelled: true, questions: [{ answer: null }] })
  })
  it("reads a batch: answered and skipped questions in order", () => {
    const outcome = readDetails(batchDetails([{ status: "answered", response: blue }, { status: "skipped" }, { status: "answered", response: { kind: "freeform", text: "x" } }]))!
    expect(outcome.batch).toBe(true)
    expect(outcome.questions.map((q) => q.answer?.kind)).toEqual(["selection", "skipped", "freeform"])
    expect(answeredText(outcome)).toBe("2 of 3 answered")
  })
  it("reads a cancelled batch, whose answers are empty", () => {
    const outcome = readDetails(batchDetails([], true))!
    expect(outcome).toMatchObject({ batch: true, cancelled: true })
    expect(outcome.questions.map((q) => q.answer)).toEqual([null, null, null])
  })
  it.each([
    ["nothing", undefined],
    ["a string", "answered"],
    ["an error shape", { error: "UI unavailable" }],
    ["no cancelled flag", { question: "Q", options: [], response: blue }],
    ["answered with no response", { question: "Q", options: [], response: null, cancelled: false }],
    ["a batch without answers", { kind: "batch", questions: [{ question: "Q" }], cancelled: false }],
    ["a batch question that is not one", { kind: "batch", questions: [3], answers: [], cancelled: false }],
    ["an array", [1]],
  ])("is null for %s", (_name, details) => {
    expect(readDetails(details)).toBeNull()
  })
  it("takes options as strings or titles, and drops what is neither", () => {
    expect(readDetails({ question: "Q", options: ["a", { title: "b", description: "d" }, 5, null], response: { kind: "selection", selections: ["a"] }, cancelled: false })!.questions[0]!.options).toEqual([{ title: "a" }, { title: "b", description: "d" }])
  })
})

describe("what a line says", () => {
  it("answerText joins selections with a comma and says + comment when one came with them", () => {
    expect(answerText({ kind: "selection", selections: ["a", "b"] })).toBe("a, b")
    expect(answerText({ kind: "selection", selections: ["a"], comment: "because" })).toBe("a + comment")
    expect(answerText({ kind: "freeform", text: "Teal" })).toBe("Teal")
  })
  it("askSubject is the question, a batch's heading, or how many questions", () => {
    expect(askSubject({ args: { question: "Which color?" }, details: undefined })).toBe("Which color?")
    expect(askSubject({ args: { question: "From args" }, details: singleDetails(blue) })).toBe("Which color?") // what pi recorded wins
    expect(askSubject({ args: { question: "Setup", questions: [{ question: "a" }] }, details: undefined })).toBe("Setup")
    expect(askSubject({ args: { questions: [{ question: "a" }, { question: "b" }] }, details: undefined })).toBe("2 questions")
    expect(askSubject({ args: {}, details: undefined })).toBe("a question")
  })
  it("answeredText: `Answered: x` for one question, `k of N answered` for a batch", () => {
    expect(answeredText(readDetails(singleDetails(blue))!)).toBe("Answered: Blue")
    expect(answeredText(readDetails(batchDetails([{ status: "skipped" }, { status: "skipped" }, { status: "skipped" }]))!)).toBe("0 of 3 answered")
  })
  it("readArgs tells a question from a batch", () => {
    expect(readArgs({ question: "Q", options: ["a"] })).toMatchObject({ batch: false, questions: [{ question: "Q", options: [{ title: "a" }] }] })
    expect(readArgs({ question: "H", questions: [{ question: "a" }] })).toMatchObject({ batch: true, heading: "H" })
    expect(readArgs({})).toBeNull()
  })
  it("resultWithoutPrefix drops the words pi-ask-user starts with", () => {
    const result = (text: string): ToolRow["result"] => ({ text, truncated: false, totalChars: text.length })
    expect(resultWithoutPrefix(result("User answered: Blue"))).toBe("Blue")
    expect(resultWithoutPrefix(result("User cancelled the question(s)"))).toBe("User cancelled the question(s)")
    expect(resultWithoutPrefix(null)).toBe("")
  })
  it("expiresText counts minutes up, and says nothing without a deadline", () => {
    const now = 1_000_000
    expect(expiresText(null, now)).toBeNull()
    expect(expiresText(now + 120_000, now)).toBe("expires in 2 min")
    expect(expiresText(now + 90_000, now)).toBe("expires in 2 min")
    expect(expiresText(now + 59_000, now)).toBe("expires in under a minute")
    expect(expiresText(now + 3 * 3_600_000, now)).toBe("expires in 3 h")
    expect(expiresText(now - 1, now)).toBe("expiring")
  })
})

describe("askLineState", () => {
  const row = (status: ToolRow["status"], details?: unknown) => ({ status, details })
  it("running: open, answered and waiting for the row, shown as open through the grace, then never opened here", () => {
    expect(askLineState(row("running"), true, true, false)).toBe("open")
    expect(askLineState(row("running"), false, true, true)).toBe("sent")
    expect(askLineState(row("running"), false, false, false)).toBe("open")
    expect(askLineState(row("running"), false, false, true)).toBe("no-item")
  })
  it("ended: the result decides, and an open prompt does not outvote a result", () => {
    expect(askLineState(row("ok", singleDetails(blue)), true, true, false)).toBe("answered")
    expect(askLineState(row("ok", singleDetails(null, true)), false, true, false)).toBe("not-answered")
    expect(askLineState(row("ok"), false, false, false)).toBe("no-details")
    expect(askLineState(row("ok", { question: "Q" }), false, false, false)).toBe("no-details")
    expect(askLineState(row("error"), false, false, false)).toBe("error")
    expect(askLineState(row("interrupted"), false, true, false)).toBe("stopped")
  })
})

describe("the answers the panel sends", () => {
  const options = [{ title: "a" }, { title: "b" }, { title: "c" }]
  it("selections go in the order of the options, whatever order they were picked in, and an empty comment is left out", () => {
    expect(responseFor({ ...emptyDraft(), selected: ["c", "a"], comment: "  " }, options)).toEqual({ kind: "selection", selections: ["a", "c"] })
    expect(responseFor({ ...emptyDraft(), selected: ["b"], comment: " why " }, options)).toEqual({ kind: "selection", selections: ["b"], comment: "why" })
  })
  it("typed text is a freeform answer, trimmed, and takes the place of any pick", () => {
    expect(responseFor({ selected: ["a"], text: "  Teal ", comment: "x" }, options)).toEqual({ kind: "freeform", text: "Teal" })
  })
  it("a batch is every question in order, skipped ones as skipped", () => {
    const ask = batchAsk("b1")
    const drafts = [{ ...emptyDraft(), selected: ["Python"] }, { ...emptyDraft(), selected: ["types", "lint"] }, emptyDraft()]
    expect(batchAnswer(ask, drafts, new Set([2]))).toEqual({
      answers: [{ status: "answered", response: { kind: "selection", selections: ["Python"] } }, { status: "answered", response: { kind: "selection", selections: ["lint", "types"] } }, { status: "skipped" }],
    })
    expect(batchAnswer(ask, drafts, new Set([0, 1])).answers.map((a) => a.status)).toEqual(["skipped", "skipped", "skipped"])
  })
})
