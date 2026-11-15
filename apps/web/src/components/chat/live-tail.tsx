"use client"

import { memo, useEffect, useMemo, useRef } from "react"
import { Loader2 } from "lucide-react"
import type { Live, Row } from "@herdr-web/agents/rows"
import { Message, MessageContent } from "@/components/ui/message"
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceLine, TraceTitle } from "@/components/ui/trace"
import type { ThreadStore } from "@/lib/chat/thread-store"
import { useThread } from "@/lib/chat/use-thread"
import { Markdown } from "./markdown"
import { NoticeLine, ToolLine } from "./rows"

/** Thinking while it is written: open, a few lines tall, following the newest text. */
function LiveThinking({ text }: { text: string }) {
  const box = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    const el = box.current
    if (el) el.scrollTop = el.scrollHeight
  }, [text])
  return (
    <Trace data-testid="live-thinking">
      <TraceCollapsible defaultOpen>
        <TraceCollapsibleTrigger>
          <TraceLine status="running">
            <TraceTitle>Thinking…</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <p ref={box} className="max-h-32 overflow-hidden whitespace-pre-wrap text-sm">
            {text.trim()}
          </p>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}

/**
 * What is happening now and is not a row yet: the reply being written, tools that started, the
 * "working" mark, a notice the session file cannot hold. It is the only part of the thread that
 * renders as text arrives. A tool that already has a row is left to its row.
 */
export const LiveTail = memo(function LiveTail({ store }: { store: ThreadStore }) {
  const live: Live = useThread(store, (s) => s.live)
  const rows: readonly Row[] = useThread(store, (s) => s.rows)
  const known = useMemo(() => new Set(rows.flatMap((r) => (r.kind === "tool" ? [r.callId] : []))), [rows])
  const tools = live.tools.filter((t) => !known.has(t.callId))
  const blocks = live.reply?.blocks ?? []
  const quiet = blocks.length === 0 && tools.length === 0
  return (
    <div className="flex flex-col gap-3" data-testid="live-tail" data-working={live.working}>
      {blocks.map((b, i) =>
        b.kind === "thinking" ? (
          <LiveThinking key={i} text={b.text} />
        ) : (
          <Message key={i} data-testid="live-text">
            <MessageContent>
              <Markdown text={b.text} streaming />
            </MessageContent>
          </Message>
        ),
      )}
      {tools.map((t) => (
        <Trace key={t.callId} data-testid="live-tool">
          <ToolLine name={t.name} argument="" running />
        </Trace>
      ))}
      {live.notice && <NoticeLine level={live.notice.level} text={live.notice.text} testId="live-notice" />}
      {live.working && (
        <span data-testid="working" className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
          <Loader2 className="size-3 animate-spin" />
          <span className={quiet ? "shimmer" : undefined}>Working…</span>
        </span>
      )}
    </div>
  )
})
