"use client"

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { Link2, Loader2, Users } from "lucide-react"
import type { NoticeRow } from "@herdr-web/agents/rows"
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace"
import { clock, compactOutcomeText, initials, linkFailure, nameHue, parseLinkBatch, readLinkList, type LinkItem } from "@/lib/chat/link"
import { cn } from "@/lib/utils"
import { Markdown } from "./markdown"
import type { ToolRowViewProps, ToolView } from "./tools/types"

// A terminal's colour: one hue from its name, at a lightness that reads in each theme (oklch keeps every hue equally light).
const hueStyle = (name: string) => ({ "--agent-hue": String(nameHue(name)) }) as CSSProperties
const NAME = "text-[oklch(0.5_0.14_var(--agent-hue))] dark:text-[oklch(0.8_0.12_var(--agent-hue))]"
const DOT = "bg-[oklch(0.62_0.14_var(--agent-hue))]"
const AVATAR = "bg-[oklch(0.93_0.045_var(--agent-hue))] text-[oklch(0.42_0.12_var(--agent-hue))] dark:bg-[oklch(0.33_0.06_var(--agent-hue))] dark:text-[oklch(0.86_0.09_var(--agent-hue))]"

function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span aria-hidden data-testid="link-avatar" className={cn("flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tracking-wide", AVATAR, className)}>
      {initials(name)}
    </span>
  )
}

