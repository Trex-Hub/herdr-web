"use client"

import { memo, useState } from "react"
import { Brain, Check, ChevronRightIcon, Copy, FileText, Loader2, Pencil, Search, SquareTerminal, Wrench } from "lucide-react"
import type { AssistantRow, Capabilities, CompactionRow, NoticeRow, Row, ThinkingRow, ToolRow, UserRow } from "@herdr-web/agents/rows"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block"
import { Message, MessageContent, MessageFooter } from "@/components/ui/message"
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace"
import { sentence } from "@/lib/chat/actions"
import { capitalise, formatDuration, formatTokens, mainArgument, modelName, noticeText } from "@/lib/chat/format"
import { cn } from "@/lib/utils"
import { Markdown } from "./markdown"

export function UserRowView({ row }: { row: UserRow }) {
  return (
    <Message align="end" data-testid="row-user" data-row-id={row.id}>
      <MessageContent>
        <Bubble variant="secondary" align="end">
          <BubbleContent className="whitespace-pre-wrap text-[15px] leading-[1.6]">{row.text}</BubbleContent>
        </Bubble>
        {row.images > 0 && (
          <span className="self-end px-1 text-xs text-muted-foreground">
            {row.images} {row.images === 1 ? "image" : "images"} attached
          </span>
        )}
      </MessageContent>
    </Message>
  )
}

export function CopyButton({ text, label = "Copy reply" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={copied ? "Copied" : label}
      data-testid="copy"
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
          })
          .catch(() => {})
      }}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  )
}

export function AssistantRowView({ row, end, models }: { row: AssistantRow; end: boolean; models?: NonNullable<Capabilities["models"]>["list"] | null }) {
  // One name per model: the display name when the agent knows it, the id otherwise; `title` carries the raw id.
  const shown = [row.model ? modelName(models, row.model) : null, row.effort ? capitalise(row.effort) : null].filter(Boolean).join(" · ")
  return (
    <Message data-testid="row-assistant" data-row-id={row.id}>
      <MessageContent className="gap-1">
        <Markdown text={row.text} />
        {end && (
          <MessageFooter className="justify-between px-0" data-testid="reply-end">
            <CopyButton text={row.text} />
            {shown && (
              <span data-testid="reply-by" title={row.model ?? undefined} className="truncate pl-3 font-normal">
                {shown}
              </span>
            )}
          </MessageFooter>
        )}
      </MessageContent>
    </Message>
  )
}

