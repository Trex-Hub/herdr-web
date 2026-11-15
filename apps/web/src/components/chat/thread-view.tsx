"use client"

import { memo, useEffect, useMemo, useRef, useState } from "react"
import { flushSync } from "react-dom"
import type { Row } from "@herdr-web/agents/rows"
import { Button } from "@/components/ui/button"
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport, useMessageScroller } from "@/components/ui/message-scroller"
import { sentence, type ChatActions } from "@/lib/chat/actions"
import { replyEnds } from "@/lib/chat/format"
import type { ThreadStore } from "@/lib/chat/thread-store"
import { useThread } from "@/lib/chat/use-thread"
import { LiveTail } from "./live-tail"
import { RowView } from "./rows"

/** The rows, one item each. It re-renders when rows change, and an unchanged row's own component does not. */
const Rows = memo(function Rows({ rows, ends, fullResult }: { rows: readonly Row[]; ends: Set<string>; fullResult: ChatActions["fullToolResult"] }) {
  return (
    <>
      {rows.map((row) => (
        <MessageScrollerItem key={row.id} messageId={row.id} data-row-kind={row.kind}>
          <RowView row={row} end={ends.has(row.id)} fullResult={fullResult} />
        </MessageScrollerItem>
      ))}
    </>
  )
})

/** The first row showing in the viewport and how far below its top edge it starts. */
function placeOf(viewport: HTMLElement): { id: string; offset: number } | null {
  const top = viewport.getBoundingClientRect().top
  for (const row of viewport.querySelectorAll<HTMLElement>("[data-row-id]")) {
    const box = row.getBoundingClientRect()
    if (box.bottom > top + 1) return { id: row.dataset.rowId!, offset: box.top - top }
  }
  return null
}

/**
 * Keep the reader where they were while older rows are put above them. The scroller restores the place at once, but
 * rows it has not drawn yet have an estimated height and take their real one as they come near, which moves what the
 * reader is looking at; so the same row is put back at the same place for the next few frames, until the reader scrolls.
 */
function holdPlace(viewport: HTMLElement, place: { id: string; offset: number } | null): void {
  if (!place) return
  const done = new AbortController()
  const release = () => done.abort()
  // anything the reader does ends it: the wheel, a touch, a key, a press anywhere (the Jump to latest button)
  viewport.addEventListener("wheel", release, { once: true, passive: true, signal: done.signal })
  viewport.addEventListener("touchmove", release, { once: true, passive: true, signal: done.signal })
  viewport.addEventListener("keydown", release, { once: true, signal: done.signal })
  document.addEventListener("pointerdown", release, { once: true, signal: done.signal })
  let frames = 0
  const tick = () => {
    if (done.signal.aborted || !viewport.isConnected) return
    const row = [...viewport.querySelectorAll<HTMLElement>("[data-row-id]")].find((r) => r.dataset.rowId === place.id)
    if (row) {
      const delta = row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - place.offset
      if (Math.abs(delta) > 0.5) viewport.scrollTop += delta
    }
    if (++frames < 30) requestAnimationFrame(tick)
    else done.abort()
  }
  requestAnimationFrame(tick)
}

/**
 * The top of the thread: when it comes into view, rows kept in memory but not on the page are put on it, and when there
 * are none, older rows are fetched.
 */
function Older({ store, actions, hidden, reveal }: { store: ThreadStore; actions: ChatActions; hidden: number; reveal: () => void }) {
  const hasMore = useThread(store, (s) => s.hasMore)
  const loading = useThread(store, (s) => s.loadingOlder)
  const error = useThread(store, (s) => s.olderError)
  const top = useRef<HTMLDivElement>(null)
  const load = useRef(() => {})
  load.current = () => {
    const viewport = top.current?.closest<HTMLElement>("[data-slot=message-scroller-viewport]") ?? null
    if (hidden > 0) {
      const place = viewport ? placeOf(viewport) : null
      reveal()
      if (viewport) holdPlace(viewport, place)
      return
    }
    const s = store.getState()
    const first = s.rows[0]
    if (!first || !s.hasMore || s.loadingOlder) return
    store.setLoadingOlder(true)
    actions.loadOlder(first.id).then(
      (page) => {
        const place = viewport ? placeOf(viewport) : null
        store.prepend(page.rows, page.hasMore)
        if (viewport) holdPlace(viewport, place)
      },
      (e) => store.setLoadingOlder(false, sentence(e)),
    )
  }
  useEffect(() => {
    const el = top.current
    if (!el || typeof IntersectionObserver === "undefined") return
    const watch = new IntersectionObserver(
      (entries) => {
        // after a failure the reader asks again with the button, so a failing backend is not hammered
        if (entries.some((e) => e.isIntersecting) && !store.getState().olderError) load.current()
      },
      { rootMargin: "300px 0px 0px 0px" },
    )
    watch.observe(el)
    return () => watch.disconnect()
  }, [store, hasMore, hidden, loading])
  if (!hasMore && hidden === 0) return null
  return (
    <div ref={top} data-testid="older" className="flex min-h-6 flex-col items-center gap-1 text-xs text-muted-foreground">
      {loading && <span>Loading earlier messages…</span>}
      {error && (
        <>
          <span role="alert" data-testid="older-error" className="text-destructive">
            {error}
          </span>
          <Button variant="outline" size="xs" onClick={() => load.current()}>
            Try again
          </Button>
        </>
      )}
    </div>
  )
}

