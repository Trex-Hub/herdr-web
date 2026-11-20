// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ChatView } from "@/components/chat/chat-view"
import { WINDOW } from "@/components/chat/thread-view"
import { assistant, fakeActions, feeder, identity, live, manualStore, snapshot, thinking, tool, user } from "./helpers"
import { ThreadStore } from "@/lib/chat/thread-store"

const mount = (store: ThreadStore, actions = fakeActions(), disabledReason: string | null = null) =>
  render(<ChatView store={store} actions={actions} disabledReason={disabledReason} draftKey="t1" onShowTerminal={() => {}} />)

describe("empty thread", () => {
  it("shows the agent's name and folder, and the composer", () => {
    mount(new ThreadStore(snapshot([])))
    const empty = screen.getByTestId("empty-thread")
    expect(empty.textContent).toContain("my-project")
    expect(empty.textContent).toContain("/work/my-project")
    expect(screen.getByTestId("composer")).toBeTruthy()
  })
  it("falls back to the terminal id when the session has no title", () => {
    mount(new ThreadStore(snapshot([], { identity: { ...identity, title: null } })))
    expect(screen.getByTestId("empty-thread").textContent).toContain("t1")
  })
  it("gives way to the thread as soon as the agent starts working", () => {
    const store = new ThreadStore(snapshot([]))
    mount(store)
    act(() => {
      feeder(store)({ live: live({ working: true }) })
    })
    expect(screen.queryByTestId("empty-thread")).toBeNull()
    expect(screen.getByTestId("working")).toBeTruthy()
  })
})

