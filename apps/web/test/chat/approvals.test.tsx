// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApprovalRecord } from "@herdr-web/agents/rows"
import type { ChatActions } from "@/lib/chat/actions"
import { ApprovalPanel } from "@/components/chat/approval-panel"
import { ChatView } from "@/components/chat/chat-view"
import { ThreadStore } from "@/lib/chat/thread-store"
import { APPROVAL_GUARD_MS, approvalCallId, approvalChoices, approvalLineFor, approvalLineFromKey, approvalLineKey, approvalLineText, approvalQuestion, grantDetail } from "@/lib/chat/approvals"
import { commandApproval, LONG_COMMAND, pathApproval } from "@/dev/fixtures"
import { fakeActions, live, snapshot, tool } from "./helpers"

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const record = (over: Partial<ApprovalRecord> = {}): ApprovalRecord => ({ id: "a", kind: "guardrails.command", callId: "c1", subject: "rm -rf x", by: "client", result: "allow", label: "Allow once", ...over })

describe("what the card offers", () => {
  it("a command: Allow once first, Allow for session behind the arrow, Deny, and Decline and stop", () => {
    const c = approvalChoices(commandApproval("g", "rm -rf x", "c1"))
    expect(c.primary?.result).toBe("allow")
    expect(c.grants.map((g) => g.result)).toEqual(["allow-session"])
    expect(c.deny?.result).toBe("deny")
    expect(c.stop?.result).toBe("stop")
  })
  it("a path: the file once is primary, the rest in the prompt's order, no stop", () => {
    const c = approvalChoices(pathApproval("g", "c1"))
    expect(c.primary?.result).toBe("allow-file-once")
    expect(c.grants.map((g) => g.result)).toEqual(["allow-dir-once", "allow-file-session", "allow-dir-session", "allow-file-always", "allow-dir-always"])
    expect(c.stop).toBeNull()
  })
  it("no allow-once on offer: no primary, every allow in the menu", () => {
    const a = pathApproval("g", "c1")
    a.view.options = a.view.options.filter((o) => !o.result.endsWith("-once"))
    const c = approvalChoices(a)
    expect(c.primary).toBeNull()
    expect(c.grants).toHaveLength(4)
  })
  it("says what each grant covers, where an always one is saved, and why a disabled one is off", () => {
    const a = pathApproval("g", "c1", true)
    const by = (r: string) => a.view.options.find((o) => o.result === r)!
    expect(grantDetail(a, by("allow-dir-once"))).toBe("/Users/dev/.ssh")
    expect(grantDetail(a, by("allow-file-session"))).toBe("/Users/dev/.ssh/config · until this pi session ends")
    expect(grantDetail(a, by("allow-dir-always"))).toBe("Not available: project not trusted")
    const trusted = pathApproval("g", "c1")
    expect(grantDetail(trusted, trusted.view.options.find((o) => o.result === "allow-file-always")!)).toBe("/Users/dev/.ssh/config · Saved to this project's guardrails settings")
    const c = commandApproval("g", "x", "c1")
    expect(grantDetail(c, c.view.options[1]!)).toBe("This exact command, until this pi session ends")
  })
  it("asks the question that fits", () => {
    expect(approvalQuestion(commandApproval("g", "x", "c1"))).toBe("Run this command?")
    expect(approvalQuestion(pathApproval("g", "c1"))).toBe("Use a file outside the workspace?")
    const dir = pathApproval("g", "c1")
    ;(dir.view as { target: string }).target = "directory"
    expect(approvalQuestion(dir)).toBe("Open a folder outside the workspace?")
  })
})

