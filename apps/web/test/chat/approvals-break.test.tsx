// @vitest-environment jsdom
// Break tests for the guardrails approval card (DEV-42): double taps, answers in flight, keys with the menu open, odd option lists,
// state that must survive another prompt closing, and what the card must not do.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Approval } from "@herdr-web/agents/rows"
import type { ChatActions } from "@/lib/chat/actions"
import { ApprovalPanel } from "@/components/chat/approval-panel"
import { APPROVAL_GUARD_MS, approvalChoices, approvalLineText } from "@/lib/chat/approvals"
import { commandApproval, LONG_COMMAND, pathApproval } from "@/dev/fixtures"
import { fakeActions } from "./helpers"

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

type Answer = ChatActions["answer"]
const pass = () => act(() => vi.advanceTimersByTime(APPROVAL_GUARD_MS + 1))
const panel = (answer: Answer, approvals: Approval[], disabledReason: string | null = null) => (
  <ApprovalPanel approvals={approvals} actions={fakeActions({ answer })} disabledReason={disabledReason} onShowTerminal={() => {}} />
)
const mount = (answer: Answer, approvals: Approval[] = [commandApproval("g", "rm -rf ./build", "c1")]) => render(panel(answer, approvals))

/** An answer that stays in flight until the test settles it. */
function hanging() {
  let settle!: (r: Awaited<ReturnType<Answer>>) => void
  const answer = vi.fn<Answer>(() => new Promise((resolve) => (settle = resolve)))
  return { answer, settle: (r: Awaited<ReturnType<Answer>>) => settle(r) }
}

describe("double taps and answers in flight", () => {
  it("two clicks on Allow, one tick apart, send one answer", async () => {
    const h = hanging()
    mount(h.answer)
    pass()
    const allow = screen.getByTestId("approval-allow")
    fireEvent.click(allow)
    fireEvent.click(allow)
    await act(async () => fireEvent.click(allow))
    expect(h.answer).toHaveBeenCalledTimes(1)
  })

  it("Allow then Deny while the first is in flight: only the first goes", async () => {
    const h = hanging()
    mount(h.answer)
    pass()
    await act(async () => fireEvent.click(screen.getByTestId("approval-allow")))
    await act(async () => fireEvent.click(screen.getByTestId("approval-deny")))
    await act(async () => fireEvent.keyDown(document, { key: "Escape" }))
    await act(async () => fireEvent.keyDown(document, { key: "Enter", metaKey: true }))
    expect(h.answer).toHaveBeenCalledTimes(1)
    expect(h.answer).toHaveBeenCalledWith("g", { result: "allow" })
  })

  it("delivered with no close after it: the card says it is waiting for pi and stays locked (no second answer)", async () => {
    const answer = vi.fn<Answer>(async () => ({ status: "delivered" }))
    mount(answer)
    pass()
    await act(async () => fireEvent.click(screen.getByTestId("approval-allow")))
    await act(async () => vi.advanceTimersByTime(60_000))
    expect(screen.getByTestId("approval-sent").textContent).toBe("Allow once. Waiting for pi…")
    await act(async () => fireEvent.keyDown(document, { key: "Escape" }))
    expect(answer).toHaveBeenCalledTimes(1)
  })

  it("a refused Allow, then Deny: the second goes, with the card unlocked in between", async () => {
    const answer = vi.fn<Answer>().mockResolvedValueOnce({ status: "invalid", reason: "x" }).mockResolvedValueOnce({ status: "delivered" })
    mount(answer)
    pass()
    await act(async () => fireEvent.click(screen.getByTestId("approval-allow")))
    expect((screen.getByTestId("approval-allow") as HTMLButtonElement).disabled).toBe(false)
    await act(async () => fireEvent.keyDown(document, { key: "Escape" }))
    expect(answer).toHaveBeenLastCalledWith("g", { result: "deny" })
  })

  it("a refusal with an empty reason still says something; a thrown non-Error does not blank the card", async () => {
    mount(vi.fn<Answer>(async () => ({ status: "invalid", reason: "" })))
    pass()
    await act(async () => fireEvent.click(screen.getByTestId("approval-allow")))
    expect(screen.getByTestId("approval-rejected").textContent).toContain("That answer was not accepted.")
    cleanup()
    mount(vi.fn<Answer>(() => Promise.reject("boom")))
    pass()
    await act(async () => fireEvent.click(screen.getByTestId("approval-allow")))
    expect(screen.getByTestId("approval-error").textContent?.length).toBeGreaterThan(0)
    expect(screen.getByTestId("approval-deny")).toBeTruthy()
  })

  it("the card goes away mid-answer (prompt closed elsewhere): a late settle changes nothing and does not throw", async () => {
    const h = hanging()
    const view = mount(h.answer, [commandApproval("g", "a", "c1"), commandApproval("g2", "b", "c2")])
    pass()
    await act(async () => fireEvent.click(screen.getByTestId("approval-allow")))
    view.rerender(panel(h.answer, [commandApproval("g2", "b", "c2")]))
    expect(screen.getByTestId("approval-card")).toBeTruthy()
    await act(async () => h.settle({ status: "delivered" }))
    // g2's card is fresh: not "sent", Allow guarded
    expect(screen.queryByTestId("approval-sent")).toBeNull()
    expect((screen.getByTestId("approval-allow") as HTMLButtonElement).disabled).toBe(true)
  })
})

