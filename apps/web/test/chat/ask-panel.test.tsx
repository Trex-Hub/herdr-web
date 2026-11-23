// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import type { Ask } from "@herdr-web/agents/rows"
import type { ChatAnswerResult } from "@herdr-web/protocol"
import { AskPanel } from "@/components/chat/ask-panel"
import type { ChatActions } from "@/lib/chat/actions"
import { batchAsk, fakeActions, fullCaps, noCaps, questionAsk } from "./helpers"

function setup(asks: Ask[], over: Partial<ChatActions> = {}, extra: { disabledReason?: string | null; capabilities?: typeof noCaps } = {}) {
  const a = fakeActions(over)
  const view = render(<AskPanel asks={asks} actions={a} capabilities={extra.capabilities ?? noCaps} disabledReason={extra.disabledReason ?? null} />)
  const sent = () => (a.calls["answer"] ?? []) as Array<[string, Record<string, unknown>]>
  return { a, view, sent }
}
const user = () => userEvent.setup()
const choice = (title: string) => screen.getByRole(screen.queryAllByRole("radio").length > 0 ? "radio" : "checkbox", { name: new RegExp(title) })
const progress = () => screen.getAllByTestId("ask-progress").find((el) => !el.closest("[hidden]"))!.textContent
const visible = (name: string) => screen.queryByRole("button", { name })

describe("a single question", () => {
  it("shows the question and every option with its description and number, in the composer's place", () => {
    setup([questionAsk("c1")])
    const panel = screen.getByTestId("ask-panel")
    expect(panel.getAttribute("data-ask-id")).toBe("c1")
    expect(within(panel).getByText("Which color?")).toBeTruthy()
    expect(within(panel).getByText("the calm one")).toBeTruthy()
    expect(within(panel).getByText("Green")).toBeTruthy()
    expect(within(panel).getByText("1")).toBeTruthy()
    expect(within(panel).getByText("2")).toBeTruthy()
    expect(screen.queryByTestId("ask-progress")).toBeNull()
  })

  it("has no Skip (a single question has nothing to skip, D7)", () => {
    setup([questionAsk("c1")])
    expect(visible("Skip")).toBeNull()
  })

  it("picking an option sends it at once, as a selection", async () => {
    const { sent } = setup([questionAsk("c1")])
    await user().click(choice("Blue"))
    await waitFor(() => expect(sent()).toEqual([["c1", { kind: "selection", selections: ["Blue"] }]]))
  })

  it("the number key picks and sends: 1 is the first option", async () => {
    const { sent } = setup([questionAsk("c1")])
    await user().keyboard("1") // the panel has the focus when it opens
    await waitFor(() => expect(sent()).toEqual([["c1", { kind: "selection", selections: ["Green"] }]]))
  })

  it("a number typed into the text box is text, not a pick", async () => {
    const { sent } = setup([questionAsk("c1")])
    const u = user()
    await u.type(screen.getByLabelText("Type something else"), "2")
    expect(sent()).toEqual([])
    expect(screen.getByLabelText<HTMLInputElement>("Type something else").value).toBe("2")
  })

  it("the arrow keys move along the options and select, and send nothing until Enter", async () => {
    const { sent } = setup([questionAsk("c1")])
    const u = user()
    choice("Green").focus()
    await u.keyboard("{ArrowDown}")
    expect(sent()).toEqual([])
    expect((choice("Blue") as HTMLInputElement).checked).toBe(true)
    await u.keyboard("{Enter}")
    await waitFor(() => expect(sent()).toEqual([["c1", { kind: "selection", selections: ["Blue"] }]]))
  })

  it("typing in the last row and pressing Enter sends the text as freeform, trimmed", async () => {
    const { sent } = setup([questionAsk("c1")])
    await user().type(screen.getByLabelText("Type something else"), "  Teal {Enter}")
    await waitFor(() => expect(sent()).toEqual([["c1", { kind: "freeform", text: "Teal" }]]))
  })

  it("no options at all: the text box is the question's only answer, and Submit sends it", async () => {
    const { sent } = setup([questionAsk("c1", { options: [], allowFreeform: false })])
    const u = user()
    await u.type(screen.getByLabelText("Type something else"), "my answer")
    await u.click(screen.getByRole("button", { name: "Submit" }))
    await waitFor(() => expect(sent()).toEqual([["c1", { kind: "freeform", text: "my answer" }]]))
  })

  it("options only (no typing): there is no text row", () => {
    setup([questionAsk("c1", { allowFreeform: false })])
    expect(screen.queryByLabelText("Type something else")).toBeNull()
    expect(visible("Submit")).toBeNull()
  })

  it("an empty answer is not sent: Submit on nothing asks for an answer", async () => {
    const { sent } = setup([questionAsk("c1", { allowMultiple: true })])
    await user().click(screen.getByRole("button", { name: "Submit" }))
    expect(sent()).toEqual([])
    expect(screen.getByTestId("ask-form").textContent).toMatch(/choose an answer/i)
  })
})

