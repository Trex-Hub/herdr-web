"use client"

import { Bot, LogOut, Monitor, Moon, PanelLeftClose, Pin, Server, Sun } from "lucide-react"
import { Button } from "@/components/ui/button"
import { agentState, formatAge, isPinned, stateLabel, type AgentState } from "@/lib/agents"
import { agentLabel, type AgentGroup, MachineItem, Resolved, Shell, SpaceItem } from "@/lib/model"
import type { Selection } from "@/lib/model"
import { toggleTheme } from "@/lib/theme"
import { cn } from "@/lib/utils"

/** A stable colour per name, readable on both themes. */
export function colourFor(name: string): string {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360
  return `oklch(0.62 0.12 ${h})`
}

/** The last two parts of a folder, `…/ayra-ventures/app`. */
export function shortFolder(folder: string): string {
  const parts = folder.split("/").filter(Boolean)
  if (parts.length <= 2) return folder
  return `…/${parts.slice(-2).join("/")}`
}

export const dotClass: Record<AgentState, string> = {
  needs_you: "bg-red-500",
  working: "bg-emerald-500 animate-pulse",
  done: "bg-sky-500",
  idle: "border border-muted-foreground/60",
}

export function StateDot({ state }: { state: AgentState }) {
  return (
    <span className="flex shrink-0 items-center" title={stateLabel[state]}>
      <span className={cn("size-2.5 rounded-full", dotClass[state])} data-state={state} />
      <span className="sr-only">{stateLabel[state]}</span>
    </span>
  )
}

/** The first character a person sees in the name (a whole emoji, not half of one), upper-cased. */
function badgeOf(name: string): string {
  const first = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(name.trim())[Symbol.iterator]().next()
  return first.done ? "?" : first.value.segment.toUpperCase()
}

function SpaceRow({ space, selected, onSelect }: { space: SpaceItem; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      data-testid="space-row"
      data-selected={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60",
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center rounded text-[11px] font-semibold text-white" style={{ background: colourFor(space.name) }}>
        {badgeOf(space.name)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{space.name}</span>
        {space.folder && <span className="block truncate text-xs text-muted-foreground">{shortFolder(space.folder)}</span>}
      </span>
    </button>
  )
}

function MachineBlock({ machine, selection, onSelect }: { machine: MachineItem; selection: Resolved; onSelect: (space: SpaceItem) => void }) {
  const Icon = machine.name === null ? Monitor : Server
  const rows = machine.flat ? [...machine.spaces, machine.flat] : machine.spaces
  return (
    <div data-testid="machine" data-machine={machine.title} className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5 px-2 pt-2 text-xs text-muted-foreground">
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{machine.title}</span>
      </div>
      {machine.down && (
        <p data-testid="machine-down" className="line-clamp-2 px-2 text-xs text-amber-700 dark:text-amber-300" title={machine.down.why ?? undefined}>
          {machine.down.state}
          {machine.down.why ? `: ${machine.down.why}` : ""}
        </p>
      )}
      {machine.notice && (
        <p data-testid="machine-notice" className="px-2 text-xs text-amber-700 dark:text-amber-300">
          {machine.notice}
        </p>
      )}
      {rows.map((space) => (
        <SpaceRow
          key={space.key}
          space={machine.flat === space ? { ...space, name: `${space.name} · terminals`, folder: `${space.tabs.length} live` } : space}
          selected={selection.space?.key === space.key}
          onSelect={() => onSelect(space)}
        />
      ))}
    </div>
  )
}

export function ThemeToggle() {
  return (
    <Button variant="ghost" size="icon-sm" aria-label="Toggle dark and light theme" data-testid="theme-toggle" onClick={toggleTheme}>
      <Sun className="size-4 dark:hidden" />
      <Moon className="hidden size-4 dark:block" />
    </Button>
  )
}

interface SidebarProps {
  shell: Shell
  groups: AgentGroup[]
  resolved: Resolved
  now: number
  stale: boolean
  onSelect: (selection: Selection) => void
  onCollapse: () => void
  onSignOut: () => void
}

export function Sidebar({ shell, groups, resolved, now, stale, onSelect, onCollapse, onSignOut }: SidebarProps) {
  return (
    <aside data-testid="sidebar" className="flex h-full w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex h-11 items-center justify-between px-3">
        <span className="font-semibold">herdr web</span>
        <Button variant="ghost" size="icon-sm" aria-label="Collapse sidebar" onClick={onCollapse}>
          <PanelLeftClose className="size-4" />
        </Button>
      </div>
      <div data-stale={stale} className={cn("flex min-h-0 flex-1 flex-col", stale && "opacity-60")}>
        <section className="min-h-0 flex-[3] overflow-y-auto px-2 pb-2">
          <h2 className="px-2 pt-1 text-xs font-medium text-muted-foreground">Spaces</h2>
          {shell.machines.map((m) => (
            <MachineBlock key={m.key} machine={m} selection={resolved} onSelect={(space) => onSelect({ space: space.key, tab: null, pane: null })} />
          ))}
        </section>
        <section className="min-h-0 flex-[2] overflow-y-auto border-t border-sidebar-border px-2 pb-2">
          <h2 className="px-2 pt-3 text-xs font-medium text-muted-foreground">Agents</h2>
          {groups.length === 0 && <p className="px-2 pt-2 text-xs text-muted-foreground">No agents running.</p>}
          {groups.map((g) => (
            <div key={g.key} data-testid="agent-group" className="flex flex-col gap-0.5 pt-2">
              <div className="truncate px-2 text-xs text-muted-foreground">{g.title}</div>
              {g.agents.map(({ terminal, located }) => {
                const state = agentState(terminal)
                const selected = resolved.pane?.terminal?.address === terminal.address
                return (
                  <button
                    key={terminal.address}
                    type="button"
                    data-testid="agent-row"
                    data-address={terminal.address}
                    data-state={state}
                    data-selected={selected}
                    disabled={!located}
                    title={located ? undefined : "Not in any space's layout"}
                    onClick={() => located && onSelect({ space: located.space.key, tab: located.tab.id, pane: located.pane.id })}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      selected ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60",
                    )}
                  >
                    <Bot className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{agentLabel(terminal, located)}</span>
                    {isPinned(terminal) && <Pin className="size-3 shrink-0 text-muted-foreground" aria-label="Pinned" />}
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatAge(now, terminal.status_ms)}</span>
                    <StateDot state={state} />
                  </button>
                )
              })}
            </div>
          ))}
        </section>
      </div>
      <div className="flex items-center justify-between border-t border-sidebar-border p-2">
        <ThemeToggle />
        <Button variant="ghost" size="sm" onClick={onSignOut} data-testid="sign-out">
          <LogOut className="size-4" />
          Sign out
        </Button>
      </div>
    </aside>
  )
}