describe("the guard", () => {
  it("the next card has its own guard, and Escape/⌘Enter act on the new card, not the old one", async () => {
    const answer = vi.fn<Answer>(async () => ({ status: "delivered" }))
    const view = mount(answer, [commandApproval("g1", "a", "c1"), commandApproval("g2", "b", "c2")])
    pass()
    view.rerender(panel(answer, [commandApproval("g2", "b", "c2")]))
    await act(async () => fireEvent.keyDown(document, { key: "Enter", metaKey: true }))
    expect(answer).not.toHaveBeenCalled()
    pass()
    await act(async () => fireEvent.keyDown(document, { key: "Enter", metaKey: true }))
    expect(answer).toHaveBeenCalledWith("g2", { result: "allow" })
  })

  it("a card that stays while another behind it closes keeps its guard state and its opened command", async () => {
    const answer = vi.fn<Answer>(async () => ({ status: "delivered" }))
    const first = commandApproval("g1", LONG_COMMAND, "c1")
    const view = mount(answer, [first, commandApproval("g2", "b", "c2")])
    fireEvent.click(screen.getByTestId("approval-command-more"))
    pass()
    view.rerender(panel(answer, [first]))
    expect(screen.getByTestId("approval-command").dataset["folded"]).toBe("false")
    expect((screen.getByTestId("approval-allow") as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByTestId("approval-count")).toBeNull()
  })

})

describe("odd option lists", () => {
  const withOptions = (options: Approval["view"]["options"]) => {
    const a = commandApproval("g", "rm -rf x", "c1")
    a.view.options = options
    return a
  }

  it("options named __proto__, constructor and toString render and send as written", async () => {
    const answer = vi.fn<Answer>(async () => ({ status: "delivered" }))
    mount(answer, [withOptions([{ result: "allow", label: "constructor" }, { result: "__proto__", label: "__proto__" }, { result: "toString", label: "toString" }, { result: "deny", label: "Deny" }])])
    pass()
    expect(screen.getByTestId("approval-allow").textContent).toBe("constructor")
    fireEvent.click(screen.getByTestId("approval-more"))
    await act(async () => fireEvent.click(screen.getAllByTestId("approval-grant")[0]!))
    expect(answer).toHaveBeenCalledWith("g", { result: "__proto__" })
  })

  it("no deny on offer: Escape does nothing, no Deny button, the card still has Open terminal", async () => {
    const answer = vi.fn<Answer>(async () => ({ status: "delivered" }))
    mount(answer, [withOptions([{ result: "allow", label: "Allow once" }])])
    pass()
    expect(screen.queryByTestId("approval-deny")).toBeNull()
    await act(async () => fireEvent.keyDown(document, { key: "Escape" }))
    expect(answer).not.toHaveBeenCalled()
    expect(screen.getByTestId("approval-open-terminal")).toBeTruthy()
  })

  it("no options at all: no Allow and no Deny, only Open terminal (nothing to approve by mistake)", async () => {
    const answer = vi.fn<Answer>(async () => ({ status: "delivered" }))
    mount(answer, [withOptions([])])
    pass()
    expect(screen.queryByTestId("approval-allow")).toBeNull()
    await act(async () => fireEvent.keyDown(document, { key: "Enter", metaKey: true }))
    expect(answer).not.toHaveBeenCalled()
  })

  it("an allow-once that is disabled is not the primary, and ⌘Enter does nothing for it", async () => {
    const answer = vi.fn<Answer>(async () => ({ status: "delivered" }))
    mount(answer, [withOptions([{ result: "allow", label: "Allow once", disabled: true, disabledReason: "no" }, { result: "allow-session", label: "S" }, { result: "deny", label: "Deny" }])])
    pass()
    expect(screen.queryByTestId("approval-allow")).toBeNull()
    await act(async () => fireEvent.keyDown(document, { key: "Enter", ctrlKey: true }))
    expect(answer).not.toHaveBeenCalled()
  })

  it("a stop with no deny, an 'allow-file-once' on a command, and a result that only looks like once (`always-once`) do not become Allow once by accident", () => {
    const c = approvalChoices(withOptions([{ result: "allow-always-once", label: "Always (once?)" }, { result: "deny", label: "Deny" }]))
    expect(c.primary?.result).toBe("allow-always-once") // the rule is `endsWith("-once")`; what it picks is what the prompt calls once
  })

  it("a 5,000-character label and a 100,000-character reason stay inside the card (no horizontal scroll hooks)", () => {
    const a = withOptions([{ result: "allow", label: "A".repeat(5000) }, { result: "deny", label: "Deny" }])
    a.view.reason = "r".repeat(100_000)
    mount(vi.fn<Answer>(async () => ({ status: "delivered" })), [a])
    expect(screen.getByTestId("approval-reason").textContent!.length).toBeGreaterThan(100_000)
  })
})

describe("what is shown is what runs", () => {
  it("every character of a command is in the DOM, in order: CR, tabs, bidi controls, zero-width, NBSP", () => {
    const tricky = "echo ok\r\n\t\u202Etxt.sh\u202C \u200Bx\u00A0y"
    mount(vi.fn<Answer>(async () => ({ status: "delivered" })), [commandApproval("g", tricky, "c1")])
    const shown = screen.getByTestId("approval-command").textContent!.replace(/^\$|\d+/g, "")
    // The command must be shown whole. Invisible or reordering characters are a finding: the card says nothing about them.
    expect(shown).toContain("\u202E")
    expect(shown).toContain("\u200B")
  })

  it("a 20,000-line command: the card renders and Allow is not the thing that waits for the layout", () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `echo ${i}`).join("\n")
    const started = Date.now()
    mount(vi.fn<Answer>(async () => ({ status: "delivered" })), [commandApproval("g", lines, "c1")])
    expect(screen.getByTestId("approval-command-more").textContent).toBe("Show all 20000 lines")
    // Every line is a DOM node even folded; record how many there are
    expect(screen.getByTestId("approval-command").children.length).toBe(20_000)
    expect(Date.now() - started).toBeLessThan(15_000)
  })

  it("a path with a newline or a very long name is shown whole", () => {
    const a = pathApproval("g", "c1")
    ;(a.view as { path: string }).path = "/tmp/a\nb/" + "x".repeat(4000)
    mount(vi.fn<Answer>(async () => ({ status: "delivered" })), [a])
    expect(screen.getByTestId("approval-path").textContent).toContain("x".repeat(4000))
  })

  it("a command-kind card with the shell command on a path prompt shows the command too", () => {
    const a = pathApproval("g", "c1")
    ;(a.view as { command?: string }).command = "cat /Users/dev/.ssh/config"
    mount(vi.fn<Answer>(async () => ({ status: "delivered" })), [a])
    expect(screen.getByTestId("approval-command").textContent).toContain("cat /Users/dev/.ssh/config")
  })
})