describe("several choices", () => {
  const multi = () => questionAsk("c2", { question: "Which checks?", options: [{ title: "lint" }, { title: "test" }, { title: "types" }], allowMultiple: true, allowFreeform: false })

  it("rows are checkable and nothing is sent until Submit; selections go in option order", async () => {
    const { sent } = setup([multi()])
    const u = user()
    await u.click(choice("types"))
    await u.click(choice("lint"))
    expect(sent()).toEqual([])
    await u.click(screen.getByRole("button", { name: "Submit" }))
    await waitFor(() => expect(sent()).toEqual([["c2", { kind: "selection", selections: ["lint", "types"] }]]))
  })

  it("a row can be unchecked", async () => {
    const { sent } = setup([multi()])
    const u = user()
    await u.click(choice("lint"))
    await u.click(choice("test"))
    await u.click(choice("lint"))
    await u.click(screen.getByRole("button", { name: "Submit" }))
    await waitFor(() => expect(sent()).toEqual([["c2", { kind: "selection", selections: ["test"] }]]))
  })

  it("number keys toggle rows", async () => {
    const { sent } = setup([multi()])
    const u = user()
    await u.keyboard("2")
    await u.keyboard("3")
    await u.click(screen.getByRole("button", { name: "Submit" }))
    await waitFor(() => expect(sent()).toEqual([["c2", { kind: "selection", selections: ["test", "types"] }]]))
  })
})

describe("a comment", () => {
  it("with allowComment a pick no longer sends at once: the comment goes with it on Submit", async () => {
    const { sent } = setup([questionAsk("c3", { allowComment: true })])
    const u = user()
    await u.click(choice("Green"))
    expect(sent()).toEqual([])
    await u.type(screen.getByTestId("ask-comment"), "calm is good")
    await u.click(screen.getByRole("button", { name: "Submit" }))
    await waitFor(() => expect(sent()).toEqual([["c3", { kind: "selection", selections: ["Green"], comment: "calm is good" }]]))
  })

  it("Enter in the comment line sends, and an empty comment is left out", async () => {
    const { sent } = setup([questionAsk("c3", { allowComment: true })])
    const u = user()
    await u.click(choice("Blue"))
    await u.type(screen.getByTestId("ask-comment"), "{Enter}")
    await waitFor(() => expect(sent()).toEqual([["c3", { kind: "selection", selections: ["Blue"] }]]))
  })
})

describe("context", () => {
  it("a short context is shown whole; a long one is cut with Show more, which opens it", async () => {
    const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n\n")
    setup([questionAsk("c4", { context: long })])
    const ctx = screen.getByTestId("ask-context")
    expect(ctx.getAttribute("data-collapsed")).toBe("true")
    await user().click(screen.getByTestId("ask-context-toggle"))
    expect(ctx.getAttribute("data-collapsed")).toBe("false")
    expect(screen.getByText("Show less")).toBeTruthy()
  })
  it("a short one has no toggle, and its markdown is rendered", () => {
    setup([questionAsk("c4", { context: "Some **bold** words" })])
    expect(screen.queryByTestId("ask-context-toggle")).toBeNull()
    expect(screen.getByTestId("ask-context").textContent).toBe("Some bold words") // the ** are rendered, not shown
  })
})