export function ThinkingRowView({ row }: { row: ThinkingRow }) {
  return (
    <Trace data-testid="row-thinking" data-row-id={row.id}>
      <TraceCollapsible>
        <TraceCollapsibleTrigger className="w-full">
          <TraceLine className="w-full">
            <TraceIcon>
              <Brain />
            </TraceIcon>
            <TraceTitle>Thought</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <p className="whitespace-pre-wrap text-sm">{row.text.trim()}</p>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}

const ICONS: Record<string, typeof Wrench> = {
  bash: SquareTerminal,
  read: FileText,
  write: Pencil,
  edit: Pencil,
  grep: Search,
  find: Search,
  ls: Search,
}

/** What a tool's status shows at the right of its line. */
function ToolEnd({ row }: { row: ToolRow }) {
  return (
    <>
      {row.status === "error" && (
        <span data-testid="tool-error" className="shrink-0 text-xs font-medium text-destructive">
          failed
        </span>
      )}
      {row.status === "interrupted" && (
        <span data-testid="tool-interrupted" className="shrink-0 text-xs text-muted-foreground">
          stopped
        </span>
      )}
      {row.durationMs !== null && row.status !== "running" && <TraceDescription data-testid="tool-duration">{formatDuration(row.durationMs)}</TraceDescription>}
    </>
  )
}

export function ToolLine({ name, argument, status, byUser, end, running }: { name: string; argument: string; status?: "error" | "pending"; byUser?: boolean; end?: React.ReactNode; running: boolean }) {
  const Icon = ICONS[name] ?? Wrench
  return (
    <TraceLine status={running ? "running" : status} className="w-full">
      <TraceIcon>{running ? <Loader2 className="animate-spin" data-testid="tool-spinner" /> : <Icon />}</TraceIcon>
      <TraceTitle className="shrink-0 font-medium text-foreground/80">{name}</TraceTitle>
      {byUser && <span className="shrink-0 text-xs">(you)</span>}
      {argument ? <TraceTitle className="min-w-0 flex-1 truncate font-mono text-xs">{argument}</TraceTitle> : <span className="min-w-0 flex-1" />}
      {end && <span data-slot="tool-end" className="ms-auto flex shrink-0 items-center gap-2">{end}</span>}
    </TraceLine>
  )
}

export function ToolRowView({ row, fullResult }: { row: ToolRow; fullResult: (rowId: string) => Promise<string> }) {
  const [full, setFull] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const result = full ?? row.result?.text ?? null
  const cut = full === null && row.result?.truncated === true
  const showAll = async () => {
    setLoading(true)
    setError(null)
    try {
      setFull(await fullResult(row.id))
    } catch (e) {
      setError(sentence(e))
    } finally {
      setLoading(false)
    }
  }
  const command = typeof row.args["command"] === "string" ? (row.args["command"] as string) : null
  const rest = command === null ? row.args : Object.fromEntries(Object.entries(row.args).filter(([k]) => k !== "command"))
  // The first code box is the command already on the line: show it only when the line cuts it.
  const argument = mainArgument(row)
  const showCommand = command !== null && (command !== argument || command.length > 100)
  return (
    <Trace data-testid="row-tool" data-row-id={row.id} data-status={row.status} data-name={row.name}>
      <TraceCollapsible>
        <TraceCollapsibleTrigger className="w-full">
          <ToolLine name={row.name} argument={argument} byUser={row.byUser} running={row.status === "running"} status={row.status === "error" ? "error" : undefined} end={<ToolEnd row={row} />} />
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <div className="flex flex-col gap-2 text-sm">
            {showCommand && command !== null && (
              <CodeBlock size="sm">
                <CodeBlockContent wrap>{command}</CodeBlockContent>
              </CodeBlock>
            )}
            {Object.keys(rest).length > 0 && (
              <CodeBlock size="sm">
                <CodeBlockContent wrap>{JSON.stringify(rest, null, 2)}</CodeBlockContent>
              </CodeBlock>
            )}
            {row.argsTruncated && <p className="text-xs">Long arguments are cut here.</p>}
            {result !== null ? (
              <CodeBlock size="sm" variant={row.status === "error" ? "destructive" : "default"} data-testid="tool-result">
                <CodeBlockContent wrap className="max-h-80">
                  {result}
                </CodeBlockContent>
              </CodeBlock>
            ) : (
              <p className="text-xs">{row.status === "running" ? "Running…" : "No result."}</p>
            )}
            {cut && (
              <div className="flex items-center gap-2 text-xs">
                <span>
                  Showing {row.result!.text.length.toLocaleString("en")} of {row.result!.totalChars.toLocaleString("en")} characters.
                </span>
                <Button variant="outline" size="xs" data-testid="show-all" disabled={loading} onClick={() => void showAll()}>
                  {loading ? "Loading…" : "Show all"}
                </Button>
              </div>
            )}
            {error && (
              <p role="alert" data-testid="show-all-error" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}

/** A thin centred line with text; a compaction opens to its summary. */
export function CompactionView({ row }: { row: CompactionRow }) {
  const label = row.tokensBefore !== null ? `Compacted · ${formatTokens(row.tokensBefore)} tokens before` : "Compacted"
  return (
    <TraceCollapsible data-testid="row-compaction" data-row-id={row.id}>
      <CollapsibleTriggerShell label={label} />
      <TraceCollapsibleContent>
        <div className="max-h-80 overflow-y-auto">
          <Markdown text={row.summary} className="text-muted-foreground" />
        </div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

/** A compaction's chevron sits next to its label inside the divider, not at the far right edge. */
function CollapsibleTriggerShell({ label }: { label: string }) {
  return (
    <TraceCollapsibleTrigger className="w-full max-w-full justify-center [&>[data-slot=trace-icon]]:hidden">
      <Divider>
        {label}
        <ChevronRightIcon className="size-3.5 transition-transform group-aria-expanded/trace-collapsible-trigger:rotate-90" />
      </Divider>
    </TraceCollapsibleTrigger>
  )
}

export function Divider({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex w-full items-center gap-3 text-xs text-muted-foreground" role="separator">
      <span className="h-px flex-1 bg-border" />
      <span className="shrink-0">{children}</span>
      <span className="h-px flex-1 bg-border" />
    </span>
  )
}

export function NoticeLine({ level, text, testId = "row-notice" }: { level: NoticeRow["level"]; text: string; testId?: string }) {
  // Left in the reply column, a 6 px dot carries the level; the text is muted (error may stay destructive).
  const dot = level === "error" ? "bg-destructive" : level === "warning" ? "bg-amber-500" : "bg-muted-foreground"
  return (
    <p data-testid={testId} data-level={level} className={cn("flex items-start gap-1.5 text-[13px] leading-relaxed", level === "error" ? "text-destructive" : "text-muted-foreground")}>
      <span aria-hidden className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", dot)} />
      <span className="min-w-0">{noticeText(text)}</span>
    </p>
  )
}

/** One row of the thread. Memoised: a finished row renders again only if its own data changed. */
export const RowView = memo(function RowView({
  row,
  end,
  fullResult,
  models = null,
}: {
  row: Row
  /** An assistant row that closes a reply shows its footer. */
  end: boolean
  fullResult: (rowId: string) => Promise<string>
  models?: NonNullable<Capabilities["models"]>["list"] | null
}) {
  switch (row.kind) {
    case "user":
      return <UserRowView row={row} />
    case "assistant":
      return <AssistantRowView row={row} end={end} models={models} />
    case "thinking":
      return <ThinkingRowView row={row} />
    case "tool":
      return <ToolRowView row={row} fullResult={fullResult} />
    case "compaction":
      return <CompactionView row={row} />
    case "model":
      return (
        <div data-testid="row-model" data-row-id={row.id} title={row.model}>
          <Divider>Switched to {modelName(models, row.model)}</Divider>
        </div>
      )
    case "notice":
      return <NoticeLine level={row.level} text={row.text} />
  }
})
