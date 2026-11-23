"use client"

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { flushSync } from "react-dom"
import type { ModelOption, Row } from "@herdr-web/agents/rows"
import { cn } from "cn"
import { Button } from "@/components/ui/button"
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport, useMessageScroller } from "@/components/ui/message-scroller"
import { sentence, type ChatActions } from "@/lib/chat/actions"
import { groupRows, replyEnds, type GroupItem as GroupRun } from "@/lib/chat/format"
import type { ThreadStore } from "@/lib/chat/thread-store"
import { useThread } from "@/lib/chat/use-thread"
import { LiveTail } from "./live-tail"
import { ThreadStoreContext } from "./tools/context"
import { GroupView } from "./group"
import { RowView } from "./rows"

/** The spacing before a row: a leading user row gets a full turn's space, adjoining lines of work sit close. */
function gapClass(row: Row, prev: Row | undefined, first: boolean): string {
  if (!prev) return first ? "" : "mt-3"
  const work = row.kind === "tool" || row.kind === "thinking"
  const priorWork = prev.kind === "tool" || prev.kind === "thinking"
  if (row.kind === "user") return "mt-8"
  if (work && priorWork) return "mt-2"
  // A run of notices is one group, like adjoining tool lines.
  if (row.kind === "notice" && prev.kind === "notice") return "mt-2"
  return "mt-3"
}

/** One row's item. Memoised, so a page that gains rows does not render the ones it had again. */
const RowItem = memo(function RowItem({ row, gap, end, fullResult, models }: { row: Row; gap: string; end: boolean; fullResult: ChatActions["fullToolResult"]; models: ModelOption[] | null }) {
  return (
    <MessageScrollerItem messageId={row.id} data-row-kind={row.kind} className={gap}>
      <RowView row={row} end={end} fullResult={fullResult} models={models} />
    </MessageScrollerItem>
  )
})

/** A group's item. The page makes a new group object when it groups its rows again; the same steps are the same group. */
const GroupItem = memo(
  function GroupItem({ group, gap, open, setOpen, fullResult }: { group: GroupRun; gap: string; open: boolean; setOpen: (ids: string[], open: boolean) => void; fullResult: ChatActions["fullToolResult"] }) {
    return (
      <MessageScrollerItem messageId={group.id} data-row-kind="group" className={cn("[contain-intrinsic-size:auto_1.75rem]", gap)}>
        <GroupView group={group} open={open} setOpen={setOpen} fullResult={fullResult} />
      </MessageScrollerItem>
    )
  },
  (a, b) => a.gap === b.gap && a.open === b.open && a.setOpen === b.setOpen && a.fullResult === b.fullResult && a.group.id === b.group.id && a.group.rows.length === b.group.rows.length && a.group.rows.every((r, i) => r === b.group.rows[i]),
)

