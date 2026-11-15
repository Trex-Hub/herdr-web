// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { Composer, clearDrafts, type ComposerProps } from "@/components/chat/composer"
import type { ChatActions } from "@/lib/chat/actions"
import { fakeActions, fullCaps, live, noCaps } from "./helpers"

beforeEach(() => clearDrafts())

function setup(over: Partial<ComposerProps> = {}, actions: Partial<ChatActions> = {}) {
  const a = fakeActions(actions)
  const onShowTerminal = vi.fn()
  const props: ComposerProps = { actions: a, capabilities: noCaps, live: live(), disabledReason: null, draftKey: "t1", onShowTerminal, ...over }
  const view = render(<Composer {...props} />)
  const input = () => screen.getByTestId("composer-input") as HTMLTextAreaElement
  return { a, onShowTerminal, input, view, props }
}

describe("sending", () => {
  it("Enter sends the text and empties the box", async () => {
    const { a, input } = setup()
    await userEvent.type(input(), "hello there{Enter}")
    await waitFor(() => expect(input().value).toBe(""))
    expect(a.calls["send"]).toEqual([["hello there"]])
  })

  it("Shift+Enter makes a new line and sends nothing", async () => {
    const { a, input } = setup()
    await userEvent.type(input(), "one{Shift>}{Enter}{/Shift}two")
    expect(input().value).toBe("one\ntwo")
    expect(a.calls["send"]).toBeUndefined()
  })

  it("Enter while an input method is composing is never a send", () => {
    const { a, input } = setup()
    fireEvent.change(input(), { target: { value: "ni hao" } })
    fireEvent.keyDown(input(), { key: "Enter", isComposing: true })
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 229 })
    expect(a.calls["send"]).toBeUndefined()
    fireEvent.keyDown(input(), { key: "Enter" })
    expect(a.calls["send"]).toEqual([["ni hao"]])
  })

  it("an empty or blank message is not sent, and Send is off", async () => {
    const { a, input } = setup()
    expect((screen.getByTestId("send") as HTMLButtonElement).disabled).toBe(true)
    await userEvent.type(input(), "   {Enter}")
    expect(a.calls["send"]).toBeUndefined()
  })

  it("the Send button sends too, once even if Enter is pressed again while it is in flight", async () => {
    let finish!: () => void
    const send = vi.fn(() => new Promise<void>((r) => (finish = r)))
    const { input } = setup({}, { send })
    fireEvent.change(input(), { target: { value: "go" } })
    fireEvent.click(screen.getByTestId("send"))
    fireEvent.keyDown(input(), { key: "Enter" })
    expect(send).toHaveBeenCalledTimes(1)
    await act(async () => finish())
  })

  it("a send that fails keeps the text and shows the sentence; a later send clears the sentence", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("pi is not answering.")).mockResolvedValue(undefined)
    const { input } = setup({}, { send })
    await userEvent.type(input(), "important text{Enter}")
    expect((await screen.findByTestId("composer-error")).textContent).toBe("pi is not answering.")
    expect(input().value).toBe("important text")
    await userEvent.type(input(), "{Enter}")
    await waitFor(() => expect(input().value).toBe(""))
    expect(screen.queryByTestId("composer-error")).toBeNull()
  })

  it("while the agent works, sending is a steer: same box, same Enter, and Stop appears beside Send", async () => {
    const { a, input } = setup({ live: live({ working: true }) })
    expect(screen.getByTestId("stop")).toBeTruthy()
    expect(input().placeholder).toMatch(/Steer/)
    await userEvent.type(input(), "also do X{Enter}")
    expect(a.calls["send"]).toEqual([["also do X"]])
  })

  it("Stop is not there while the agent is idle, nor when the agent cannot be stopped", () => {
    const idle = setup()
    expect(screen.queryByTestId("stop")).toBeNull()
    idle.view.unmount()
    setup({ live: live({ working: true }), capabilities: { ...noCaps, stop: false } })
    expect(screen.queryByTestId("stop")).toBeNull()
  })

  it("Stop asks the agent to stop; a failure shows its sentence", async () => {
    const stop = vi.fn().mockRejectedValue(new Error("Nothing to stop."))
    setup({ live: live({ working: true }) }, { stop })
    fireEvent.click(screen.getByTestId("stop"))
    expect((await screen.findByTestId("composer-error")).textContent).toBe("Nothing to stop.")
  })
})

describe("drafts", () => {
  it("what was typed comes back for the same agent, and not for another", () => {
    const first = setup({ draftKey: "t1" })
    fireEvent.change(first.input(), { target: { value: "half a thought" } })
    first.view.unmount()
    const again = setup({ draftKey: "t1" })
    expect(again.input().value).toBe("half a thought")
    again.view.unmount()
    expect(setup({ draftKey: "t2" }).input().value).toBe("")
  })
  it("a sent message leaves no draft behind", async () => {
    const a = setup({ draftKey: "t1" })
    await userEvent.type(a.input(), "sent{Enter}")
    await waitFor(() => expect(a.input().value).toBe(""))
    a.view.unmount()
    expect(setup({ draftKey: "t1" }).input().value).toBe("")
  })
})

