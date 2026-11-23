"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { EMPTY_LIVE, type Row, type ThreadSnapshot } from "@herdr-web/agents/rows"
import { ChatView } from "@/components/chat/chat-view"
import { ThemeToggle } from "@/components/shell/sidebar"
import { Button } from "@/components/ui/button"
import type { ChatActions } from "@/lib/chat/actions"
import { ThreadStore } from "@/lib/chat/thread-store"
import { assistant, capabilities, everyKind, identity, longThread, MARKDOWN_ANSWER, snapshotOf, turnSteps, type Step } from "@/dev/fixtures"

type Scenario = "every" | "empty" | "long" | "paged"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function snapshotFor(s: Scenario): { snapshot: ThreadSnapshot; older: Row[] } {
  if (s === "empty") return { snapshot: snapshotOf([]), older: [] }
  if (s === "long") return { snapshot: longThread(500), older: [] }
  if (s === "paged") {
    const all = longThread(500).rows // 2,000 rows
    return { snapshot: snapshotOf(all.slice(-50), { hasMore: true }), older: all.slice(0, -50) }
  }
  return { snapshot: everyKind(), older: [] }
}

/** A long reply, for the smoothness measurement. */
const LONG_ANSWER = Array.from({ length: 40 }, (_, i) => `### Part ${i + 1}\n\nStep ${i + 1} reads the input and returns early when it is empty. It keeps \`state${i}\` and prints a **header**.\n\n\`\`\`ts\nexport function step${i}(input: string[]) {\n  return input.length === 0 ? [] : input.map(run)\n}\n\`\`\`\n`).join("\n")

export interface BenchResult {
  rows: number
  frames: number
  longestFrameMs: number
  p99FrameMs: number
  longTasks: number
  chars: number
}