/** The rows, one item each. It re-renders when rows change, and an unchanged row's own component does not. */
const Rows = memo(function Rows({ rows, ends, fullResult, models, first, working, manual, setGroupOpen }: { rows: readonly Row[]; ends: Set<string>; fullResult: ChatActions["fullToolResult"]; models: ModelOption[] | null; first: boolean; working: boolean; manual: ReadonlyMap<string, boolean>; setGroupOpen: (ids: string[], open: boolean) => void }) {
  const items = useMemo(() => groupRows(rows), [rows])
  const list = useRef<HTMLDivElement>(null)
  // A row the reader can reach within a couple of viewports is rendered at its real size, so the viewport is never left
  // empty while the browser settles the placeholder height of freshly added rows (DEV-30 item 5). Rows well outside the
  // viewport keep `content-visibility:auto` and stay painted lazily, so scrolling a long thread stays smooth.
  const near = useRef<IntersectionObserver | null>(null)
  const watched = useRef(new Set<HTMLElement>())
  useEffect(() => {
    const root = list.current?.closest<HTMLElement>("[data-slot=message-scroller-viewport]") ?? null
    if (!root || typeof IntersectionObserver === "undefined") return
    const seen = watched.current
    near.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const el = entry.target as HTMLElement | undefined
          if (el) el.style.contentVisibility = entry.isIntersecting ? "visible" : ""
        }
      },
      { root, rootMargin: "400% 0px 400% 0px" },
    )
    return () => {
      near.current?.disconnect()
      near.current = null
      seen.clear()
    }
  }, [])
  // Only what changed is looked at: a reveal or a prepend adds a few dozen items to a page of hundreds, and going over
  // all of them each time would cost more the further up the reader has gone.
  useEffect(() => {
    const observer = near.current
    const root = list.current?.closest<HTMLElement>("[data-slot=message-scroller-viewport]") ?? null
    if (!observer || !root) return
    const current = Array.from((list.current?.children ?? []) as HTMLCollectionOf<HTMLElement>)
    const here = new Set(current)
    for (const el of watched.current) {
      if (!here.has(el)) {
        observer.unobserve(el)
        watched.current.delete(el)
      }
    }
    // New items within the band are real now, synchronously, so a prepend or a jump never waits a frame of the observer
    // to size them.
    const band = root.getBoundingClientRect()
    const ahead = band.height * 4
    for (const el of current) {
      if (watched.current.has(el)) continue
      watched.current.add(el)
      const box = el.getBoundingClientRect()
      if (box.bottom >= band.top - ahead && box.top <= band.bottom + ahead) el.style.contentVisibility = "visible"
      observer.observe(el)
    }
  }, [items])
  return (
    // display:contents, so observing the items does not add a box to the scroller's layout.
    <div ref={list} className="contents">
      {items.map((item, i) => {
        const prev = items[i - 1]
        const prevRow = prev ? (prev.type === "row" ? prev.row : prev.rows[prev.rows.length - 1]) : undefined
        if (item.type === "row") {
          const row = item.row
          return <RowItem key={row.id} row={row} gap={gapClass(row, prevRow, first)} end={ends.has(row.id)} fullResult={fullResult} models={models} />
        }
        // A group is open by the reader's last say on any of its steps; without one, the run the agent is working on is open.
        const said = item.rows.map((r) => manual.get(r.id)).filter((v) => v !== undefined)
        const open = said.length > 0 ? said.some(Boolean) : working && i === items.length - 1
        return <GroupItem key={item.id} group={item} gap={gapClass(item.rows[0]!, prevRow, first)} open={open} setOpen={setGroupOpen} fullResult={fullResult} />
      })}
    </div>
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
  const release = (e: Event) => {
    if (!(e as { fromUs?: boolean }).fromUs) done.abort()
  }
  // anything the reader does ends it: the wheel, a touch, a key, a press anywhere (the Jump to latest button)
  viewport.addEventListener("wheel", release, { once: true, passive: true, signal: done.signal })
  viewport.addEventListener("touchmove", release, { once: true, passive: true, signal: done.signal })
  viewport.addEventListener("keydown", release, { once: true, signal: done.signal })
  document.addEventListener("pointerdown", release, { once: true, signal: done.signal })
  let frames = 0
  const tick = () => {
    if (done.signal.aborted || !viewport.isConnected) return
    // a row that has become a step of a group is found by its group
    const row = viewport.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(place.id)}"], [data-row-ids~="${CSS.escape(place.id)}"]`)
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
    const generation = s.generation
    store.setLoadingOlder(true)
    actions.loadOlder(first.id).then(
      (page) => {
        // A thread that was replaced while the page was on its way (a `reset`) is another thread: its rows are not these.
        if (store.getState().generation !== generation) return
        const place = viewport ? placeOf(viewport) : null
        store.prepend(page.rows, page.hasMore)
        if (viewport) holdPlace(viewport, place)
      },
      (e) => {
        if (store.getState().generation === generation) store.setLoadingOlder(false, sentence(e))
      },
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
  return (
    <ThreadStoreContext.Provider value={store}>
      <Thread key={generation} store={store} actions={actions} />
    </ThreadStoreContext.Provider>
  )
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

/**
 * Text that arrives inside the live row grows the page without a child being added, and the scroller follows such growth
 * from a resize observer and an animation frame: the grown page is painted once before it is followed, so the newest
 * line shows a frame late. While the reader is at the end, this follows the growth in the same commit, before paint.
 */
function FollowGrowth({ store, viewport }: { store: ThreadStore; viewport: React.RefObject<HTMLDivElement | null> }) {
  const live = useThread(store, (s) => s.live)
  const rows = useThread(store, (s) => s.rows)
  const atEnd = useRef(true)
  useEffect(() => {
    const el = viewport.current
    if (!el) return
    const measure = () => {
      atEnd.current = el.scrollHeight - el.clientHeight - el.scrollTop < 4
    }
    // The scroller leaves the end when the reader wheels, touches or presses a key, and otherwise only when it has not
    // scrolled the page itself in the last moments, which a page that is changing keeps from being true (a scrollbar
    // drag, a script, a find). Any scroll that moves away from the end is the reader leaving it: the scroller is told
    // with a wheel event of our own, which the place-keeping above knows not to take for the reader's.
    let lastTop = el.scrollTop
    const onScroll = () => {
      const top = el.scrollTop
      if (top < lastTop - 0.5 && el.scrollHeight - el.clientHeight - top >= 4) {
        atEnd.current = false
        const event = new WheelEvent("wheel", { bubbles: true })
        Object.defineProperty(event, "fromUs", { value: true })
        el.dispatchEvent(event)
      }
      lastTop = top
      measure()
    }
    // The reader's own moves release it before the scroll event arrives; a scroll that ends at the bottom takes it back,
    // and so does a key or wheel that moved nothing (measured on the next frame).
    const release = () => {
      atEnd.current = false
      requestAnimationFrame(measure)
    }
    measure()
    el.addEventListener("scroll", onScroll, { passive: true })
    el.addEventListener("wheel", release, { passive: true })
    el.addEventListener("touchmove", release, { passive: true })
    el.addEventListener("keydown", release)
    return () => {
      el.removeEventListener("scroll", onScroll)
      el.removeEventListener("wheel", release)
      el.removeEventListener("touchmove", release)
      el.removeEventListener("keydown", release)
    }
  }, [viewport])
  useLayoutEffect(() => {
    const el = viewport.current
    if (el && atEnd.current) el.scrollTop = el.scrollHeight
  }, [live, rows, viewport])
  return null
}

function Thread({ store, actions }: { store: ThreadStore; actions: ChatActions }) {
  const rows = useThread(store, (s) => s.rows)
  const capabilities = useThread(store, (s) => s.capabilities)
  const continuing = useThread(store, (s) => (s.live.reply?.blocks.length ?? 0) > 0 || s.live.tools.length > 0)
  const ends = useMemo(() => replyEnds(rows, continuing), [rows, continuing])
  const page = useWindow(rows)
  // The run the agent is working on is open until its answer starts: once live text is on the page, the run is behind it.
  const working = useThread(store, (s) => s.live.working && !(s.live.reply?.blocks ?? []).some((b) => b.kind === "text"))
  // What the reader said about each group, by row id: a click writes to every step the group has now, so a group that
  // gains steps (an older page, a reveal) keeps its state, and it is open when any of its steps says open.
  const [manual, setManual] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const setGroupOpen = useCallback((ids: string[], open: boolean) => setManual((m) => new Map([...m, ...ids.map((id) => [id, open] as const)])), [])
  const models = capabilities.models?.list ?? null
  const viewport = useRef<HTMLDivElement>(null)
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller data-testid="thread">
        <MessageScrollerViewport ref={viewport} preserveScrollOnPrepend data-testid="thread-viewport">
          {/* Outside the content: the scroller keeps the reader's place by the first child of the content, so that must be a row. */}
          <BackAtTheEnd viewport={viewport} grown={page.tooBig} trim={page.trim} />
          <FollowGrowth store={store} viewport={viewport} />
          <Older store={store} actions={actions} hidden={page.hidden} reveal={page.reveal} />
          <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-0 px-4 py-4">
            <Rows rows={page.shown} ends={ends} fullResult={actions.fullToolResult} models={models} first={page.hidden === 0} working={working} manual={manual} setGroupOpen={setGroupOpen} />
            <MessageScrollerItem messageId="live" className="mt-3 [content-visibility:visible]">
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