describe("disabled states", () => {
  it("disconnected: the reason shows, nothing can be typed or sent, nothing is queued", () => {
    const { a, input } = setup({ disabledReason: "Disconnected from the backend." })
    expect(screen.getByTestId("composer-disabled").textContent).toBe("Disconnected from the backend.")
    expect(input().disabled).toBe(true)
    expect((screen.getByTestId("send") as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(input(), { key: "Enter" })
    expect(a.calls["send"]).toBeUndefined()
  })
  it("Stop is off too while disconnected", () => {
    setup({ disabledReason: "Core is away.", live: live({ working: true }) })
    expect((screen.getByTestId("stop") as HTMLButtonElement).disabled).toBe(true)
  })
  it("an agent that cannot take messages says so", () => {
    setup({ capabilities: { ...noCaps, send: false } })
    expect(screen.getByTestId("composer-disabled").textContent).toBe("This agent cannot take messages.")
    expect(screen.getByTestId("composer-input")).toHaveProperty("disabled", true)
  })
  it("with a reason cleared the box works again and keeps what was typed", () => {
    const { view, props, input } = setup({ disabledReason: "Core is away." })
    view.rerender(<Composer {...props} disabledReason={null} />)
    expect(input().disabled).toBe(false)
    expect(screen.queryByTestId("composer-disabled")).toBeNull()
  })
})

describe("slash commands", () => {
  it("is sent as it is, then says it was typed into the terminal, with a way to show it", async () => {
    const { a, input, onShowTerminal } = setup()
    await userEvent.type(input(), "/compact keep tests{Enter}")
    await waitFor(() => expect(screen.getByTestId("typed-note")).toBeTruthy())
    expect(a.calls["send"]).toEqual([["/compact keep tests"]])
    expect(screen.getByTestId("typed-note").textContent).toContain("Typed into the terminal")
    expect(onShowTerminal).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("show-terminal"))
    expect(onShowTerminal).toHaveBeenCalledTimes(1)
  })
  it("shows the note while the backend is still answering (core answers when pi has taken the command, seconds later), and drops it when the send fails", async () => {
    let fail!: (e: Error) => void
    const { input } = setup({}, { send: () => new Promise<void>((_, reject) => (fail = reject)) })
    await userEvent.type(input(), "/new{Enter}")
    expect(screen.getByTestId("typed-note")).toBeTruthy()
    expect(input().value).toBe("/new") // the text stays until the send is done
    await act(async () => fail(new Error("core refused")))
    expect(screen.queryByTestId("typed-note")).toBeNull()
    expect(screen.getByTestId("composer-error").textContent).toContain("core refused")
  })
  it("a command that opens a picker switches the pane to the terminal by itself", async () => {
    const { input, onShowTerminal } = setup()
    await userEvent.type(input(), "/resume{Enter}")
    await waitFor(() => expect(onShowTerminal).toHaveBeenCalledTimes(1))
  })
  it("a failed slash send shows no 'typed' note and does not switch", async () => {
    const { input, onShowTerminal } = setup({}, { send: async () => { throw new Error("no") } })
    await userEvent.type(input(), "/resume{Enter}")
    await screen.findByTestId("composer-error")
    expect(screen.queryByTestId("typed-note")).toBeNull()
    expect(onShowTerminal).not.toHaveBeenCalled()
  })
  it("the note goes away when the next message is typed", async () => {
    const { input } = setup()
    await userEvent.type(input(), "/new{Enter}")
    await screen.findByTestId("typed-note")
    await userEvent.type(input(), "x")
    expect(screen.queryByTestId("typed-note")).toBeNull()
  })
})

describe("model and effort", () => {
  it("each is hidden when the agent cannot do it, and effort when there is only one level", () => {
    setup()
    expect(screen.queryByTestId("model-select")).toBeNull()
    expect(screen.queryByTestId("effort-select")).toBeNull()
    setup({ capabilities: { ...noCaps, efforts: { list: ["off"], current: "off" } } })
    expect(screen.queryByTestId("effort-select")).toBeNull()
  })
  it("shows the current model and effort", () => {
    setup({ capabilities: fullCaps })
    expect(screen.getByTestId("model-select").textContent).toContain("Model A")
    expect(screen.getByTestId("effort-select").textContent).toContain("low")
  })
  it("a change shows at once, calls the agent, and stays when the agent reports it", async () => {
    let finish!: () => void
    const setEffort = vi.fn(() => new Promise<void>((r) => (finish = r)))
    const { view, props } = setup({ capabilities: fullCaps }, { setEffort })
    await userEvent.click(screen.getByTestId("effort-select"))
    await userEvent.click(await screen.findByRole("option", { name: "high" }))
    expect(screen.getByTestId("effort-select").textContent).toContain("high") // before the agent answered
    expect(setEffort).toHaveBeenCalledWith("high")
    await act(async () => finish())
    view.rerender(<Composer {...props} capabilities={{ ...fullCaps, efforts: { ...fullCaps.efforts!, current: "high" } }} />)
    expect(screen.getByTestId("effort-select").textContent).toContain("high")
  })
  it("a change that fails is put back, with the error", async () => {
    const setModel = vi.fn().mockRejectedValue(new Error("Model B is not loaded."))
    setup({ capabilities: fullCaps }, { setModel })
    await userEvent.click(screen.getByTestId("model-select"))
    await userEvent.click(await screen.findByRole("option", { name: "Model B" }))
    expect((await screen.findByTestId("composer-error")).textContent).toBe("Model B is not loaded.")
    await waitFor(() => expect(screen.getByTestId("model-select").textContent).toContain("Model A"))
  })
})

describe("context usage", () => {
  it("is a ring with the numbers for hover, and hidden when unknown", () => {
    setup({ live: live({ usage: { tokens: 54_300, window: 128_000, percent: 42.4 } }) })
    const ring = screen.getByTestId("usage")
    expect(ring.getAttribute("aria-label")).toBe("Context 42% · 54k of 128k tokens")
    expect(ring.getAttribute("data-percent")).toBe("42")
  })
  it("is not there without usage", () => {
    setup()
    expect(screen.queryByTestId("usage")).toBeNull()
  })
})
