// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ChatView } from "@/components/chat/chat-view"
import { askOwnsWait } from "@/lib/chat/asks"
import { ThreadStore } from "@/lib/chat/thread-store"
import { askRow, assistant, fakeActions, feeder, live, questionAsk, snapshot, tool, user } from "./helpers"

// pi's own dialogs (`live.waiting`): one muted line in the live tail, which replaces "Working…", unless an ask_user call is behind it.

const confirm = { kind: "confirm", title: "Deploy?" }
const mount = (store: ThreadStore, onShowTerminal: () => void = () => {}) =>
  render(<ChatView store={store} actions={fakeActions()} disabledReason={null} draftKey="t1" onShowTerminal={onShowTerminal} />)
const after = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms)
  })
const storeWith = (waiting: { kind: string; title: string | null } | null, over: Parameters<typeof live>[0] = {}, rows = [user("u1"), assistant("a1")]) =>
  new ThreadStore(snapshot(rows, { live: live({ working: true, waiting, ...over }) }))

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe("the line", () => {
  it("names the dialog: the words, a colon and pi's title, after the 1 s grace", () => {
    mount(storeWith(confirm))
    after(1000)
    expect(screen.getByTestId("waiting-prefix").textContent).toBe("Waiting for you in the terminal")
    expect(screen.getByTestId("waiting-prefix-short").textContent).toBe("In the terminal") // what shows below the sm breakpoint
    expect(screen.getByTestId("waiting-title").textContent).toBe("Deploy?")
    expect(screen.getByTestId("waiting").getAttribute("data-kind")).toBe("confirm")
  })

  it("with no title is only the words", () => {
    mount(storeWith({ kind: "custom", title: null }))
    after(1000)
    expect(screen.getByTestId("waiting-prefix").textContent).toBe("Waiting for you in the terminal")
    expect(screen.queryByTestId("waiting-title")).toBeNull()
  })

  it("replaces Working… while it is shown, and Working… is back when the dialog is gone", () => {
    const store = storeWith(confirm)
    mount(store)
    expect(screen.getByTestId("working")).toBeTruthy() // within the grace, nothing else yet
    after(1000)
    expect(screen.queryByTestId("working")).toBeNull()
    act(() => {
      feeder(store)({ live: live({ working: true, waiting: null }) })
    })
    expect(screen.queryByTestId("waiting")).toBeNull()
    expect(screen.getByTestId("working")).toBeTruthy()
  })

  it("goes when the state clears, and a new dialog starts its own grace", () => {
    const store = storeWith(confirm)
    mount(store)
    after(1000)
    expect(screen.getByTestId("waiting")).toBeTruthy()
    act(() => {
      feeder(store)({ live: live({ working: true, waiting: null }) })
    })
    expect(screen.queryByTestId("waiting")).toBeNull()
    act(() => {
      feeder(store)({ live: live({ working: true, waiting: { kind: "select", title: "Pick" } }) })
    })
    after(999)
    expect(screen.queryByTestId("waiting")).toBeNull()
    after(1)
    expect(screen.getByTestId("waiting-title").textContent).toBe("Pick")
  })

  it("is not there for a dialog that opens and closes within the grace", () => {
    const store = storeWith(null)
    mount(store)
    act(() => {
      feeder(store)({ live: live({ working: true, waiting: confirm }) })
    })
    after(500)
    act(() => {
      feeder(store)({ live: live({ working: true, waiting: null }) })
    })
    after(2000)
    expect(screen.queryByTestId("waiting")).toBeNull()
  })

  it("Open terminal calls the switch, and the composer stays", () => {
    const onShowTerminal = vi.fn()
    mount(storeWith(confirm), onShowTerminal)
    after(1000)
    expect(screen.getByTestId("composer")).toBeTruthy()
    fireEvent.click(screen.getByTestId("open-terminal"))
    expect(onShowTerminal).toHaveBeenCalledTimes(1)
  })

  it("is on the page even when the agent is not working (a dialog of an extension at idle)", () => {
    mount(storeWith(confirm, { working: false }))
    after(1000)
    expect(screen.getByTestId("waiting")).toBeTruthy()
  })

  it("shows on a thread with no rows yet, instead of the empty thread", () => {
    mount(storeWith(confirm, { working: false }, []))
    after(1000)
    expect(screen.getByTestId("waiting")).toBeTruthy()
    expect(screen.queryByTestId("empty-thread")).toBeNull()
  })
})

