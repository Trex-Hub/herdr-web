import type { Layout, Machine, Terminal } from "@herdr-web/protocol"
import { agentName, isAgent, isPinned } from "./agents"
import type { LiveState } from "./store"

export interface PaneItem {
  id: string
  /** "other": a pane that holds no terminal (a mod pane). */
  kind: "terminal" | "other"
  terminal: Terminal | null
  mod: string | null
}

export interface TabItem {
  key: string
  id: string
  /** The tab's name, or its position (1, 2, ...) when it has none. */
  label: string
  /** A live terminal in no pane, shown as a tab of the space it is labelled for. */
  extra: boolean
  panes: PaneItem[]
  /** Any pane holds an agent: the tab strip shows the agent icon. */
  hasAgent: boolean
}

export interface SpaceItem {
  key: string
  id: string
  name: string
  folder: string
  machine: string | null
  tabs: TabItem[]
}

export interface MachineItem {
  key: string
  /** null: the backend's own computer. */
  name: string | null
  title: string
  /** Set when the machine's line is not up. */
  down: { state: string; why: string | null } | null
  /** Set when the machine is up but its layout cannot be shown. */
  notice: string | null
  spaces: SpaceItem[]
  /** With no readable layout: the machine's live terminals, one tab each. */
  flat: SpaceItem | null
}

export interface Shell {
  machines: MachineItem[]
}

export const THIS_COMPUTER = "This computer"

/** `cachyos/t7` is on machine `cachyos`; `t7` is on the backend's own computer. */
export function machineOf(address: string): string | null {
  const slash = address.indexOf("/")
  return slash < 0 ? null : address.slice(0, slash)
}

const machineKey = (machine: string | null): string => machine ?? ""

function isLive(t: Terminal | undefined): t is Terminal {
  return t !== undefined && t.state === "live"
}

function terminalTabLabel(t: Terminal): string {
  return agentName(t)
}

function paneFor(t: Terminal): PaneItem {
  return { id: `x:${t.address}`, kind: "terminal", terminal: t, mod: null }
}

function tabFrom(key: string, id: string, label: string, extra: boolean, panes: PaneItem[]): TabItem {
  return { key, id, label, extra, panes, hasAgent: panes.some((p) => p.terminal !== null && isAgent(p.terminal)) }
}

/** A machine's spaces from its layout, with the terminals the layout and core disagree about reconciled. */
function spacesFor(machine: string | null, layout: Layout, live: Terminal[]): SpaceItem[] {
  const inPane = new Set<string>()
  for (const space of layout.spaces)
    for (const tab of space.tabs)
      for (const pane of tab.panes) if (pane.kind === "terminal") inPane.add(pane.terminal)
  const byAddress = new Map(live.map((t) => [t.address, t]))

  return layout.spaces.map((space): SpaceItem => {
    const spaceKey = `${machineKey(machine)}|${space.id}`
    const tabs = space.tabs.map((tab, i): TabItem => {
      // A pane whose terminal is not live is hidden.
      const panes: PaneItem[] = []
      for (const pane of tab.panes) {
        if (pane.kind === "other") panes.push({ id: pane.id, kind: "other", terminal: null, mod: pane.mod })
        else {
          const terminal = byAddress.get(pane.terminal)
          if (terminal) panes.push({ id: pane.id, kind: "terminal", terminal, mod: null })
        }
      }
      return tabFrom(`${spaceKey}|${tab.id}`, tab.id, tab.name || String(i + 1), false, panes)
    })
    // A live terminal labelled for this space but in no pane is an extra tab.
    const extras = live
      .filter((t) => t.labels["herdr.space"] === space.id && !inPane.has(t.address))
      .sort((a, b) => a.created_ms - b.created_ms)
    for (const t of extras) tabs.push(tabFrom(`${spaceKey}|x:${t.address}`, `x:${t.address}`, terminalTabLabel(t), true, [paneFor(t)]))
    return { key: spaceKey, id: space.id, name: space.name, folder: space.folder, machine, tabs }
  })
}

function flatFor(machine: string | null, live: Terminal[]): SpaceItem {
  const key = `${machineKey(machine)}|flat`
  const sorted = [...live].sort((a, b) => a.created_ms - b.created_ms)
  return {
    key,
    id: "flat",
    name: machine ?? THIS_COMPUTER,
    folder: "",
    machine,
    tabs: sorted.map((t) => tabFrom(`${key}|x:${t.address}`, `x:${t.address}`, terminalTabLabel(t), true, [paneFor(t)])),
  }
}

