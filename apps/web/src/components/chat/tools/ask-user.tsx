"use client"

import { useEffect, useState } from "react"
import { Check, MessageCircleQuestionMark } from "lucide-react"
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace"
import {
  ASK_GRACE_MS,
  answeredText,
  askLineState,
  askSubject,
  expiresText,
  readArgs,
  readDetails,
  resultWithoutPrefix,
  type AskLineState,
  type AskQuestionView,
} from "@/lib/chat/asks"
import { cn } from "@/lib/utils"
import { useThreadValue } from "./context"
import type { ToolLiveViewProps, ToolRowViewProps, ToolView } from "./types"

/** True once `active` has been so for `ms`, and false again as soon as it is not. */
function useGrace(active: boolean, ms: number): boolean {
  const [over, setOver] = useState(false)
  useEffect(() => {
    if (!active) {
      setOver(false)
      return
    }
    const timer = setTimeout(() => setOver(true), ms)
    return () => clearTimeout(timer)
  }, [active, ms])
  return over
}

/** The time now, as it changes every `ms` while `active`. */
function useNow(active: boolean, ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [active, ms])
  return now
}

/** The prompt of one call as the thread follows it: open now (and until when), seen open before, or never. */
function useAsk(callId: string) {
  const open = useThreadValue((s) => s.live.asks.some((a) => a.id === callId), false)
  const expiresAt = useThreadValue((s) => s.live.asks.find((a) => a.id === callId)?.expiresAt ?? null, null)
  const seen = useThreadValue((s) => s.seenAsks.has(callId), false)
  return { open, expiresAt, seen }
}

/** A read-only card: the questions with their options, what was answered where there is an answer, and a note. */
export function AskCard({ heading, questions, note }: { heading?: string | null; questions: readonly AskQuestionView[]; note?: string }) {
  return (
    <div data-testid="ask-card" className="flex flex-col gap-3 rounded-lg border bg-muted/30 px-3 py-2.5 text-sm">
      {heading && <p className="font-medium">{heading}</p>}
      {questions.map((q, i) => {
        const chosen = q.answer?.kind === "selection" ? q.answer.selections : []
        return (
          <div key={i} data-testid="ask-card-question" className="flex flex-col gap-1.5">
            <p className="font-medium">{q.question}</p>
            {q.context && <p className="whitespace-pre-wrap text-xs text-muted-foreground">{q.context}</p>}
            {q.options.length > 0 && (
              <ul className="flex flex-col gap-0.5">
                {q.options.map((o) => {
                  const picked = chosen.includes(o.title)
                  return (
                    <li key={o.title} data-picked={picked} className={cn("flex items-start gap-1.5", picked ? "text-foreground" : "text-muted-foreground")}>
                      <span className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center">{picked && <Check className="size-3.5" />}</span>
                      <span className="min-w-0">
                        <span className={picked ? "font-medium" : undefined}>{o.title}</span>
                        {o.description && <span className="text-muted-foreground"> {o.description}</span>}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
            {q.answer?.kind === "freeform" && <p data-testid="ask-card-answer">Answered: {q.answer.text}</p>}
            {q.answer?.kind === "selection" && q.answer.comment && <p data-testid="ask-card-comment" className="text-muted-foreground">Comment: {q.answer.comment}</p>}
            {q.answer?.kind === "skipped" && <p data-testid="ask-card-answer" className="text-muted-foreground">Skipped</p>}
          </div>
        )
      })}
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  )
}

/** One muted line: the question mark, and what the call is up to. */
function AskLine({ children, className, ...props }: React.ComponentProps<"span">) {
  return (
    <TraceLine className="w-full" {...props}>
      <TraceIcon>
        <MessageCircleQuestionMark />
      </TraceIcon>
      <TraceTitle className={cn("min-w-0 flex-1", className)}>{children}</TraceTitle>
    </TraceLine>
  )
}

/** A call that is still running: waiting for its answer, answered and waiting for its row, or a card for a prompt that was never opened here. */
function Running({ callId, state, card, subject }: { callId: string; state: AskLineState; card: React.ReactNode; subject: string }) {
  const { expiresAt } = useAsk(callId)
  const now = useNow(state === "open" && expiresAt !== null, 15_000)
  if (state === "no-item") return <>{card}</>
  if (state === "sent") return <AskLine data-testid="ask-line">Answered</AskLine>
  const expires = expiresText(expiresAt, now)
  return (
    <AskLine data-testid="ask-line" title={subject}>
      Awaiting input…{expires && <span data-testid="ask-expires"> · {expires}</span>}
    </AskLine>
  )
}

function AskRow({ row, plain }: ToolRowViewProps) {
  const { open, seen } = useAsk(row.callId)
  const graceOver = useGrace(row.status === "running" && !open && !seen, ASK_GRACE_MS)
  const state = askLineState(row, open, seen, graceOver)
  const subject = askSubject(row)
  const outcome = readDetails(row.details)
  const args = readArgs(row.args)
  const attrs = { "data-testid": "row-ask", "data-row-id": row.id, "data-name": "ask_user", "data-status": row.status, "data-ask-state": state } as const

  if (state === "error") return <>{plain}</>
  if (state === "answered" && outcome) {
    return (
      <Trace {...attrs}>
        <TraceCollapsible>
          <TraceCollapsibleTrigger className="w-full">
            <AskLine data-testid="ask-line" className="truncate text-foreground/80">
              Asked: {subject} · {answeredText(outcome)}
            </AskLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent>
            <AskCard heading={outcome.heading ?? args?.heading ?? null} questions={outcome.questions} />
          </TraceCollapsibleContent>
        </TraceCollapsible>
      </Trace>
    )
  }
  const card = <AskCard heading={args?.heading} questions={args?.questions ?? []} note="Answer in the terminal." />
  const line =
    state === "open" || state === "sent" || state === "no-item" ? (
      <Running callId={row.callId} state={state} card={card} subject={subject} />
    ) : (
      <AskLine data-testid="ask-line">
        Asked: {subject} · {state === "not-answered" ? "Not answered" : state === "stopped" ? "Stopped" : resultWithoutPrefix(row.result)}
      </AskLine>
    )
  return <Trace {...attrs}>{line}</Trace>
}

/** A call that has started and has no row yet. All it has is the one argument pi-live sends, the question. */
function AskLive({ callId, argument }: ToolLiveViewProps) {
  const { open, seen } = useAsk(callId)
  const graceOver = useGrace(!open && !seen, ASK_GRACE_MS)
  const state = askLineState({ status: "running", details: undefined }, open, seen, graceOver)
  const card = <AskCard questions={argument ? [{ question: argument, options: [], answer: null }] : []} note="Answer in the terminal." />
  return (
    <Trace data-testid="live-tool" data-name="ask_user" data-ask-state={state}>
      <Running callId={callId} state={state} card={card} subject={argument ?? ""} />
    </Trace>
  )
}

export const askUserView: ToolView = { Row: AskRow, Live: AskLive }
