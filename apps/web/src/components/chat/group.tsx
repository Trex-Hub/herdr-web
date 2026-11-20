"use client"

import { memo } from "react"
import { Layers } from "lucide-react"
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace"
import { formatDuration, groupMeta, groupSummary, type GroupItem } from "@/lib/chat/format"
import { RowView } from "./rows"

/** A run of steps as one line, collapsed unless `open`; opened, the steps sit under a hairline, each as it is on its own. */
export const GroupView = memo(
  function GroupView({ group, open, setOpen, fullResult }: { group: GroupItem; open: boolean; setOpen: (ids: string[], open: boolean) => void; fullResult: (rowId: string) => Promise<string> }) {
  const { failed, stopped, durationMs } = groupMeta(group.rows)
  return (
    <Trace data-testid="row-group" data-row-id={group.id} data-row-ids={group.rows.map((r) => r.id).join(" ")}>
      <TraceCollapsible open={open} onOpenChange={(o) => setOpen(group.rows.map((r) => r.id), o)}>
        <TraceCollapsibleTrigger className="w-full" data-testid="group-trigger">
          <TraceLine status={failed > 0 ? "error" : undefined} className="w-full">
            <TraceIcon>
              <Layers />
            </TraceIcon>
            <TraceTitle className="min-w-0 flex-1 truncate" data-testid="group-label">
              {groupSummary(group.rows)}
            </TraceTitle>
            <span data-slot="tool-end" className="ms-auto flex shrink-0 items-center gap-2">
              {failed > 0 && (
                <span data-testid="group-failed" className="shrink-0 text-xs font-medium text-destructive">
                  {failed} failed
                </span>
              )}
              {stopped > 0 && (
                <span data-testid="group-stopped" className="shrink-0 text-xs text-muted-foreground">
                  stopped
                </span>
              )}
              {durationMs !== null && (
                <TraceDescription data-testid="group-duration" className="font-mono text-xs">
                  {formatDuration(durationMs)}
                </TraceDescription>
              )}
            </span>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <div data-testid="group-steps" className="mt-2 ms-2 flex flex-col gap-2 border-s ps-4">
            {group.rows.map((row) => (
              <RowView key={row.id} row={row} end={false} fullResult={fullResult} />
            ))}
          </div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
},
  // The page makes a new group object whenever its rows are grouped again; the same steps in it are the same group.
  (a, b) => a.open === b.open && a.setOpen === b.setOpen && a.fullResult === b.fullResult && a.group.id === b.group.id && a.group.rows.length === b.group.rows.length && a.group.rows.every((r, i) => r === b.group.rows[i]),
)