describe("a batch", () => {
  const next = () => screen.getByRole("button", { name: /^Next/ })
  const prev = () => screen.getByRole("button", { name: /^Previous/ })

  it("shows one question at a time with its place, the heading, and Skip", () => {
    setup([batchAsk("b1")])
    expect(progress()).toBe("1/3")
    expect(screen.getByText("Setup")).toBeTruthy()
    expect(screen.getByText("Which language?")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy()
  })

  it("sends one answer at the end, with every question in order, skipped ones as skipped", async () => {
    const { sent } = setup([batchAsk("b1")])
    const u = user()
    await u.click(choice("Python")) // question 1: a pick does not send in a batch
    expect(sent()).toEqual([])
    await u.click(next())
    expect(progress()).toBe("2/3")
    await u.click(screen.getByRole("button", { name: "Skip" }))
    expect(progress()).toBe("3/3")
    await u.type(screen.getByLabelText("Type something else"), "nothing")
    await u.click(screen.getByRole("button", { name: "Submit" }))
    await waitFor(() =>
      expect(sent()).toEqual([
        ["b1", { answers: [{ status: "answered", response: { kind: "selection", selections: ["Python"] } }, { status: "skipped" }, { status: "answered", response: { kind: "freeform", text: "nothing" } }] }],
      ]),
    )
  })

  it("Previous goes back and keeps what was picked", async () => {
    const { sent } = setup([batchAsk("b1")])
    const u = user()
    await u.click(choice("TypeScript"))
    await u.click(next())
    await u.click(prev())
    expect(progress()).toBe("1/3")
    expect((choice("TypeScript") as HTMLInputElement).checked).toBe(true)
    expect(sent()).toEqual([])
  })

  it("skipping the last question sends, with what came before", async () => {
    const { sent } = setup([batchAsk("b1")])
    const u = user()
    await u.click(choice("TypeScript"))
    await u.click(next())
    await u.click(next()).catch(() => {}) // question 2 is optional: needs an answer or a skip
    await u.click(screen.getByRole("button", { name: "Skip" })) // skip 2
    await u.click(screen.getByRole("button", { name: "Skip" })) // skip 3: the last, so it sends
    await waitFor(() => expect(sent()).toHaveLength(1))
    expect(sent()[0]![1]).toEqual({ answers: [{ status: "answered", response: { kind: "selection", selections: ["TypeScript"] } }, { status: "skipped" }, { status: "skipped" }] })
  })

  it("a batch with a comment line takes one comment per question", async () => {
    const { sent } = setup([batchAsk("b1", { allowComment: true, questions: [{ question: "One?", options: [{ title: "a" }, { title: "b" }], allowMultiple: false, allowFreeform: false }] })])
    const u = user()
    await u.click(choice("a"))
    await u.type(screen.getByTestId("ask-comment"), "because")
    await u.click(screen.getByRole("button", { name: "Submit" }))
    await waitFor(() => expect(sent()[0]![1]).toEqual({ answers: [{ status: "answered", response: { kind: "selection", selections: ["a"], comment: "because" } }] }))
  })
})

describe("what comes back", () => {
  const rejecting = (result: ChatAnswerResult) => ({ answer: () => Promise.resolve(result) })

  it("delivered: the controls lock and the panel says it was sent, until the ask leaves", async () => {
    setup([questionAsk("c1")])
    await user().click(choice("Blue"))
    await waitFor(() => expect(screen.getByTestId("ask-sent")).toBeTruthy())
    expect((choice("Green") as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText("Type something else") as HTMLInputElement).disabled).toBe(true)
  })

  it("while the answer is on its way the controls are off, so it is sent once", async () => {
    let release: (r: ChatAnswerResult) => void = () => {}
    let calls = 0
    setup([questionAsk("c1")], { answer: () => new Promise<ChatAnswerResult>((r) => { calls++; release = r }) })
    const u = user()
    await u.click(choice("Blue"))
    await waitFor(() => expect((choice("Green") as HTMLInputElement).disabled).toBe(true))
    await user().keyboard("2") // a second pick while it is on its way does nothing
    expect(calls).toBe(1)
    await act(async () => release({ status: "delivered" }))
    expect(screen.getByTestId("ask-sent")).toBeTruthy()
  })

  it("invalid: the reason is shown under the choices, the panel stays, and the next edit clears it and lets it be sent again", async () => {
    let n = 0
    setup([questionAsk("c1", { allowMultiple: true })], {
      answer: () => Promise.resolve(n++ === 0 ? { status: "invalid", reason: "selection not in options: Purple" } : { status: "delivered" }),
    })
    const u = user()
    await u.click(choice("Blue"))
    await u.click(screen.getByRole("button", { name: "Submit" }))
    await waitFor(() => expect(screen.getByTestId("ask-rejected").textContent).toBe("selection not in options: Purple"))
    expect(screen.getByTestId("ask-rejected").hidden).toBe(false)
    expect(screen.getByTestId("ask-panel")).toBeTruthy()
    expect((choice("Green") as HTMLInputElement).disabled).toBe(false)
    await u.click(choice("Green"))
    expect(screen.getByTestId("ask-rejected").hidden).toBe(true)
    await u.click(screen.getByRole("button", { name: "Submit" }))
    await waitFor(() => expect(screen.getByTestId("ask-sent")).toBeTruthy())
  })

  it.each([["closed"], ["not_found"]] as const)("%s: says it was already answered or closed, and offers nothing more to send", async (status) => {
    setup([questionAsk("c1")], rejecting({ status }))
    await user().click(choice("Blue"))
    await waitFor(() => expect(screen.getByTestId("ask-closed").textContent).toBe("This question was already answered or closed."))
    expect((choice("Green") as HTMLInputElement).disabled).toBe(true)
  })

  it("a request that fails shows its sentence and can be tried again", async () => {
    let n = 0
    setup([questionAsk("c1")], { answer: () => (n++ === 0 ? Promise.reject(new Error("The server could not be reached")) : Promise.resolve({ status: "delivered" as const })) })
    const u = user()
    await u.click(choice("Blue"))
    await waitFor(() => expect(screen.getByTestId("ask-error").textContent).toContain("could not be reached"))
    await u.click(choice("Green"))
    await waitFor(() => expect(screen.getByTestId("ask-sent")).toBeTruthy())
  })
})

describe("several waiting", () => {
  it("shows the oldest and says how many more wait", () => {
    setup([questionAsk("c1"), questionAsk("c2", { question: "Second?" }), batchAsk("c3")])
    expect(screen.getByTestId("ask-panel").getAttribute("data-ask-id")).toBe("c1")
    expect(screen.getByTestId("ask-waiting").textContent).toBe("2 more questions waiting")
  })
  it("one more is singular, none says nothing", () => {
    const { view } = setup([questionAsk("c1"), questionAsk("c2")])
    expect(screen.getByTestId("ask-waiting").textContent).toBe("1 more question waiting")
    view.rerender(<AskPanel asks={[questionAsk("c1")]} actions={fakeActions()} capabilities={noCaps} disabledReason={null} />)
    expect(screen.getByTestId("ask-waiting").textContent).toBe("")
  })
  it("the next question starts fresh: nothing of the last one's picks is left", async () => {
    const { view } = setup([questionAsk("c1", { allowMultiple: true })])
    await user().click(choice("Blue"))
    view.rerender(<AskPanel asks={[questionAsk("c2", { allowMultiple: true })]} actions={fakeActions()} capabilities={noCaps} disabledReason={null} />)
    expect((choice("Blue") as HTMLInputElement).checked).toBe(false)
  })
})

describe("Stop and a panel that cannot send", () => {
  it("Stop is in the panel, calls stop, and answering is not needed", async () => {
    const { a } = setup([questionAsk("c1")], {}, { capabilities: fullCaps })
    await user().click(screen.getByTestId("stop"))
    await waitFor(() => expect(a.calls["stop"]).toHaveLength(1))
  })
  it("no Stop where the agent cannot be stopped", () => {
    setup([questionAsk("c1")], {}, { capabilities: { ...noCaps, stop: false } })
    expect(screen.queryByTestId("stop")).toBeNull()
  })
  it("a failed Stop says why", async () => {
    setup([questionAsk("c1")], { stop: () => Promise.reject(new Error("stop failed")) }, { capabilities: fullCaps })
    await user().click(screen.getByTestId("stop"))
    await waitFor(() => expect(screen.getByTestId("ask-stop-error").textContent).toContain("stop failed"))
  })
  it("when nothing can be sent (disconnected) the controls are off and the reason is shown; Stop is off too", () => {
    setup([questionAsk("c1")], {}, { disabledReason: "Reconnecting…", capabilities: fullCaps })
    expect(screen.getByTestId("ask-disabled").textContent).toBe("Reconnecting…")
    expect((choice("Green") as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByTestId("stop") as HTMLButtonElement).disabled).toBe(true)
  })
})