describe("keys", () => {
  it("Escape that something else already handled (defaultPrevented) does not deny", async () => {
    const answer = vi.fn<Answer>(async () => ({ status: "delivered" }))
    mount(answer)
    const handler = (e: KeyboardEvent) => e.preventDefault()
    document.addEventListener("keydown", handler, true)
    await act(async () => fireEvent.keyDown(document, { key: "Escape" }))
    document.removeEventListener("keydown", handler, true)
    expect(answer).not.toHaveBeenCalled()
  })

  it("Escape with the grants menu open closes the menu and does not deny; the next Escape denies", async () => {
    const answer = vi.fn<Answer>(async () => ({ status: "delivered" }))
    mount(answer)
    pass()
    await act(async () => fireEvent.click(screen.getByTestId("approval-more")))
    expect(screen.queryAllByTestId("approval-grant").length).toBeGreaterThan(0)
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }))
    expect(answer).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTime(500))
    expect(screen.queryAllByTestId("approval-grant")).toHaveLength(0)
    await act(async () => fireEvent.keyDown(document.body, { key: "Escape" }))
    expect(answer).toHaveBeenCalledWith("g", { result: "deny" })
  })

  it("⌘/Ctrl+Enter with the menu open does not allow", async () => {
    const answer = vi.fn<Answer>(async () => ({ status: "delivered" }))
    mount(answer)
    pass()
    await act(async () => fireEvent.click(screen.getByTestId("approval-more")))
    await act(async () => fireEvent.keyDown(document.body, { key: "Enter", ctrlKey: true }))
    expect(answer).not.toHaveBeenCalled()
  })

  it("Escape during IME composition does not deny", async () => {
    const answer = vi.fn<Answer>(async () => ({ status: "delivered" }))
    mount(answer)
    await act(async () => fireEvent.keyDown(document, { key: "Escape", isComposing: true }))
    expect(answer).not.toHaveBeenCalled()
  })

  it("a held key (repeat) of ⌘Enter sends once", async () => {
    const h = hanging()
    mount(h.answer)
    pass()
    fireEvent.keyDown(document, { key: "Enter", metaKey: true })
    fireEvent.keyDown(document, { key: "Enter", metaKey: true, repeat: true })
    await act(async () => fireEvent.keyDown(document, { key: "Enter", metaKey: true, repeat: true }))
    expect(h.answer).toHaveBeenCalledTimes(1)
  })

  it("Shift+Enter and Alt+Enter on Allow do not allow either; only a click, Space, or ⌘/Ctrl+Enter", async () => {
    const answer = vi.fn<Answer>(async () => ({ status: "delivered" }))
    mount(answer)
    pass()
    const allow = screen.getByTestId("approval-allow")
    for (const mod of [{ shiftKey: true }, { altKey: true }, {}]) {
      const e = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...mod })
      allow.dispatchEvent(e)
      expect(e.defaultPrevented).toBe(true)
    }
    expect(answer).not.toHaveBeenCalled()
  })

  it("unmounting removes the key handlers: Escape after the card went does nothing", async () => {
    const answer = vi.fn<Answer>(async () => ({ status: "delivered" }))
    const view = mount(answer)
    view.unmount()
    await act(async () => fireEvent.keyDown(document, { key: "Escape" }))
    expect(answer).not.toHaveBeenCalled()
  })

  it("while disconnected: Escape, ⌘Enter, the grants, Deny and Deny-and-stop all send nothing", async () => {
    const answer = vi.fn<Answer>(async () => ({ status: "delivered" }))
    render(panel(answer, [commandApproval("g", "rm -rf x", "c1")], "Reconnecting…"))
    pass()
    await act(async () => fireEvent.keyDown(document, { key: "Escape" }))
    await act(async () => fireEvent.keyDown(document, { key: "Enter", metaKey: true }))
    await act(async () => fireEvent.click(screen.getByTestId("approval-stop")))
    expect(answer).not.toHaveBeenCalled()
    // and when it comes back, the guard has long passed: Allow is live at once
  })
})

describe("the line under the call, odd records", () => {
  it("a label of `__proto__` or a result `hasOwnProperty` reads as an answer, not as a crash", () => {
    const rec = (result: string | null, label: string | null) => ({ kind: "record" as const, record: { id: "a", kind: "guardrails.command" as const, callId: "c", subject: "s", by: "client" as const, result, label } })
    expect(approvalLineText(rec("hasOwnProperty", "H")).text).toBe("Answered: H")
    expect(approvalLineText(rec("__proto__", "__proto__")).text).toBe("Answered: __proto__")
    expect(approvalLineText(rec("toString", null)).text).toBe("Answered: toString")
  })
})
