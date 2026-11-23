"use client"

import { memo, useEffect, useMemo, useRef, useState } from "react"
import { Brain, Loader2 } from "lucide-react"
import type { Live, Row } from "@herdr-web/agents/rows"
import { Message, MessageContent } from "@/components/ui/message"
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace"
import type { ThreadStore } from "@/lib/chat/thread-store"
import { useThread } from "@/lib/chat/use-thread"
import { formatElapsedSeconds } from "@/lib/chat/format"
import { Markdown } from "./markdown"
import { NoticeLine, ToolLine } from "./rows"
import { toolView } from "./tools"
import { WaitingLine, useShownWaiting } from "./waiting-line"

/** Since when a live tool was first on this page, ticking once a second until its row replaces it. */
export function LiveElapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <span data-testid="live-tool-elapsed" className="shrink-0 font-mono text-xs text-muted-foreground/70 tabular-nums">
      {formatElapsedSeconds((now - since) / 1000)}
    </span>
  )
}

function LiveTool({ callId, name, argument, since }: { callId: string; name: string; argument?: string; since: number }) {
  const plain = (
    <Trace data-testid="live-tool">
      {/* The finished rows are collapsible and keep a trailing chevron slot; hold it open so the times line up. */}
      <ToolLine name={name} argument={argument ?? ""} running reserveChevron end={<LiveElapsed since={since} />} />
    </Trace>
  )
  const Own = toolView(name)?.Live
  return Own ? <Own callId={callId} name={name} argument={argument} since={since} plain={plain} /> : plain
}

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
            <TraceIcon>
              <Brain />
            </TraceIcon>
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
 * "working" mark (replaced by the line "Waiting for you in the terminal" while pi is on a dialog of its own), a notice the session file cannot hold. It is the only part of the thread that
 * renders as text arrives. A tool that already has a row is left to its row.
 */
export const LiveTail = memo(function LiveTail({ store, onShowTerminal }: { store: ThreadStore; onShowTerminal: () => void }) {
  const live: Live = useThread(store, (s) => s.live)
  const rows: readonly Row[] = useThread(store, (s) => s.rows)
  const known = useMemo(() => new Set(rows.flatMap((r) => (r.kind === "tool" ? [r.callId] : []))), [rows])
  const tools = live.tools.filter((t) => !known.has(t.callId))
  const waiting = useShownWaiting(store)
  const blocks = live.reply?.blocks ?? []
  const quiet = blocks.length === 0 && tools.length === 0
  // Count each live tool from the step this page first saw it.
  const seen = useRef<Record<string, number>>({})
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
      {tools.map((t) => {
        const since = (seen.current[t.callId] ??= Date.now())
        return <LiveTool key={t.callId} callId={t.callId} name={t.name} argument={t.argument} since={since} />
      })}
      {live.notice && <NoticeLine level={live.notice.level} text={live.notice.text} testId="live-notice" />}
      {waiting && <WaitingLine waiting={waiting} onShowTerminal={onShowTerminal} />}
      {live.working && !waiting && (
        <span data-testid="working" className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
          {quiet && <Loader2 className="size-3 animate-spin" />}
          <span className={quiet ? "shimmer" : undefined}>Working…</span>
        </span>
      )}
    </div>
  )
})