describe("hidden when an ask_user call is behind it", () => {
  it("while a prompt is open, at once and for good, with the panel instead", () => {
    mount(storeWith({ kind: "custom", title: "Which color?" }, { asks: [questionAsk("call-q")] }))
    expect(screen.queryByTestId("waiting")).toBeNull()
    after(5000)
    expect(screen.queryByTestId("waiting")).toBeNull()
    expect(screen.getByTestId("ask-panel")).toBeTruthy()
  })

  it("while an ask_user tool is running live (the card for a prompt pi-live does not hold)", () => {
    mount(storeWith({ kind: "custom", title: "Which color?" }, { tools: [{ callId: "call-q", name: "ask_user", argument: "Which color?" }] }))
    after(5000)
    expect(screen.queryByTestId("waiting")).toBeNull()
    expect(screen.getByTestId("live-tool").getAttribute("data-name")).toBe("ask_user")
  })

  it("while its row is running", () => {
    mount(storeWith({ kind: "custom", title: "Which color?" }, {}, [user("u1"), askRow("q", { status: "running", result: null })]))
    after(5000)
    expect(screen.queryByTestId("waiting")).toBeNull()
  })

  it("the state may come before the prompt: nothing is shown if the prompt arrives within the grace", () => {
    const store = storeWith({ kind: "custom", title: "Which color?" })
    mount(store)
    after(600)
    act(() => {
      feeder(store)({ live: live({ working: true, waiting: { kind: "custom", title: "Which color?" }, asks: [questionAsk("call-q")] }) })
    })
    after(2000)
    expect(screen.queryByTestId("waiting")).toBeNull()
  })

  it("a dialog of another tool is still shown while an ask_user call is already answered (its row ended)", () => {
    mount(storeWith(confirm, {}, [user("u1"), askRow("q", { status: "ok" }), tool("t2")]))
    after(1000)
    expect(screen.getByTestId("waiting")).toBeTruthy()
  })

  it("a bash tool running is not an ask_user", () => {
    mount(storeWith(confirm, { tools: [{ callId: "c1", name: "bash", argument: "deploy.sh" }] }))
    after(1000)
    expect(screen.getByTestId("waiting")).toBeTruthy()
  })
})

describe("askOwnsWait", () => {
  const rows = (r: Parameters<typeof askOwnsWait>[0]["rows"]) => ({ live: { asks: [], tools: [] }, rows: r })
  it("is true for an open prompt, a live ask_user tool, or a running ask_user row anywhere in the thread", () => {
    expect(askOwnsWait({ live: { asks: [questionAsk("c")], tools: [] }, rows: [] })).toBe(true)
    expect(askOwnsWait({ live: { asks: [], tools: [{ callId: "c", name: "ask_user" }] }, rows: [] })).toBe(true)
    expect(askOwnsWait(rows([askRow("q", { status: "running", result: null }), user("u1"), tool("t")]))).toBe(true)
  })
  it("is false for none of them, an ended ask_user row, or other running tools", () => {
    expect(askOwnsWait(rows([]))).toBe(false)
    expect(askOwnsWait(rows([askRow("q", { status: "ok" }), askRow("r", { status: "interrupted", result: null })]))).toBe(false)
    expect(askOwnsWait({ live: { asks: [], tools: [{ callId: "c", name: "bash" }] }, rows: [tool("t", { status: "running" })] })).toBe(false)
  })
})