/** Rows on the page at first, and how many more each time the reader reaches the top. */
export const WINDOW = 120
const STEP = 30

/**
 * Only the newest rows are on the page. The scroller reads the size of every row on the page at each scroll and each
 * change (a reply that is being written scrolls the page on every update), and a page the reader has scrolled through
 * costs about 12 ms per read at 2,000 rows, three times a frame. So the page holds a window of the thread: it grows
 * upward as the reader goes up, and goes back to the newest rows once the reader is at the end again.
 */
function useWindow(rows: readonly Row[]) {
  // the id of the first row on the page; null is the first row of all
  const [from, setFrom] = useState<string | null>(() => (rows.length > WINDOW ? rows[rows.length - WINDOW]!.id : null))
  const index = useMemo(() => {
    if (from === null) return 0
    const i = rows.findIndex((r) => r.id === from)
    return i < 0 ? 0 : i
  }, [rows, from])
  const shown = useMemo(() => (index === 0 ? rows : rows.slice(index)), [rows, index])
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const at = (i: number) => (i <= 0 ? null : rowsRef.current[i]!.id)
  return {
    shown,
    hidden: index,
    reveal: () => setFrom(at(index - STEP)),
    trim: () => setFrom(at(rowsRef.current.length - WINDOW)),
    tooBig: rows.length - index > 2 * WINDOW,
  }
}

/** The thread: rows, the live tail, scrolling that follows the end until the reader scrolls up. */
export function ThreadView({ store, actions }: { store: ThreadStore; actions: ChatActions }) {
  // A new session (/new, /resume, /fork) is a new thread: the scroller and the window start again at the end.
  const generation = useThread(store, (s) => s.generation)
  return <Thread key={generation} store={store} actions={actions} />
}

/**
 * When the reader is back at the end of a page that has grown, the page goes back to the newest rows. Taking the rows
 * above away drops the scroll position, which the scroller takes for the reader scrolling up, so it is told to follow
 * the end again.
 */
function BackAtTheEnd({ viewport, grown, trim }: { viewport: React.RefObject<HTMLDivElement | null>; grown: boolean; trim: () => void }) {
  const { scrollToEnd } = useMessageScroller()
  const latest = useRef({ grown, trim, scrollToEnd })
  latest.current = { grown, trim, scrollToEnd }
  useEffect(() => {
    const el = viewport.current
    if (!el) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = () => {
      if (!latest.current.grown || el.scrollHeight - el.clientHeight - el.scrollTop >= 100) return
      flushSync(() => latest.current.trim())
      latest.current.scrollToEnd({ behavior: "auto" })
    }
    const onScroll = () => {
      clearTimeout(timer)
      timer = setTimeout(check, 400)
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      el.removeEventListener("scroll", onScroll)
      clearTimeout(timer)
    }
  }, [viewport])
  return null
}

function Thread({ store, actions }: { store: ThreadStore; actions: ChatActions }) {
  const rows = useThread(store, (s) => s.rows)
  const continuing = useThread(store, (s) => (s.live.reply?.blocks.length ?? 0) > 0 || s.live.tools.length > 0)
  const ends = useMemo(() => replyEnds(rows, continuing), [rows, continuing])
  const page = useWindow(rows)
  const viewport = useRef<HTMLDivElement>(null)
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller data-testid="thread">
        <MessageScrollerViewport ref={viewport} preserveScrollOnPrepend data-testid="thread-viewport">
          {/* Outside the content: the scroller keeps the reader's place by the first child of the content, so that must be a row. */}
          <BackAtTheEnd viewport={viewport} grown={page.tooBig} trim={page.trim} />
          <Older store={store} actions={actions} hidden={page.hidden} reveal={page.reveal} />
          <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-3 px-4 py-4">
            <Rows rows={page.shown} ends={ends} fullResult={actions.fullToolResult} />
            <MessageScrollerItem messageId="live" className="[content-visibility:visible]">
              <LiveTail store={store} />
            </MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton data-testid="jump-to-latest" size="sm" className="gap-1 px-3">
          <span aria-hidden>↓</span> Jump to latest
        </MessageScrollerButton>
      </MessageScroller>
    </MessageScrollerProvider>
  )
}
