"use client"

import { Bot, PanelLeftOpen, SquareDashed, Terminal as TerminalIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { agentName, agentState, formatAge, stateLabel } from "@/lib/agents"
import type { PaneItem, Resolved } from "@/lib/model"
import type { Selection } from "@/lib/model"
import { cn } from "@/lib/utils"
import { StateDot } from "./sidebar"

export function TabStrip({
  resolved,
  sidebarOpen,
  onOpenSidebar,
  onSelect,
}: {
  resolved: Resolved
  sidebarOpen: boolean
  onOpenSidebar: () => void
  onSelect: (selection: Selection) => void
}) {
  const { space, tab } = resolved
  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b px-2">
      {!sidebarOpen && (
        <Button variant="ghost" size="icon-sm" aria-label="Open sidebar" data-testid="open-sidebar" onClick={onOpenSidebar}>
          <PanelLeftOpen className="size-4" />
        </Button>
      )}
      <div role="tablist" aria-label="Tabs" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {space?.tabs.map((t) => {
          const selected = t.id === tab?.id
          const Icon = t.hasAgent ? Bot : TerminalIcon
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={selected}
              data-testid="tab"
              data-selected={selected}
              data-extra={t.extra}
              onClick={() => onSelect({ space: space.key, tab: t.id, pane: null })}
              className={cn(
                "flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selected ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60",
              )}
            >
              <Icon className="size-3.5 shrink-0" />
              <span className="max-w-48 truncate">{t.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function paneName(pane: PaneItem, index: number): string {
  if (pane.terminal) return agentName(pane.terminal)
  return pane.mod ? `${pane.mod} pane` : `Pane ${index + 1}`
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 text-sm">
      <dt className="w-16 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 break-all font-mono text-xs leading-5" data-testid={`fact-${label.toLowerCase()}`}>
        {value || "—"}
      </dd>
    </div>
  )
}

/** The placeholder for a pane until the terminal and chat views exist. */
function PaneCard({ pane, now }: { pane: PaneItem; now: number }) {
  const t = pane.terminal
  if (!t) {
    return (
      <Card data-testid="pane-card" data-kind="other" className="max-w-xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SquareDashed className="size-4" /> No terminal in this pane
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">{pane.mod ? `This pane holds “${pane.mod}”, which has no terminal.` : "This pane holds something that is not a terminal."}</CardContent>
      </Card>
    )
  }
  const program = t.foreground?.name ?? t.status?.app ?? t.argv[0] ?? ""
  const state = t.status ? agentState(t) : null
  const status = t.status ? [stateLabel[agentState(t)], t.status.state !== "idle" && t.status.state !== "working" ? `(${t.status.state})` : "", t.status.msg ? `· ${t.status.msg}` : "", t.status_ms ? `· ${formatAge(now, t.status_ms)}` : ""].filter(Boolean).join(" ") : "no status reported"
  return (
    <Card data-testid="pane-card" data-kind="terminal" data-address={t.address} className="max-w-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {t.status ? <Bot className="size-4" /> : <TerminalIcon className="size-4" />}
          <span className="truncate">{agentName(t)}</span>
          {state && <StateDot state={state} />}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="flex flex-col gap-1.5">
          <Fact label="Address" value={t.address} />
          <Fact label="Program" value={program} />
          <Fact label="Folder" value={t.cwd} />
          <Fact label="Title" value={t.title} />
          <Fact label="Status" value={status} />
        </dl>
      </CardContent>
    </Card>
  )
}

export function MainArea({ resolved, now, onSelect }: { resolved: Resolved; now: number; onSelect: (selection: Selection) => void }) {
  const { space, tab, pane } = resolved
  if (!space || !tab) {
    return (
      <div data-testid="empty" className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        {space ? "This space has no tabs yet." : "Nothing to show yet."}
      </div>
    )
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      {tab.panes.length > 1 && (
        <div role="tablist" aria-label="Panes" className="flex flex-wrap gap-1">
          {tab.panes.map((p, i) => (
            <Button
              key={p.id}
              role="tab"
              aria-selected={p.id === pane?.id}
              data-testid="pane-switch"
              variant={p.id === pane?.id ? "secondary" : "ghost"}
              size="sm"
              onClick={() => onSelect({ space: space.key, tab: tab.id, pane: p.id })}
            >
              {paneName(p, i)}
            </Button>
          ))}
        </div>
      )}
      {pane ? (
        <PaneCard pane={pane} now={now} />
      ) : (
        <p data-testid="empty" className="text-sm text-muted-foreground">
          This tab has no live panes.
        </p>
      )}
    </div>
  )
}
