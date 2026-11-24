"use client"

import { useRef } from "react"
import { Bot, PanelLeftOpen, SquareDashed, Terminal as TerminalIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { agentName } from "@/lib/agents"
import type { Operations } from "@/lib/operations"
import { KebabMenu, NewTerminalMenu, type KillTarget } from "./operations"
import type { Terminal } from "@herdr-web/protocol"
import type { PaneItem, Resolved } from "@/lib/model"
import type { Selection } from "@/lib/model"
import { cn } from "@/lib/utils"
import { PaneView } from "./pane-view"

export function TabStrip({
  resolved,
  sidebarOpen,
  onOpenSidebar,
  onSelect,
  ops,
  disabled,
  onStarted,
  onKill,
}: {
  resolved: Resolved
  sidebarOpen: boolean
  onOpenSidebar: () => void
  onSelect: (selection: Selection) => void
  ops: Operations
  /** The backend or core is away: nothing that changes core can be done. */
  disabled: boolean
  onStarted: (address: string) => void
  onKill: (target: KillTarget) => void
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
            <div key={t.key} role="presentation" className="group/tab flex shrink-0 items-center">
              <button
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
                <span className="max-w-48 truncate font-heading">{t.label}</span>
              </button>
              <KebabMenu
                label={`Tab menu: ${t.label}`}
                testId="tab-menu"
                disabled={disabled}
                className={cn("-ml-1", selected ? "opacity-100" : "opacity-0 focus-visible:opacity-100 group-hover/tab:opacity-100")}
                items={t.panes.flatMap((p) =>
                  p.terminal && p.terminal.state !== "finished"
                    ? [{ key: p.terminal.address, label: `Kill ${agentName(p.terminal)}…`, testId: "tab-kill", run: () => onKill({ address: p.terminal!.address, name: agentName(p.terminal!) }) }]
                    : [],
                )}
              />
            </div>
          )
        })}
      </div>
      {space && !space.flat && <NewTerminalMenu key={space.key} space={space} ops={ops} disabled={disabled} onStarted={onStarted} />}
    </div>
  )
}

function paneName(pane: PaneItem, index: number): string {
  if (pane.terminal) return agentName(pane.terminal)
  return pane.mod ? `${pane.mod} pane` : `Pane ${index + 1}`
}

/** What a pane with no terminal in it shows. */
function NoTerminalCard({ pane }: { pane: PaneItem }) {
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

export function MainArea({
  resolved,
  selection,
  terminals,
  away,
  onSelect,
}: {
  resolved: Resolved
  /** What was chosen (not what it resolved to): it stays the same object until a person chooses again. */
  selection: Selection
  terminals: Record<string, Terminal>
  /** Which side of the link is down, if one is. */
  away: "backend" | "core" | null
  onSelect: (selection: Selection) => void
}) {
  const { space, tab, pane } = resolved
  // A terminal that ends while it is on screen leaves the layout (only live terminals have panes), and the selection would
  // move on to another one. Its view stays, with how it ended, until a person chooses something else.
  const shown = useRef<{ address: string; selection: Selection } | null>(null)
  const was = shown.current && shown.current.selection === selection ? terminals[shown.current.address] : undefined
  const lingering = was?.state === "finished" ? was : null
  const current = pane?.terminal && pane.terminal.state !== "finished" ? pane.terminal : null
  if (!lingering && current) shown.current = { address: current.address, selection }
  const live = lingering ?? current
  if (!live && (!space || !tab)) {
    return (
      <div data-testid="empty" className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        {space ? "This space has no tabs yet." : "Nothing to show yet."}
      </div>
    )
  }
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col gap-3", live ? "pt-2" : "overflow-y-auto p-4")}>
      {space && tab && !lingering && tab.panes.length > 1 && (
        <div role="tablist" aria-label="Panes" className={cn("flex flex-wrap gap-1", live && "px-2")}>
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
      {live ? (
        <PaneView key={live.address} terminal={live} away={away} />
      ) : pane ? (
        <NoTerminalCard pane={pane} />
      ) : (
        <p data-testid="empty" className="text-sm text-muted-foreground">
          This tab has no live panes.
        </p>
      )}
    </div>
  )
}
