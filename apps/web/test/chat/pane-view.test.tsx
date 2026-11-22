// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ClientMessage, ServerMessage } from "@herdr-web/protocol"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PaneView } from "@/components/shell/pane-view"
import { ChatFeed } from "@/lib/chat/feed"
import { HINT_KEY } from "@/lib/chat/pane"
import { ChatFeedProvider } from "@/lib/live-context"
import { agent, terminal } from "../fixtures"
import { assistant, snapshot, user } from "./helpers"

// The emulator needs a real browser; what these tests look at is whether it is mounted.
vi.mock("@/components/terminal/terminal-view", () => ({
  TerminalView: ({ terminal }: { terminal: { address: string } }) => <div data-testid="terminal-view" data-address={terminal.address} />,
}))

function mount(t = agent("t7", "idle", { chat: true }), away: "backend" | "core" | null = null) {
  const sent: ClientMessage[] = []
  const feed = new ChatFeed((m) => (sent.push(m), true))
  feed.setOpen(true)
  const tree = (term: typeof t, a: typeof away = away) => (
    <ChatFeedProvider value={feed}>
      <PaneView terminal={term} away={a} />
    </ChatFeedProvider>
  )
  const view = render(tree(t))
  const give = (m: ServerMessage) => act(() => feed.handle(m))
  const snap = (seq = 1) => give({ type: "chat.snapshot", terminal: "t7", snapshot: snapshot([user("u1", "hello there"), assistant("a1", "general kenobi")], { seq }) })
  return { feed, sent, give, snap, rerender: (term: typeof t, a: typeof away = away) => view.rerender(tree(term, a)) }
}
const subscribed = (sent: ClientMessage[]) => sent.filter((m) => m.type === "chat.subscribe").length
const unsubscribed = (sent: ClientMessage[]) => sent.filter((m) => m.type === "chat.unsubscribe").length

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe("the toggle", () => {
  it("opens on Chat for a terminal with chat, with the toggle, and no terminal socket", () => {
    const { snap, sent } = mount()
    snap()
    expect(screen.getByTestId("pane-view").dataset.view).toBe("chat")
    expect(screen.getByTestId("view-toggle")).toBeTruthy()
    expect(screen.queryByTestId("terminal-view")).toBeNull()
    expect(screen.getByTestId("chat").textContent).toContain("general kenobi")
    expect(subscribed(sent)).toBe(1)
  })
  it("shows Loading until the snapshot arrives", () => {
    mount()
    expect(screen.getByTestId("chat-waiting").textContent).toContain("Loading")
  })
  it("a terminal without chat shows the terminal and no toggle", () => {
    const { sent } = mount(terminal("t7"))
    expect(screen.getByTestId("terminal-view")).toBeTruthy()
    expect(screen.queryByTestId("view-toggle")).toBeNull()
    expect(subscribed(sent)).toBe(0)
  })
  it("only the shown side is live: Terminal mounts the terminal and drops the subscription, Chat the reverse", () => {
    const { snap, sent } = mount()
    snap()
    fireEvent.click(screen.getByTestId("view-terminal"))
    expect(screen.getByTestId("terminal-view").dataset.address).toBe("t7")
    expect(screen.queryByTestId("chat")).toBeNull()
    expect(unsubscribed(sent)).toBe(1)
    fireEvent.click(screen.getByTestId("view-chat"))
    expect(screen.queryByTestId("terminal-view")).toBeNull()
    expect(subscribed(sent)).toBe(2)
  })
  it("remembers the choice for that terminal, in the browser", () => {
    const { snap } = mount()
    snap()
    fireEvent.click(screen.getByTestId("view-terminal"))
    expect(localStorage.getItem("herdr-web.view.t7")).toBe("terminal")
    cleanup()
    mount()
    expect(screen.getByTestId("terminal-view")).toBeTruthy()
    expect(screen.getByTestId("view-terminal").getAttribute("aria-selected")).toBe("true")
  })
  it("a choice for one terminal does not move another", () => {
    localStorage.setItem("herdr-web.view.t8", "terminal")
    mount()
    expect(screen.getByTestId("pane-view").dataset.view).toBe("chat")
  })
  it("when chat appears while the pane is open, the toggle appears and the pane stays on the terminal", () => {
    const { rerender, sent } = mount(agent("t7", "idle"))
    expect(screen.queryByTestId("view-toggle")).toBeNull()
    rerender(agent("t7", "idle", { chat: true }))
    expect(screen.getByTestId("view-toggle")).toBeTruthy()
    expect(screen.getByTestId("pane-view").dataset.view).toBe("terminal")
    expect(screen.getByTestId("terminal-view")).toBeTruthy()
    expect(subscribed(sent)).toBe(0)
    fireEvent.click(screen.getByTestId("view-chat"))
    expect(subscribed(sent)).toBe(1)
  })
  it("a finished terminal shows its terminal view, which says how it ended, and no toggle", () => {
    mount(agent("t7", "idle", { chat: false, state: "finished" }))
    expect(screen.getByTestId("terminal-view")).toBeTruthy()
    expect(screen.queryByTestId("view-toggle")).toBeNull()
  })
})