describe("the live row", () => {
  it("shows the reply as it is written, thinking and text, a running tool as a line with a spinner, and a quiet working mark", () => {
    const store = new ThreadStore(snapshot([user("u1", "go")]))
    mount(store)
    const feed = feeder(store)
    act(() => {
      feed({ live: live({ working: true, reply: { blocks: [{ kind: "thinking", text: "considering" }, { kind: "text", text: "Here is **bold**" }] }, tools: [{ callId: "c9", name: "bash" }] }) })
    })
    expect(screen.getByTestId("live-thinking").textContent).toContain("considering")
    expect(screen.getByTestId("live-text").textContent).toContain("Here is")
    expect(within(screen.getByTestId("live-tool")).getByTestId("tool-spinner")).toBeTruthy()
    expect(screen.getByTestId("working")).toBeTruthy()
  })

  it("a live tool shows the argument on the line and a ticking elapsed counter instead of a duration", () => {
    const store = new ThreadStore(snapshot([user("u1")], { live: live({ working: true, tools: [{ callId: "c9", name: "bash", argument: "node scripts/import.js exports/2026-03.csv" }] }) }))
    mount(store)
    const line = screen.getByTestId("live-tool")
    expect(line.textContent).toContain("node scripts/import.js exports/2026-03.csv")
    expect(within(line).getByTestId("live-tool-elapsed").textContent).toMatch(/^$|^\d+ s$|^\d+ min \d+ s$/)
  })

  it("the elapsed time of a live tool counts from when the page first saw it and ticks once a second, in whole seconds", () => {
    vi.useFakeTimers()
    try {
      const store = new ThreadStore(snapshot([user("u1")], { live: live({ working: true, tools: [{ callId: "c9", name: "bash", argument: "sleep 60" }] }) }))
      mount(store)
      const elapsed = () => screen.getByTestId("live-tool-elapsed").textContent
      expect(elapsed()).not.toMatch(/ms/) // whole seconds, nothing under 1 s
      act(() => void vi.advanceTimersByTime(3000))
      expect(elapsed()).toBe("3 s")
      act(() => void vi.advanceTimersByTime(12_000))
      expect(elapsed()).toBe("15 s")
      act(() => void vi.advanceTimersByTime(50_000))
      expect(elapsed()).toBe("1 min 5 s")
    } finally {
      vi.useRealTimers()
    }
  })

  it("the working mark is the last thing in the thread and goes when the agent settles", () => {
    const store = new ThreadStore(snapshot([user("u1")], { live: live({ working: true }) }))
    mount(store)
    expect(screen.getByTestId("working")).toBeTruthy()
    act(() => {
      feeder(store)({ live: live() })
    })
    expect(screen.queryByTestId("working")).toBeNull()
  })

  it("the finished row replaces the live one in the same update: never both on screen, never neither", async () => {
    const { store, frame } = manualStore(snapshot([user("u1")], { live: live({ working: true, reply: { blocks: [{ kind: "text", text: "The answer is forty-" }] } }) }))
    const snapshots: string[] = []
    mount(store)
    const watch = new MutationObserver(() => snapshots.push(`${screen.queryAllByTestId("live-text").length}${screen.queryAllByTestId("row-assistant").length}`))
    watch.observe(document.body, { childList: true, subtree: true })
    expect(screen.getAllByTestId("live-text")).toHaveLength(1)
    store.apply({ type: "update", seq: 2, rows: [assistant("a1", "The answer is forty-two.")], live: live() })
    await act(async () => frame())
    await waitFor(() => expect(screen.getAllByTestId("row-assistant")).toHaveLength(1))
    watch.disconnect()
    expect(screen.queryByTestId("live-text")).toBeNull()
    expect(screen.getByTestId("row-assistant").textContent).toContain("forty-two")
    // at no point was there a state with both (10 = live only, 01 = row only) or neither (00)
    expect(snapshots.filter((s) => s === "11" || s === "00")).toEqual([])
  })

  it("a tool that already has a row is shown by its row only, and a tool that ends turns its line into the finished row", () => {
    const running = tool("tool-1", { callId: "c1", status: "running", result: null, durationMs: null })
    const store = new ThreadStore(snapshot([user("u1"), running], { live: live({ working: true, tools: [{ callId: "c1", name: "bash" }] }) }))
    mount(store)
    expect(screen.queryAllByTestId("live-tool")).toHaveLength(0)
    expect(screen.getByTestId("row-tool").getAttribute("data-status")).toBe("running")
    act(() => {
      feeder(store)({ rows: [tool("tool-1", { callId: "c1" })], live: live({ working: true }) })
    })
    expect(screen.getAllByTestId("row-tool")).toHaveLength(1)
    expect(screen.getByTestId("row-tool").getAttribute("data-status")).toBe("ok")
  })

  it("two tools running at once show two lines, and either may end first", () => {
    const store = new ThreadStore(snapshot([user("u1")], { live: live({ working: true, tools: [{ callId: "c1", name: "bash" }, { callId: "c2", name: "read" }] }) }))
    mount(store)
    const feed = feeder(store)
    expect(screen.getAllByTestId("live-tool")).toHaveLength(2)
    act(() => {
      feed({ rows: [tool("tool-2", { callId: "c2", name: "read", args: { path: "a.ts" } })], live: live({ working: true, tools: [{ callId: "c1", name: "bash" }] }) })
    })
    expect(screen.getAllByTestId("live-tool")).toHaveLength(1)
    expect(screen.getAllByTestId("row-tool")).toHaveLength(1)
    act(() => {
      feed({ rows: [tool("tool-1", { callId: "c1" })], live: live({ working: true }) })
    })
    expect(screen.queryAllByTestId("live-tool")).toHaveLength(0)
    expect(screen.getAllByTestId("row-tool")).toHaveLength(2)
  })

  it("a notice the session file cannot hold shows as a quiet line", () => {
    mount(new ThreadStore(snapshot([user("u1")], { live: live({ notice: { level: "warning", text: "Compaction failed: Nothing to compact" } }) })))
    expect(screen.getByTestId("live-notice").textContent).toBe("Compaction failed: Nothing to compact")
  })
})

