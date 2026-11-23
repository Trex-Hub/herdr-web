"use client"

import { SquareTerminal } from "lucide-react"
import type { Live } from "@herdr-web/agents/rows"
import { Button } from "@/components/ui/button"
import { Trace, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace"
import { ASK_GRACE_MS, askOwnsWait } from "@/lib/chat/asks"
import type { ThreadStore } from "@/lib/chat/thread-store"
import { useGrace } from "@/lib/chat/use-grace"
import { useThread } from "@/lib/chat/use-thread"

/**
 * The dialog of pi's own the line is about, or null when there is none to show: none open, an `ask_user` call is behind it
 * (the chat already shows that wait), or it has not been so for a second yet (`state` can arrive before the prompt that
 * explains it, and a dialog that opens and closes at once is not worth a line).
 */
export function useShownWaiting(store: ThreadStore): Live["waiting"] {
  const waiting = useThread(store, (s) => s.live.waiting)
  const owned = useThread(store, (s) => s.live.waiting !== null && askOwnsWait(s))
  const graceOver = useGrace(waiting !== null && !owned, ASK_GRACE_MS)
  return waiting !== null && !owned && graceOver ? waiting : null
}

/** One muted line: pi is on a dialog only its terminal can answer. */
export function WaitingLine({ waiting, onShowTerminal }: { waiting: NonNullable<Live["waiting"]>; onShowTerminal: () => void }) {
  return (
    <Trace data-testid="waiting" data-kind={waiting.kind} role="status">
      <TraceLine className="w-full">
        <TraceIcon>
          <SquareTerminal />
        </TraceIcon>
        {/* The words never shrink (a short form below sm); only the title is cut, with the full text on hover. */}
        <TraceTitle data-testid="waiting-text" className="flex min-w-0 flex-1" title={waiting.title ?? undefined}>
          <span className="shrink-0">
            <span data-testid="waiting-prefix" className="max-sm:hidden">
              Waiting for you in the terminal
            </span>
            <span data-testid="waiting-prefix-short" className="sm:hidden">
              In the terminal
            </span>
          </span>
          {waiting.title && (
            <>
              <span className="shrink-0 whitespace-pre">: </span>
              <span data-testid="waiting-title" className="min-w-0 truncate">
                {waiting.title}
              </span>
            </>
          )}
        </TraceTitle>
        <Button variant="link" size="xs" data-testid="open-terminal" className="shrink-0 whitespace-nowrap" onClick={onShowTerminal}>
          Open terminal
        </Button>
      </TraceLine>
    </Trace>
  )
}