describe("a pi with no chat in its pi-live, or with control off", () => {
  it("the rows are shown and the composer is off with the sentence it came with", () => {
    for (const disabled of ["Update pi-ask-user to chat with this pi.", "Control is off for this pi."]) {
      const { give } = mount()
      give({ type: "chat.snapshot", terminal: "t7", snapshot: snapshot([user("u1", "hello there"), assistant("a1", "general kenobi")], { seq: 1, capabilities: { send: false, stop: false, models: null, efforts: null, disabled } }) })
      expect(screen.getByTestId("chat").textContent).toContain("general kenobi")
      expect(screen.getByTestId("composer-disabled").textContent).toBe(disabled)
      expect((screen.getByTestId("composer-input") as HTMLTextAreaElement).disabled).toBe(true)
      expect(screen.getByTestId("chat-side").dataset.stale).toBe("false")
      cleanup()
    }
  })
})

describe("pi going away and coming back", () => {
  it("keeps the rows on screen, stale, with the composer off and a sentence; Terminal still works; a reset brings it back", () => {
    const { snap, give } = mount()
    snap()
    give({ type: "chat.unavailable", terminal: "t7", reason: "gone" })
    expect(screen.getByTestId("chat").textContent).toContain("general kenobi")
    expect(screen.getByTestId("chat-side").dataset.stale).toBe("true")
    expect(screen.getByTestId("composer-disabled").textContent).toMatch(/pi-live is not connected/)
    expect((screen.getByTestId("composer-input") as HTMLTextAreaElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId("view-terminal"))
    expect(screen.getByTestId("terminal-view")).toBeTruthy()
    fireEvent.click(screen.getByTestId("view-chat"))
    // watching again starts from the backend's answer: a snapshot
    give({ type: "chat.snapshot", terminal: "t7", snapshot: snapshot([user("n1", "a new session")], { seq: 1 }) })
    expect(screen.queryByTestId("composer-disabled")).toBeNull()
    expect(screen.getByTestId("chat").textContent).toContain("a new session")
  })
  it("a reset while the chat is on screen replaces the thread", () => {
    const { snap, give } = mount()
    snap()
    give({ type: "chat.unavailable", terminal: "t7", reason: "gone" })
    give({ type: "chat.change", terminal: "t7", change: { type: "reset", seq: 1, snapshot: snapshot([user("n1", "fresh start")], { seq: 1 }) } })
    expect(screen.getByTestId("chat").textContent).toContain("fresh start")
    expect(screen.getByTestId("chat").textContent).not.toContain("general kenobi")
    expect(screen.queryByTestId("composer-disabled")).toBeNull()
  })
  it("with no thread at all, says so and offers the terminal", () => {
    const { give } = mount()
    give({ type: "chat.unavailable", terminal: "t7", reason: "No agent is connected for this terminal." })
    expect(screen.getByTestId("chat-waiting").dataset.phase).toBe("unavailable")
    fireEvent.click(screen.getByRole("button", { name: /Show terminal/ }))
    expect(screen.getByTestId("terminal-view")).toBeTruthy()
  })
})

describe("the link being down", () => {
  it("turns the composer off and names the side that is down", () => {
    const { snap, rerender } = mount()
    snap()
    rerender(agent("t7", "idle", { chat: true }), "backend")
    expect(screen.getByTestId("composer-disabled").textContent).toMatch(/backend/)
    rerender(agent("t7", "idle", { chat: true }), "core")
    expect(screen.getByTestId("composer-disabled").textContent).toMatch(/core/)
    rerender(agent("t7", "idle", { chat: true }), null)
    expect(screen.queryByTestId("composer-disabled")).toBeNull()
  })
})

describe("the hint", () => {
  it("shows once above the terminal of a pi with no chat, naming the README section", () => {
    mount(agent("t7", "idle"))
    const hint = screen.getByTestId("extension-hint")
    expect(hint.textContent).toContain("pi-ask-user")
    expect(hint.textContent).toContain("Trying chat")
  })
  it("is dismissed for good, per browser", () => {
    mount(agent("t7", "idle"))
    fireEvent.click(screen.getByTestId("extension-hint-dismiss"))
    expect(screen.queryByTestId("extension-hint")).toBeNull()
    expect(localStorage.getItem(HINT_KEY)).toBe("1")
    cleanup()
    mount(agent("t7", "idle"))
    expect(screen.queryByTestId("extension-hint")).toBeNull()
  })
  it("is not shown for a shell, for a pi with chat, or for a pi on another machine", () => {
    mount(terminal("t7"))
    expect(screen.queryByTestId("extension-hint")).toBeNull()
    cleanup()
    mount(agent("t7", "idle", { chat: true }))
    expect(screen.queryByTestId("extension-hint")).toBeNull()
    cleanup()
    mount(agent("cachyos/t7", "idle"))
    expect(screen.queryByTestId("extension-hint")).toBeNull()
  })
})