export function DevChat() {
  const [scenario, setScenario] = useState<Scenario>("every")
  const [run, setRun] = useState(0)
  const [disabled, setDisabled] = useState(false)
  const [bench, setBench] = useState<BenchResult | null>(null)
  // Everything that belongs to one thread, made together: its store, the older rows it can page in, and the token that
  // ends the playback of a turn when the thread is replaced or stopped.
  const thread = useMemo(() => {
    const base = snapshotFor(scenario)
    return { snapshot: base.snapshot, store: new ThreadStore(base.snapshot), older: base.older.slice(), token: { cancelled: false } }
  }, [scenario, run])
  const { store } = thread
  const [view, setView] = useState<"chat" | "terminal">("chat")
  const previous = useRef<typeof thread | null>(null)
  useEffect(() => {
    if (previous.current && previous.current !== thread) previous.current.token.cancelled = true // not on a strict-mode re-run of the same thread
    previous.current = thread
    setBench(null)
    setView("chat")
  }, [thread])

  // Play the steps of one turn. Each step's `live` keeps the messages that arrived while it ran (they are not dropped).
  const playTurn = useCallback(
    async (steps: Step[]) => {
      const token = thread.token
      for (const step of steps) {
        await sleep(step.after)
        if (token.cancelled) return
        const change = step.change
        if (change.live) {
          const pending = store.getState().live.pending
          store.apply({ type: "update", seq: store.getState().seq + 1, ...change, live: { ...change.live, pending } })
        } else {
          store.apply({ type: "update", seq: store.getState().seq + 1, ...change })
        }
      }
    },
    [store, thread],
  )

  const play = useCallback(
    async (steps: Step[]) => {
      if (thread.token.cancelled) return
      await playTurn(steps)
      // Messages typed while the turn ran were held; now each becomes a turn of its own, in order.
      const pending = [...store.getState().live.pending]
      if (pending.length > 0) {
        const s = store.getState()
        store.apply({ type: "update", seq: s.seq + 1, live: { ...s.live, pending: [] } })
        for (const p of pending) {
          await playTurn(turnSteps(p.text, `Back to you. I finished the work above and kept "${p.text}".

1. The turn above is done.
2. Nothing was lost.`))
        }
      }
    },
    [store, thread, playTurn],
  )

  const actions: ChatActions = useMemo(
    () => ({
      send: async (text) => {
        await sleep(80)
        if (text.startsWith("/")) return
        if (store.getState().live.working) {
          const live = store.getState().live
          store.apply({ type: "update", seq: store.getState().seq + 1, live: { ...live, pending: [...live.pending, { id: `p-${Date.now()}`, text, mode: "steer" }] } })
          return
        }
        void play(turnSteps(text, MARKDOWN_ANSWER))
      },
      stop: async () => {
        thread.token.cancelled = true
        thread.token = { cancelled: false }
        const s = store.getState()
        store.apply({ type: "update", seq: s.seq + 1, rows: [{ kind: "notice", id: `stop-${s.seq}`, at: null, level: "info", text: "Stopped." }], live: { ...EMPTY_LIVE, usage: s.live.usage } })
      },
      setModel: async (id) => {
        await sleep(300)
        if (id.endsWith("/local")) throw new Error("pi could not switch to Local: the model is not loaded.")
        store.apply({ type: "update", seq: store.getState().seq + 1, capabilities: { ...capabilities, models: { ...capabilities.models!, current: id } } })
      },
      setEffort: async (level) => {
        await sleep(200)
        store.apply({ type: "update", seq: store.getState().seq + 1, capabilities: { ...store.getState().capabilities, efforts: { ...capabilities.efforts!, current: level } } })
      },
      loadOlder: async () => {
        await sleep(350)
        const page = thread.older.splice(Math.max(0, thread.older.length - 50), 50)
        return { rows: page, hasMore: thread.older.length > 0 }
      },
      fullToolResult: async () => {
        await sleep(200)
        return "line of output\n".repeat(400)
      },
      answer: async () => {
        await sleep(200)
        return { status: "not_found" }
      },
    }),
    [store, thread, play],
  )

  /** Stream a long reply into the thread as fast as a model might, and record how long frames take. */
  const measure = useCallback(async () => {
    const rows = store.getState().rows.length
    const gaps: number[] = []
    let longTasks = 0
    let observer: PerformanceObserver | null = null
    try {
      observer = new PerformanceObserver((list) => (longTasks += list.getEntries().length))
      observer.observe({ entryTypes: ["longtask"] })
    } catch {
      observer = null
    }
    let running = true
    let last = performance.now()
    const tick = (t: number) => {
      gaps.push(t - last)
      last = t
      if (running) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    const live = { ...EMPTY_LIVE, working: true }
    store.apply({ type: "update", seq: store.getState().seq + 1, live })
    for (let i = 0; i < LONG_ANSWER.length; i += 12) {
      store.apply({ type: "update", seq: store.getState().seq + 1, live: { ...live, reply: { blocks: [{ kind: "text", text: LONG_ANSWER.slice(0, i + 12) }] } } })
      await sleep(8)
    }
    store.apply({ type: "update", seq: store.getState().seq + 1, rows: [assistant(LONG_ANSWER)], live: { ...EMPTY_LIVE } })
    await sleep(300)
    running = false
    observer?.disconnect()
    const sorted = gaps.slice(1).sort((a, b) => a - b)
    const result: BenchResult = { rows, frames: sorted.length, longestFrameMs: Math.round(sorted[sorted.length - 1] ?? 0), p99FrameMs: Math.round(sorted[Math.floor(sorted.length * 0.99)] ?? 0), longTasks, chars: LONG_ANSWER.length }
    setBench(result)
    return result
  }, [store])
  useEffect(() => {
    ;(window as unknown as { __devChat: unknown }).__devChat = { measure, play: (p: string) => play(turnSteps(p, MARKDOWN_ANSWER)), store }
  }, [measure, play, store])

  const button = (label: string, onClick: () => void, testId: string, active = false) => (
    <Button key={testId} size="xs" variant={active ? "secondary" : "outline"} data-testid={testId} onClick={onClick}>
      {label}
    </Button>
  )
  return (
    <div className="flex h-svh min-w-0 flex-col" data-testid="dev-chat" data-scenario={scenario} data-rows={thread.snapshot.rows.length}>
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
        <span className="font-medium">/dev/chat</span>
        {(["every", "empty", "paged", "long"] as const).map((s) => button({ every: "Every row kind", empty: "Empty thread", paged: "50 rows, 1,950 older", long: "2,000 rows" }[s], () => { setScenario(s); setRun((r) => r + 1) }, `scenario-${s}`, scenario === s))}
        <span className="mx-1 text-muted-foreground">|</span>
        {button("Play a turn", () => void play(turnSteps("Why does the importer skip three rows?", MARKDOWN_ANSWER)), "play")}
        {button("Play a slow turn", () => void play(turnSteps("Why does the importer skip three rows?", MARKDOWN_ANSWER, 0.4)), "play-slow")}
        {button("Measure a streaming reply", () => void measure(), "measure")}
        <label className="flex items-center gap-1">
          <input type="checkbox" data-testid="disable" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} /> disconnected
        </label>
        {bench && (
          <span data-testid="bench-result" data-longest={bench.longestFrameMs} className="font-mono">
            {bench.rows} rows · {bench.frames} frames · longest {bench.longestFrameMs} ms · p99 {bench.p99FrameMs} ms · long tasks {bench.longTasks}
          </span>
        )}
        <span className="flex-1" />
        <ThemeToggle />
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {view === "terminal" ? (
          <div data-testid="terminal-stand-in" className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            The terminal view would be here.{" "}
            <Button variant="link" size="sm" onClick={() => setView("chat")}>
              Back to chat
            </Button>
          </div>
        ) : (
          <ChatView key={`${scenario}-${run}`} store={store} actions={actions} disabledReason={disabled ? "Disconnected from the backend. Nothing is queued." : null} draftKey={`dev-${identity.terminalId}`} onShowTerminal={() => setView("terminal")} />
        )}
      </div>
    </div>
  )
}