/** Markdown that folds past about 8 lines, with Show more. */
function Folded({ text }: { text: string }) {
  const box = useRef<HTMLDivElement>(null)
  const [long, setLong] = useState(false)
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => {
    const el = box.current
    if (el) setLong(el.scrollHeight > el.clientHeight + 1)
  }, [text])
  const folded = long && !open
  return (
    <>
      <div
        ref={box}
        data-testid="link-body"
        data-folded={folded}
        className={cn(!open && "max-h-48 overflow-hidden")}
        style={folded ? { maskImage: "linear-gradient(to bottom, black 65%, transparent)" } : undefined}
      >
        <Markdown text={text} />
      </div>
      {long && (
        <button type="button" data-testid="link-more" className="mt-1 text-[13px] font-medium text-muted-foreground hover:text-foreground" onClick={() => setOpen((o) => !o)}>
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </>
  )
}

/** Messages from one terminal in a row: its avatar, its name in its colour, and a bubble each. */
function FromRun({ from, at, bodies, note }: { from: string; at: string; bodies: string[]; note?: string }) {
  return (
    <div data-testid="link-from" data-from={from} style={hueStyle(from)} className="flex max-w-[88%] items-start gap-2.5 max-sm:max-w-full">
      <Avatar name={from} className="mt-6" />
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-baseline gap-2 px-1 text-[13px]">
          <span data-testid="link-name" className={cn("truncate font-semibold", NAME)}>
            {from}
          </span>
          <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
            <Link2 className="size-3 self-center" />
            pi-link
          </span>
          {at && <span className="shrink-0 text-xs text-muted-foreground">{at}</span>}
        </div>
        {bodies.map((body, i) => (
          <div key={i} data-testid="link-bubble" className={cn("min-w-0 rounded-2xl border bg-background px-3.5 py-2", i === 0 && "rounded-tl-md")}>
            {note && i === 0 && (
              <p data-testid="link-unsplit" className="mb-1 text-xs text-amber-700 dark:text-amber-400">
                {note}
              </p>
            )}
            <Folded text={body} />
          </div>
        ))}
      </div>
    </div>
  )
}

/** A small centred line in a terminal's colour: a compaction asked for, or its outcome. */
function EventLine({ name, children, testId }: { name: string; children: ReactNode; testId: string }) {
  return (
    <p data-testid={testId} style={hueStyle(name)} className="flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground">
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT)} />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

type Run = { kind: "from"; from: string; bodies: string[] } | { kind: "compact"; target: string; outcome: string }

function runsOf(items: LinkItem[]): Run[] {
  const runs: Run[] = []
  for (const item of items) {
    const last = runs.at(-1)
    if (item.kind === "compact") runs.push(item)
    else if (last?.kind === "from" && last.from === item.from) last.bodies.push(item.body)
    else runs.push({ kind: "from", from: item.from, bodies: [item.body] })
  }
  return runs
}

/** A batch of messages pi-link received: a bubble per message, from the left, grouped by sender. */
export function LinkMessage({ row }: { row: NoticeRow; plain: ReactNode }) {
  const batch = parseLinkBatch(row.text, row.details)
  const at = clock(row.at)
  return (
    <div data-testid="row-link" data-row-id={row.id} data-split={batch.split} className="flex flex-col gap-3">
      {batch.split ? (
        runsOf(batch.items).map((run, i) =>
          run.kind === "compact" ? (
            <EventLine key={i} name={run.target} testId="link-compact-outcome">
              {compactOutcomeText(run.target, run.outcome)}
            </EventLine>
          ) : (
            <FromRun key={i} from={run.from} at={at} bodies={run.bodies} />
          ),
        )
      ) : (
        <FromRun from={batch.from ?? "pi-link"} at={at} bodies={[batch.text]} note="Couldn't split this into separate messages, so it's shown as it arrived." />
      )}
    </div>
  )
}

/** A message this agent sent: a dashed bubble on the right, to the terminal in its colour, and whether it went. */
function LinkSendRow({ row, plain }: ToolRowViewProps) {
  const to = row.args["to"]
  const message = row.args["message"]
  if (typeof to !== "string" || typeof message !== "string") return <>{plain}</>
  const failure = linkFailure(row)
  const state = row.status === "running" ? "sending" : row.status === "interrupted" ? "stopped" : failure !== null ? "failed" : "sent"
  return (
    <div data-testid="row-link-send" data-row-id={row.id} data-name="link_send" data-status={row.status} data-state={state} style={hueStyle(to)} className="flex flex-col items-end gap-1">
      <div className="flex max-w-[80%] items-center gap-1.5 px-1 text-[13px] text-muted-foreground max-sm:max-w-full">
        <Link2 className="size-3 shrink-0" />
        <span className="shrink-0">To</span>
        <span data-testid="link-name" className={cn("truncate font-semibold", NAME)}>
          {to}
        </span>
      </div>
      <div data-testid="link-bubble" className={cn("min-w-0 max-w-[80%] rounded-2xl rounded-tr-md border border-dashed px-3.5 py-2 max-sm:max-w-full", state === "failed" && "border-solid border-destructive/60")}>
        <Folded text={message} />
        {row.argsTruncated && <p className="mt-1 text-xs text-muted-foreground">The rest of this message is cut here.</p>}
      </div>
      <span data-testid="link-send-status" className={cn("flex items-center gap-1.5 px-1 text-xs text-muted-foreground", state === "failed" && "text-destructive")}>
        {state === "sending" && <Loader2 className="size-3 animate-spin" />}
        {state === "sending" ? "Sending" : state === "stopped" ? "Stopped" : state === "failed" ? `Not delivered: ${failure}` : ["Sent", clock(row.at)].filter(Boolean).join(" · ")}
      </span>
    </div>
  )
}

/** `link_list`: one line with how many terminals there are, opening to each with its status. */
function LinkListRow({ row, plain }: ToolRowViewProps) {
  const list = readLinkList(row.details)
  if (row.status !== "ok" || linkFailure(row) !== null || list === null) return <>{plain}</>
  const n = list.terminals.length
  return (
    <Trace data-testid="row-link-list" data-row-id={row.id} data-name="link_list" data-status={row.status}>
      <TraceCollapsible>
        <TraceCollapsibleTrigger className="w-full">
          <TraceLine className="w-full">
            <TraceIcon>
              <Users />
            </TraceIcon>
            <TraceTitle className="min-w-0 flex-1 truncate font-medium text-foreground/80">
              Listed {n} {n === 1 ? "terminal" : "terminals"}
            </TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <ul className="flex flex-col gap-1.5 text-sm">
            {list.terminals.map((name) => (
              <li key={name} data-testid="link-terminal" style={hueStyle(name)} className="flex min-w-0 items-center gap-2">
                <Avatar name={name} className="size-5 text-[9px]" />
                <span className={cn("truncate font-medium", NAME)}>{name}</span>
                {name === list.self && <span className="shrink-0 text-xs text-muted-foreground">(this agent)</span>}
                {list.statuses.get(name) && <span className="truncate text-xs text-muted-foreground">{list.statuses.get(name)}</span>}
              </li>
            ))}
          </ul>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}

/** `link_compact`: a small centred line, as its outcome will be when it comes back. */
function LinkCompactRow({ row, plain }: ToolRowViewProps) {
  const to = row.args["to"]
  if (typeof to !== "string" || row.status !== "ok" || linkFailure(row) !== null) return <>{plain}</>
  return (
    <div data-testid="row-link-compact" data-row-id={row.id} data-name="link_compact" data-status={row.status}>
      <EventLine name={to} testId="link-compact-asked">
        Asked {to} to compact{row.at !== null && ` · ${clock(row.at)}`}
      </EventLine>
    </div>
  )
}

export const linkSendView: ToolView = { Row: LinkSendRow }
export const linkListView: ToolView = { Row: LinkListRow }
export const linkCompactView: ToolView = { Row: LinkCompactRow }
