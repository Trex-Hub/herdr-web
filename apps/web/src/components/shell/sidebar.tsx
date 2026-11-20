"use client"

import { Bot, LogOut, Monitor, Moon, PanelLeftClose, Pin, Server, Sun } from "lucide-react"
import { Button } from "@/components/ui/button"
import { agentState, formatAge, isPinned, stateLabel, type AgentState } from "@/lib/agents"
import { agentLabel, spaceAddress, type AgentGroup, MachineItem, Resolved, Shell, SpaceItem } from "@/lib/model"
import { displayFolder } from "@/lib/paths"
import { tileFor } from "@/lib/space-colors"
import type { Selection } from "@/lib/model"
import { toggleTheme } from "@/lib/theme"
import { cn } from "@/lib/utils"
import type { AppShared, Terminal } from "@herdr-web/protocol"
import { KebabMenu, OpError, type KillTarget } from "./operations"
import { PiMark } from "./pi-mark"

export const dotClass: Record<AgentState, string> = {
  needs_you: "bg-red-500",
  working: "bg-emerald-500 animate-pulse",
  done: "bg-sky-500",
  idle: "border border-muted-foreground/60",
}

export function StateDot({ state }: { state: AgentState }) {
  return (
    <span className="flex shrink-0 items-center" title={stateLabel[state]}>
      <span className={cn("size-2 rounded-full", dotClass[state])} data-state={state} />
      <span className="sr-only">{stateLabel[state]}</span>
    </span>
  )
}

/** The first character a person sees in the name (a whole emoji, not half of one), upper-cased. */
function badgeOf(name: string): string {
  const first = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(name.trim())[Symbol.iterator]().next()
  return first.done ? "?" : first.value.segment.toUpperCase()
}

const sectionHeader = "px-2 text-xs text-muted-foreground"
const groupHeader = "px-2 text-xs font-medium text-sidebar-foreground/70"
const scrollbar = "scrollbar-thin scrollbar-thumb-foreground/20 hover:scrollbar-thumb-foreground/35 scrollbar-track-transparent"
// Light is one clear step darker than the sidebar; dark keeps the sidebar's accent surface.
const rowSelected = "bg-black/[0.06] text-sidebar-accent-foreground dark:bg-sidebar-accent"
// The row's menu button shows on hover, on focus, on the selected row and while its menu is open, over room the meta column
// makes by shifting left; otherwise it takes no room.
const kebabRoom = "group-hover/row:mr-6 group-focus-within/row:mr-6 group-has-[[aria-expanded=true]]/row:mr-6 group-data-[row-selected=true]/row:mr-6"
const kebabShown =
  "absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 group-data-[row-selected=true]/row:opacity-100 aria-expanded:opacity-100"
const rowHover = "hover:bg-black/[0.03] dark:hover:bg-sidebar-accent/50"