describe("the line under the call", () => {
  it("pins to the parent's call for a nested one, the call's own otherwise, none when unnamed", () => {
    expect(approvalCallId(commandApproval("g", "x", "p/1", { parentToolCallId: "p" }))).toBe("p")
    expect(approvalCallId(commandApproval("g", "x", "c1"))).toBe("c1")
    expect(approvalCallId(commandApproval("g", "x", undefined))).toBeNull()
  })
  it("an open prompt wins over a record for the same call; else the newest record", () => {
    const l = { approvals: [commandApproval("g2", "x", "c1")], approved: [record({ id: "g1" })] }
    expect(approvalLineFor(l, "c1")).toEqual({ kind: "open", id: "g2" })
    expect(approvalLineFor({ approvals: [], approved: [record({ id: "1", result: "deny" }), record({ id: "2", result: "allow" })] }, "c1")).toEqual({ kind: "record", record: record({ id: "2", result: "allow" }) })
    expect(approvalLineFor({ approvals: [], approved: [] }, "c1")).toBeNull()
  })
  it("its key round-trips and stays equal while nothing changes", () => {
    const l = { approvals: [], approved: [record()] }
    const key = approvalLineKey(l, "c1")
    expect(approvalLineKey({ approvals: [], approved: [record()] }, "c1")).toBe(key)
    expect(approvalLineFromKey(key)).toEqual(approvalLineFor(l, "c1"))
    expect(approvalLineFromKey("")).toBeNull()
  })
  it("reads as how the prompt ended", () => {
    const text = (r: Partial<ApprovalRecord>) => approvalLineText({ kind: "record", record: record(r) }).text
    expect(approvalLineText({ kind: "open", id: "g" })).toEqual({ text: "Awaiting approval", tone: "waiting" })
    expect(text({ result: "allow-dir-always" })).toBe("Always allowed this folder")
    expect(text({ result: "stop" })).toBe("Denied and stopped")
    expect(text({ result: "something-new", label: "Something new" })).toBe("Answered: Something new")
    expect(text({ result: "constructor", label: "C" })).toBe("Answered: C")
    expect(text({ result: null, label: null })).toBe("Answered in another window")
    expect(text({ by: "keyboard", result: null })).toBe("Answered in the terminal")
    expect(text({ by: "abort", result: null })).toBe("Denied: the agent was stopped")
    expect(text({ by: "gone", result: null })).toBe("Not answered: pi closed the prompt")
  })
})

