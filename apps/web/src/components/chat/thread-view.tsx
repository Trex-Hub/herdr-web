"use client"

import { memo, useEffect, useMemo, useRef } from "react"
import type { Row } from "@herdr-web/agents/rows"
import { Button } from "@/components/ui/button"
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from "@/components/ui/message-scroller"
import { sentence, type ChatActions } from "@/lib/chat/actions"
import { replyEnds } from "@/lib/chat/format"
import type { ThreadStore } from "@/lib/chat/thread-store"
import { useThread } from "@/lib/chat/use-thread"
import { LiveTail } from "./live-tail"
import { RowView } from "./rows"

/** The rows, one item each. It re-renders when rows change, and an unchanged row's own component does not. */
const Rows = memo(function Rows({ rows, ends, effort, fullResult }: { rows: readonly Row[]; ends: Set<string>; effort: string | null; fullResult: ChatActions["fullToolResult"] }) {
  const lastEnd = useMemo(() => {
    for (let i = rows.length - 1; i >= 0; i--) if (ends.has(rows[i]!.id)) return rows[i]!.id
    return null
  }, [rows, ends])
  return (
    <>
      {rows.map((row) => (
        <MessageScrollerItem key={row.id} messageId={row.id} data-row-kind={row.kind}>
          <RowView row={row} end={ends.has(row.id)} effort={row.id === lastEnd ? effort : null} fullResult={fullResult} />
        </MessageScrollerItem>
      ))}
    </>
  )
})

/** The top of the thread: older rows load when it comes into view. */
function Older({ store, actions }: { store: ThreadStore; actions: ChatActions }) {
  const hasMore = useThread(store, (s) => s.hasMore)
  const loading = useThread(store, (s) => s.loadingOlder)
  const error = useThread(store, (s) => s.olderError)
  const top = useRef<HTMLDivElement>(null)
  const load = useRef(() => {})
  load.current = () => {
    const s = store.getState()
    const first = s.rows[0]
    if (!first || !s.hasMore || s.loadingOlder) return
    store.setLoadingOlder(true)
    actions.loadOlder(first.id).then(
      (page) => store.prepend(page.rows, page.hasMore),
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
  }, [store, hasMore, loading])
  if (!hasMore) return null
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

/** The thread: rows, the live tail, scrolling that follows the end until the reader scrolls up. */
export function ThreadView({ store, actions }: { store: ThreadStore; actions: ChatActions }) {
  const generation = useThread(store, (s) => s.generation)
  const rows = useThread(store, (s) => s.rows)
  const continuing = useThread(store, (s) => (s.live.reply?.blocks.length ?? 0) > 0 || s.live.tools.length > 0)
  const effort = useThread(store, (s) => s.capabilities.efforts?.current ?? null)
  const ends = useMemo(() => replyEnds(rows, continuing), [rows, continuing])
  // A new session (/new, /resume, /fork) is a new thread: the scroller starts again at its end.
  return (
    <MessageScrollerProvider key={generation} autoScroll defaultScrollPosition="end">
      <MessageScroller data-testid="thread">
        <MessageScrollerViewport preserveScrollOnPrepend data-testid="thread-viewport">
          <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-3 px-4 py-4">
            <Older store={store} actions={actions} />
            <Rows rows={rows} ends={ends} effort={effort} fullResult={actions.fullToolResult} />
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