function SpaceRow({ space, colour, selected, onSelect }: { space: SpaceItem; colour: string | undefined; selected: boolean; onSelect: () => void }) {
  const tile = tileFor(space.name, colour)
  return (
    <button
      type="button"
      data-testid="space-row"
      data-selected={selected}
      title={space.folder || undefined}
      onClick={onSelect}
      className={cn(
        "flex h-10 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? rowSelected : rowHover,
      )}
    >
      <span data-testid="space-tile" className="flex size-5 shrink-0 items-center justify-center rounded-[6px] text-[11px] font-semibold" style={{ background: tile.background, color: tile.color }}>
        {badgeOf(space.name)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium leading-5">{space.name}</span>
        {space.folder && (
          <span data-testid="space-path" className="block truncate text-xs leading-4 text-muted-foreground">
            {space.flat ? space.folder : displayFolder(space.folder)}
          </span>
        )}
      </span>
    </button>
  )
}

const downLabel: Record<string, string> = { unreachable: "Unreachable", needs_login: "Needs login", connecting: "Connecting" }

function MachineBlock({ machine, shared, selection, onSelect }: { machine: MachineItem; shared: AppShared | null; selection: Resolved; onSelect: (space: SpaceItem) => void }) {
  const Icon = machine.name === null ? Monitor : Server
  const rows = machine.flat ? [...machine.spaces, machine.flat] : machine.spaces
  return (
    <div data-testid="machine" data-machine={machine.title} className="flex flex-col gap-1 pb-2">
      <div className={cn(sectionHeader, "flex h-7 items-center gap-2")} title={machine.down ? (machine.down.why ?? downLabel[machine.down.state] ?? machine.down.state) : undefined}>
        <span className="flex size-4 shrink-0 items-center justify-center">
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 truncate">{machine.title}</span>
        {machine.down && (
          <span data-testid="machine-down" className="ml-auto flex shrink-0 items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-amber-500" />
            {downLabel[machine.down.state] ?? machine.down.state}
          </span>
        )}
      </div>
      {machine.notice && (
        <p data-testid="machine-notice" className="px-2 text-xs text-amber-700 dark:text-amber-300">
          {machine.notice}
        </p>
      )}
      {rows.map((space) => (
        <SpaceRow
          key={space.key}
          space={machine.flat === space ? { ...space, name: `${space.name} · terminals`, folder: `${space.tabs.length} live` } : space}
          colour={shared?.["space.colors"][spaceAddress(space)]}
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
  /** The backend or core is away: the row menus are off. */
  disabled: boolean
  /** The sentence an agent row's last operation failed with, by address. */
  rowErrors: Record<string, string>
  onPin: (terminal: Terminal) => void
  onUnread: (terminal: Terminal) => void
  onKill: (target: KillTarget) => void
  /** herdr-app's names and colours, read-only; null when there are none. */
  shared?: AppShared | null
}

export function Sidebar({ shell, groups, resolved, now, stale, onSelect, onCollapse, onSignOut, disabled, rowErrors, onPin, onUnread, onKill, shared = null }: SidebarProps) {
  return (
    <aside data-testid="sidebar" className="flex h-full w-68 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex h-11 items-center justify-between px-3">
        <span className="font-semibold">herdr web</span>
        <Button variant="ghost" size="icon-sm" aria-label="Collapse sidebar" onClick={onCollapse}>
          <PanelLeftClose className="size-4" />
        </Button>
      </div>
      <div data-stale={stale} className={cn("flex min-h-0 flex-1 flex-col", stale && "opacity-60")}>
        <section data-testid="spaces-block" className={cn("min-h-0 flex-1 overflow-y-auto px-2", scrollbar)}>
          <h2 className={cn(sectionHeader, "pb-2 pt-3 font-normal")}>Spaces</h2>
          {shell.machines.map((m) => (
            <MachineBlock key={m.key} machine={m} shared={shared} selection={resolved} onSelect={(space) => onSelect({ space: space.key, tab: null, pane: null })} />
          ))}
        </section>
        <section data-testid="agents-block" className={cn("max-h-1/2 shrink-0 overflow-y-auto border-t border-sidebar-border px-2 pb-2", scrollbar)}>
          {groups.length === 0 ? (
            <p className={cn(sectionHeader, "py-3")}>No agents running</p>
          ) : (
            <>
              <h2 className={cn(sectionHeader, "pb-2 pt-3 font-normal")}>Agents</h2>
              {groups.map((g, i) => (
                <div key={g.key} data-testid="agent-group" className="flex flex-col">
                  <div className={cn(groupHeader, "truncate pb-1", i === 0 ? "pt-0" : "pt-4")}>{g.title}</div>
                  {g.agents.map(({ terminal, located }) => {
                    const state = agentState(terminal)
                    const selected = resolved.pane?.terminal?.address === terminal.address
                    const label = agentLabel(terminal, located, shared)
                    const Icon = terminal.status?.app === "pi" ? PiMark : Bot
                    // The space, when the group is not it: dropped, not squeezed, when the name needs the room.
                    const space = located && located.space.key !== g.key && located.space.name !== g.title ? located.space.name : null
                    return (
                      <div key={terminal.address} className="flex flex-col">
                        <div data-row-selected={selected} className="group/row relative flex items-center">
                          <button
                            type="button"
                            data-testid="agent-row"
                            data-address={terminal.address}
                            data-state={state}
                            data-selected={selected}
                            disabled={!located}
                            title={located ? undefined : "Not in any space's layout"}
                            onClick={() => located && onSelect({ space: located.space.key, tab: located.tab.id, pane: located.pane.id })}
                            className={cn(
                              "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                              selected ? rowSelected : rowHover,
                            )}
                          >
                            <Icon data-testid="agent-icon" data-icon={terminal.status?.app === "pi" ? "pi" : "bot"} className="size-4 shrink-0 text-muted-foreground" />
                            <span className="flex h-5 min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 overflow-hidden">
                              <span data-testid="agent-name" className="max-w-full truncate leading-5">{label}</span>
                              {space && <span data-testid="agent-space" className="whitespace-nowrap text-xs leading-5 text-muted-foreground">· {space}</span>}
                            </span>
                            <span className={cn("flex shrink-0 items-center gap-1.5", kebabRoom)}>
                              <span className="flex size-3 items-center justify-center">{isPinned(terminal) && <Pin className="size-3 text-muted-foreground" aria-label="Pinned" />}</span>
                              <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">{formatAge(now, terminal.status_ms)}</span>
                              <StateDot state={state} />
                            </span>
                          </button>
                          <KebabMenu
                            label={`Menu for ${label}`}
                            testId="agent-menu"
                            disabled={disabled}
                            className={kebabShown}
                            items={[
                              { key: "pin", label: isPinned(terminal) ? "Unpin" : "Pin", testId: "agent-pin", run: () => onPin(terminal) },
                              { key: "unread", label: "Mark unread", testId: "agent-unread", disabled: (terminal.turn ?? 0) === 0, run: () => onUnread(terminal) },
                              { key: "kill", label: "Kill…", testId: "agent-kill", run: () => onKill({ address: terminal.address, name: label }) },
                            ]}
                          />
                        </div>
                        <OpError error={rowErrors[terminal.address] ?? null} className="px-2 pb-1 text-xs text-destructive" />
                      </div>
                    )
                  })}
                </div>
              ))}
            </>
          )}
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
