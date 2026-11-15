// @vitest-environment jsdom
import { act, render } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

// Markdown is where an assistant row's cost is; counting its renders per text counts the row's renders.
const renders = vi.hoisted(() => new Map<string, number>())
vi.mock("@/components/chat/markdown", () => ({
  Markdown: ({ text }: { text: string }) => {
    renders.set(text, (renders.get(text) ?? 0) + 1)
    return <div>{text}</div>
  },
}))

import { ChatView } from "@/components/chat/chat-view"
import { assistant, fakeActions, live, manualStore, snapshot, thinking, tool, user } from "./helpers"
import type { Row } from "@herdr-web/agents/rows"

function thread(turns: number): Row[] {
  const rows: Row[] = []
  for (let i = 0; i < turns; i++) rows.push(user(`u${i}`), thinking(`th${i}`), tool(`tool${i}`), assistant(`a${i}`, `finished answer ${i}`))
  return rows
}

beforeEach(() => renders.clear())

describe("the smoothness rule: only the live row renders while a reply is written", () => {
  it("finished rows do not render again while text arrives, and the live row renders at most once per frame", () => {
    const { store, frame } = manualStore(snapshot(thread(25)))
    let commits = 0
    store.subscribe(() => commits++)
    render(<ChatView store={store} actions={fakeActions()} disabledReason={null} draftKey="t1" onShowTerminal={() => {}} />)
    for (let i = 0; i < 25; i++) expect(renders.get(`finished answer ${i}`)).toBe(1) // each once, on mount
    renders.clear()

    // a turn starts as it does in life: the user's row first, then the reply being written
    store.apply({ type: "update", seq: store.getState().seq + 1, rows: [user("u-new", "next question")], live: live({ working: true }) })
    act(() => frame())
    renders.clear()

    const FRAMES = 10
    const PER_FRAME = 7 // seven text updates between two animation frames
    let text = ""
    for (let f = 0; f < FRAMES; f++) {
      for (let k = 0; k < PER_FRAME; k++) {
        text += `word${f}-${k} `
        store.apply({ type: "update", seq: store.getState().seq + 1, live: live({ working: true, reply: { blocks: [{ kind: "text", text }] } }) })
      }
      act(() => frame())
    }

    for (let i = 0; i < 25; i++) expect(renders.get(`finished answer ${i}`) ?? 0).toBe(0)
    const liveRenders = [...renders.entries()].filter(([t]) => t.startsWith("word")).reduce((n, [, c]) => n + c, 0)
    expect(liveRenders).toBeLessThanOrEqual(FRAMES)
    expect(liveRenders).toBeGreaterThanOrEqual(FRAMES - 1)
  })

  it("an update that changes one row renders that row and no other", () => {
    const rows = thread(20)
    const { store, frame } = manualStore(snapshot(rows))
    render(<ChatView store={store} actions={fakeActions()} disabledReason={null} draftKey="t1" onShowTerminal={() => {}} />)
    renders.clear()
    store.apply({ type: "update", seq: 2, rows: [assistant("a5", "finished answer 5, edited")] })
    act(() => frame())
    expect(renders.get("finished answer 5, edited")).toBe(1)
    for (let i = 0; i < 20; i++) if (i !== 5) expect(renders.get(`finished answer ${i}`) ?? 0).toBe(0)
  })

  it("a row that arrives unchanged (the same row sent again) does not render", () => {
    const rows = thread(10)
    const { store, frame } = manualStore(snapshot(rows))
    render(<ChatView store={store} actions={fakeActions()} disabledReason={null} draftKey="t1" onShowTerminal={() => {}} />)
    renders.clear()
    store.apply({ type: "update", seq: 2, rows: [{ ...rows[3]! }, { ...rows[7]! }], live: live({ working: true }) }) // the last reply keeps its footer as the agent starts working
    act(() => frame())
    for (let i = 0; i < 10; i++) expect(renders.get(`finished answer ${i}`) ?? 0).toBe(0)
  })

  it("the finished row that replaces the live reply renders once, the older rows not at all", () => {
    const { store, frame } = manualStore(snapshot(thread(10)))
    render(<ChatView store={store} actions={fakeActions()} disabledReason={null} draftKey="t1" onShowTerminal={() => {}} />)
    store.apply({ type: "update", seq: 2, live: live({ working: true, reply: { blocks: [{ kind: "text", text: "the new answer" }] } }) })
    act(() => frame())
    renders.clear()
    store.apply({ type: "update", seq: 3, rows: [assistant("a-new", "the new answer")], live: live() })
    act(() => frame())
    expect(renders.get("the new answer")).toBe(1)
    for (let i = 0; i < 10; i++) expect(renders.get(`finished answer ${i}`) ?? 0).toBe(0)
  })
})