describe("the card", () => {
  const open = (answer: ChatActions["answer"] & { mock: unknown } = vi.fn<ChatActions["answer"]>(async () => ({ status: "delivered" })), approvals = [commandApproval("g", "rm -rf ./build", "c1")], disabledReason: string | null = null) => {
    const actions = fakeActions({ answer })
    render(<ApprovalPanel approvals={approvals} actions={actions} disabledReason={disabledReason} onShowTerminal={() => {}} />)
    return answer
  }
  const pass = () => act(() => vi.advanceTimersByTime(APPROVAL_GUARD_MS + 1))

  it("keeps Allow off for the guard, then sends the result it offered", async () => {
    const answer = open()
    const allow = screen.getByTestId("approval-allow") as HTMLButtonElement
    expect(allow.disabled).toBe(true)
    fireEvent.click(allow)
    expect(answer).not.toHaveBeenCalled()
    pass()
    expect(allow.disabled).toBe(false)
    await act(async () => fireEvent.click(allow))
    expect(answer).toHaveBeenCalledWith("g", { result: "allow" })
    expect(screen.getByTestId("approval-sent").textContent).toBe("Allow once. Waiting for pi…")
  })
  it("Deny works during the guard; Escape denies too", async () => {
    const answer = open()
    await act(async () => fireEvent.keyDown(document, { key: "Escape" }))
    expect(answer).toHaveBeenCalledWith("g", { result: "deny" })
  })
  it("Enter alone never approves; ⌘/Ctrl+Enter allows once after the guard", async () => {
    const answer = open()
    pass()
    const allow = screen.getByTestId("approval-allow")
    allow.focus()
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    allow.dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(true)
    await act(async () => fireEvent.keyDown(document, { key: "Enter" }))
    expect(answer).not.toHaveBeenCalled()
    await act(async () => fireEvent.keyDown(document, { key: "Enter", ctrlKey: true }))
    expect(answer).toHaveBeenCalledWith("g", { result: "allow" })
  })
  it("⌘/Ctrl+Enter does nothing during the guard", async () => {
    const answer = open()
    await act(async () => fireEvent.keyDown(document, { key: "Enter", metaKey: true }))
    expect(answer).not.toHaveBeenCalled()
  })
  it("Deny and stop is guarded like Allow (it aborts the turn), then sends stop", async () => {
    const answer = open()
    fireEvent.click(screen.getByTestId("approval-stop"))
    expect(answer).not.toHaveBeenCalled()
    pass()
    await act(async () => fireEvent.click(screen.getByTestId("approval-stop")))
    expect(answer).toHaveBeenCalledWith("g", { result: "stop" })
  })
  it("says Sending… while the answer is on its way", async () => {
    let settle: (v: { status: "delivered" }) => void = () => {}
    open(vi.fn<ChatActions["answer"]>(() => new Promise((r) => (settle = r))))
    await act(async () => fireEvent.click(screen.getByTestId("approval-deny")))
    expect(screen.getByTestId("approval-sending").textContent).toBe("Sending…")
    await act(async () => settle({ status: "delivered" }))
    expect(screen.queryByTestId("approval-sending")).toBeNull()
    expect(screen.getByTestId("approval-sent").textContent).toBe("Deny. Waiting for pi…")
  })
  it("a long single line folds too, with its own button text", () => {
    open(undefined, [commandApproval("g", "x".repeat(3000), "c1")])
    expect(screen.getByTestId("approval-command").dataset["folded"]).toBe("true")
    expect(screen.getByTestId("approval-command-more").textContent).toBe("Show the whole command")
  })
  it("says why pi refused, and lets you try again", async () => {
    const answer = vi.fn<ChatActions["answer"]>().mockResolvedValueOnce({ status: "invalid", reason: 'option "allow" not offered' }).mockResolvedValueOnce({ status: "delivered" })
    open(answer)
    pass()
    await act(async () => fireEvent.click(screen.getByTestId("approval-allow")))
    expect(screen.getByTestId("approval-rejected").textContent).toBe('pi did not take that: option "allow" not offered')
    await act(async () => fireEvent.click(screen.getByTestId("approval-deny")))
    expect(answer).toHaveBeenLastCalledWith("g", { result: "deny" })
  })
  it("a prompt answered elsewhere says so and takes nothing more", async () => {
    const answer = open(vi.fn<ChatActions["answer"]>(async () => ({ status: "closed" })))
    pass()
    await act(async () => fireEvent.click(screen.getByTestId("approval-allow")))
    expect(screen.getByTestId("approval-closed")).toBeTruthy()
    expect((screen.getByTestId("approval-deny") as HTMLButtonElement).disabled).toBe(true)
    expect(answer).toHaveBeenCalledTimes(1)
  })
  it("a failed send says why", async () => {
    open(vi.fn<ChatActions["answer"]>(async () => Promise.reject(new Error("backend away"))))
    pass()
    await act(async () => fireEvent.click(screen.getByTestId("approval-allow")))
    expect(screen.getByTestId("approval-error").textContent).toMatch(/backend away/)
  })
  it("off while disconnected", async () => {
    const answer = open(undefined, undefined, "Reconnecting…")
    pass()
    expect((screen.getByTestId("approval-allow") as HTMLButtonElement).disabled).toBe(true)
    await act(async () => fireEvent.keyDown(document, { key: "Escape" }))
    expect(answer).not.toHaveBeenCalled()
    expect(screen.getByTestId("approval-disabled").textContent).toBe("Reconnecting…")
  })
  it("shows the whole command, numbered, folded past 12 lines until opened", () => {
    open(undefined, [commandApproval("g", LONG_COMMAND, "c1")])
    const block = screen.getByTestId("approval-command")
    expect(block.dataset["folded"]).toBe("true")
    expect(block.textContent).toContain("rm -rf ./build ./dist ./node_modules/.cache")
    expect(screen.getByTestId("approval-command-more").textContent).toBe("Show all 30 lines")
    fireEvent.click(screen.getByTestId("approval-command-more"))
    expect(block.dataset["folded"]).toBe("false")
  })
  it("the oldest of several shows, with how many wait", () => {
    open(undefined, [commandApproval("g1", "a", "c1"), pathApproval("g2", "c2")])
    expect(screen.getByTestId("approval-card").dataset["kind"]).toBe("guardrails.command")
    expect(screen.getByTestId("approval-count").textContent).toBe("1 of 2")
  })
})

describe("in the chat", () => {
  it("takes the composer's place and the line goes under its call; the terminal line stays hidden", () => {
    const store = new ThreadStore(snapshot([tool("c1", { callId: "c1", name: "bash", status: "running", result: null })], { live: live({ working: true, approvals: [commandApproval("g", "rm -rf x", "c1")], waiting: { kind: "custom", title: "Dangerous command" } }) }))
    render(<ChatView store={store} actions={fakeActions()} disabledReason={null} draftKey="k" onShowTerminal={() => {}} />)
    expect(screen.queryByTestId("composer")).toBeNull()
    expect(screen.getByTestId("approval-panel")).toBeTruthy()
    expect(screen.getByTestId("approval-line").textContent).toBe("Awaiting approval")
    act(() => vi.advanceTimersByTime(2000))
    expect(screen.queryByTestId("waiting")).toBeNull()
  })
})