/** Everything the sidebar, tab strip and main area show, from what the backend sent. */
export function buildShell(state: Pick<LiveState, "terminals" | "machines" | "layouts">): Shell {
  const liveByMachine = new Map<string, Terminal[]>()
  for (const t of Object.values(state.terminals)) {
    if (!isLive(t)) continue
    const k = machineKey(machineOf(t.address))
    const list = liveByMachine.get(k)
    if (list) list.push(t)
    else liveByMachine.set(k, [t])
  }

  const names = new Set<string>()
  for (const m of state.machines) names.add(m.name)
  for (const l of Object.values(state.layouts)) if (l.machine !== null) names.add(l.machine)
  const machineView = new Map<string, Machine>(state.machines.map((m) => [m.name, m]))

  const order: (string | null)[] = [null, ...[...names].sort((a, b) => a.localeCompare(b))]
  const machines = order.map((name): MachineItem => {
    const key = machineKey(name)
    const live = liveByMachine.get(key) ?? []
    const view = name === null ? undefined : machineView.get(name)
    const layout = state.layouts[key]
    const down = view && view.state !== "connected" ? { state: view.state, why: view.why } : null

    let spaces: SpaceItem[] = []
    let flat: SpaceItem | null = null
    let notice: string | null = null
    if (layout?.status === "ok") {
      spaces = spacesFor(name, layout, live)
    } else {
      flat = down ? null : flatFor(name, live)
      if (!down) {
        notice =
          layout === undefined
            ? "Waiting for the layout."
            : layout.status === "empty"
              ? "No layout yet; showing its terminals."
              : `Layout unavailable${layout.reason ? `: ${layout.reason}` : ""}`
      }
    }
    return { key, name, title: name ?? THIS_COMPUTER, down, notice, spaces, flat }
  })
  return { machines }
}

export interface Located {
  space: SpaceItem
  tab: TabItem
  pane: PaneItem
}

function allSpaces(shell: Shell): SpaceItem[] {
  return shell.machines.flatMap((m) => (m.flat ? [...m.spaces, m.flat] : m.spaces))
}

/** Where a terminal is shown: its space, tab and pane. */
export function locateTerminal(shell: Shell, address: string): Located | null {
  for (const space of allSpaces(shell))
    for (const tab of space.tabs)
      for (const pane of tab.panes) if (pane.terminal?.address === address) return { space, tab, pane }
  return null
}

/** What the browser remembers about where the person was looking. */
export interface Selection {
  space: string | null
  tab: string | null
  pane: string | null
}

export interface Resolved {
  space: SpaceItem | null
  tab: TabItem | null
  pane: PaneItem | null
}

/**
 * The selected space, tab and pane. What no longer exists falls back to the first of its level:
 * the first space (This computer's first), then that space's first tab, then the tab's first pane.
 */
export function resolveSelection(shell: Shell, selection: Selection): Resolved {
  const spaces = allSpaces(shell)
  const space = spaces.find((s) => s.key === selection.space) ?? spaces.find((s) => s.tabs.length > 0) ?? spaces[0] ?? null
  if (!space) return { space: null, tab: null, pane: null }
  const tab = space.tabs.find((t) => t.id === selection.tab) ?? space.tabs[0] ?? null
  const pane = tab ? (tab.panes.find((p) => p.id === selection.pane) ?? tab.panes[0] ?? null) : null
  return { space, tab, pane }
}

export interface AgentGroup {
  key: string
  title: string
  agents: { terminal: Terminal; located: Located | null }[]
}

/**
 * Agents grouped by space, in the order the spaces are listed; pinned first within a group.
 * Agents that sit in no space are listed last under their machine.
 */
export function agentGroups(state: Pick<LiveState, "terminals">, shell: Shell): AgentGroup[] {
  const agents = Object.values(state.terminals)
    .filter(isAgent)
    .sort((a, b) => Number(isPinned(b)) - Number(isPinned(a)) || a.created_ms - b.created_ms || a.address.localeCompare(b.address))

  const groups = new Map<string, AgentGroup>()
  const spaceOrder = allSpaces(shell)
  for (const t of agents) {
    const located = locateTerminal(shell, t.address)
    const key = located ? located.space.key : `none|${machineKey(machineOf(t.address))}`
    let group = groups.get(key)
    if (!group) {
      const machine = machineOf(t.address)
      group = { key, title: located ? located.space.name : `Not in a space (${machine ?? THIS_COMPUTER})`, agents: [] }
      groups.set(key, group)
    }
    group.agents.push({ terminal: t, located })
  }
  const rank = (g: AgentGroup): number => {
    const i = spaceOrder.findIndex((s) => s.key === g.key)
    // Unlocated groups come last, this computer's first.
    return i < 0 ? spaceOrder.length + (g.key === "none|" ? 0 : 1) : i
  }
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title))
}