describe("pending messages", () => {
  const pending = [{ id: "p1", text: "also check the tests", mode: "steer" as const }, { id: "p2", text: "then summarise", mode: "followUp" as const }]
  it("show just above the composer as pending until the agent takes them, then are a normal row", () => {
    const store = new ThreadStore(snapshot([user("u1")], { live: live({ working: true, pending }) }))
    mount(store)
    const list = screen.getByTestId("pending")
    expect(within(list).getAllByTestId("pending-message").map((e) => [e.getAttribute("data-mode"), e.textContent])).toEqual([
      ["steer", "also check the testsPending: taken after the current step"],
      ["followUp", "then summarisePending: sent when the agent is done"],
    ])
    expect(list.compareDocumentPosition(screen.getByTestId("composer")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    act(() => {
      feeder(store)({ rows: [user("u2", "also check the tests")], live: live({ working: true, pending: [pending[1]!] }) })
    })
    expect(screen.getAllByTestId("pending-message")).toHaveLength(1)
    expect(within(screen.getByTestId("thread")).getByText("also check the tests")).toBeTruthy()
  })
  it("a steer stays pending for as long as the tool runs, however long", () => {
    const store = new ThreadStore(snapshot([user("u1"), tool("tool-1", { status: "running", result: null, durationMs: null })], { live: live({ working: true, pending: [pending[0]!] }) }))
    mount(store)
    act(() => {
      feeder(store)({ live: live({ working: true, pending: [pending[0]!] }) })
    })
    expect(screen.getAllByTestId("pending-message")).toHaveLength(1)
  })
})

describe("session change", () => {
  it("a reset swaps the whole thread", async () => {
    const store = new ThreadStore(snapshot([user("u1", "old question"), assistant("a1", "old answer")]))
    mount(store)
    expect(screen.getByText("old question")).toBeTruthy()
    act(() => {
      store.apply({ type: "reset", seq: 5, snapshot: snapshot([user("n1", "new session question")], { seq: 5 }) })
      store.flush()
    })
    await waitFor(() => expect(screen.getByText("new session question")).toBeTruthy())
    expect(screen.queryByText("old question")).toBeNull()
  })
})

describe("the composer in the chat view", () => {
  it("is off with the reason while the backend is away", () => {
    mount(new ThreadStore(snapshot([user("u1")])), fakeActions(), "Reconnecting to the backend. Nothing is queued.")
    expect(screen.getByTestId("composer-disabled").textContent).toBe("Reconnecting to the backend. Nothing is queued.")
  })
  it("every row kind in one thread renders in order", () => {
    const store = new ThreadStore(snapshot([user("u1"), thinking("th1"), tool("t1"), assistant("a1"), { kind: "compaction", id: "c1", at: 1, summary: "s", tokensBefore: null }, { kind: "notice", id: "n1", at: 1, level: "info", text: "Stopped." }]))
    mount(store)
    const kinds = [...screen.getByTestId("thread").querySelectorAll("[data-row-kind]")].map((e) => e.getAttribute("data-row-kind"))
    expect(kinds).toEqual(["user", "thinking", "tool", "assistant", "compaction", "notice"])
    expect(vi.isMockFunction(console.error)).toBe(false)
  })
})

describe("a long thread: the page holds a window of it", () => {
  const long = (n: number) => Array.from({ length: n }, (_, i) => assistant(`a${i}`, `answer ${i}`))
  const watchers: IntersectionObserverCallback[] = []
  const original = globalThis.IntersectionObserver
  beforeEach(() => {
    watchers.length = 0
    globalThis.IntersectionObserver = class {
      constructor(cb: IntersectionObserverCallback) {
        watchers.push(cb)
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return []
      }
    } as unknown as typeof IntersectionObserver
  })
  afterEach(() => {
    globalThis.IntersectionObserver = original
  })

  it("puts only the newest rows on the page, and more on it each time the reader reaches the top", () => {
    mount(new ThreadStore(snapshot(long(500))))
    expect(screen.getByText("answer 499")).toBeTruthy()
    expect(screen.getByText(`answer ${500 - WINDOW}`)).toBeTruthy()
    expect(screen.queryByText(`answer ${500 - WINDOW - 1}`)).toBeNull()
    expect(screen.getByTestId("older")).toBeTruthy()
    act(() => {
      for (const cb of watchers) cb([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
    })
    expect(screen.getByText(`answer ${500 - WINDOW - 1}`)).toBeTruthy()
    expect(screen.queryByText(`answer ${500 - WINDOW - 100}`)).toBeNull()
  })

  it("drops an older page that was asked for before a reset and answered after it", async () => {
    const store = new ThreadStore(snapshot(long(10), { hasMore: true }))
    let answer!: (page: { rows: ReturnType<typeof long>; hasMore: boolean }) => void
    const actions = fakeActions({ loadOlder: () => new Promise((resolve) => (answer = resolve)) })
    mount(store, actions)
    act(() => {
      for (const cb of watchers) cb([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
    })
    expect(store.getState().loadingOlder).toBe(true)
    act(() => store.replace(snapshot([assistant("n0", "the new thread")], { seq: 1 })))
    await act(async () => answer({ rows: [assistant("old", "from the old thread")], hasMore: true }))
    expect(store.getState().rows.map((r) => r.id)).toEqual(["n0"])
    expect(store.getState().hasMore).toBe(false)
    expect(screen.queryByText("from the old thread")).toBeNull()
  })

  it("shows a short thread whole, with nothing to reveal", () => {
    mount(new ThreadStore(snapshot(long(WINDOW))))
    expect(screen.getByText("answer 0")).toBeTruthy()
    expect(screen.queryByTestId("older")).toBeNull()
  })
})
