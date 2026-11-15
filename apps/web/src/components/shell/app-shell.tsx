"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Terminal } from "@herdr-web/protocol"
import { isAgent, isPinned, seenTurn } from "@/lib/agents"
import { agentGroups, buildShell, locateTerminal, resolveSelection, type Selection } from "@/lib/model"
import { useLiveState, useNow, useStored } from "@/lib/live-context"
import { operations, type OpResult } from "@/lib/operations"
import { SeenTracker } from "@/lib/seen"
import { staleness } from "@/lib/store"
import { Banner } from "./banner"
import { MainArea, TabStrip } from "./main-area"
import { KillDialog, type KillTarget } from "./operations"
import { Sidebar } from "./sidebar"

const NO_SELECTION: Selection = { space: null, tab: null, pane: null }

/** Whether a person is looking at this page: shown, and the window that has the keyboard. */
function usePageAttended(): boolean {
  const [attended, setAttended] = useState(false)
  useEffect(() => {
    const update = () => setAttended(document.visibilityState === "visible" && document.hasFocus())
    update()
    document.addEventListener("visibilitychange", update)
    window.addEventListener("focus", update)
    window.addEventListener("blur", update)
    return () => {
      document.removeEventListener("visibilitychange", update)
      window.removeEventListener("focus", update)
      window.removeEventListener("blur", update)
    }
  }, [])
  return attended
}

export function AppShell({ onSignOut }: { onSignOut: () => void }) {
  const state = useLiveState()
  const now = useNow()
  const [selection, setSelection] = useStored<Selection>("herdr-web.selection", NO_SELECTION)
  const [sidebarOpen, setSidebarOpen] = useStored<boolean>("herdr-web.sidebar", true)
  const ops = useMemo(() => operations(), [])

  const shell = useMemo(() => buildShell(state), [state])
  const groups = useMemo(() => agentGroups(state, shell), [state, shell])
  const resolved = useMemo(() => resolveSelection(shell, selection), [shell, selection])
  const stale = staleness(state) !== null
  // Nothing that changes core is possible, or queued, while the backend or core is away.
  const disabled = !state.ready || stale

  // A terminal that was just started is selected when it arrives.
  const [arriving, setArriving] = useState<string | null>(null)
  useEffect(() => {
    if (!arriving) return
    const where = locateTerminal(shell, arriving)
    if (where) {
      setSelection({ space: where.space.key, tab: where.tab.id, pane: where.pane.id })
      setArriving(null)
    }
  }, [arriving, shell, setSelection])

  // Kill: confirm first; afterwards the selection moves to a neighbouring tab.
  const [killing, setKilling] = useState<KillTarget | null>(null)
  const afterKill = useCallback(
    (address: string) => {
      const where = locateTerminal(shell, address)
      if (!where) return
      const { space, tab } = where
      const index = space.tabs.findIndex((t) => t.id === tab.id)
      const next = space.tabs[index + 1] ?? space.tabs[index - 1]
      setSelection({ space: space.key, tab: next ? next.id : null, pane: null })
    },
    [shell, setSelection],
  )

  // Pin and mark unread, from the agent row's menu. A failure shows under that row.
  const tracker = useRef(new SeenTracker())
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const rowOp = useCallback(async <T,>(address: string, call: () => Promise<OpResult<T>>) => {
    const result = await call()
    setRowErrors((e) => {
      const { [address]: _gone, ...rest } = e
      return result.ok ? rest : { ...rest, [address]: result.error }
    })
    return result
  }, [])
  const onPin = (t: Terminal) => void rowOp(t.address, () => ops.pin({ terminal: t.address, pinned: !isPinned(t) }))
  const onUnread = (t: Terminal) => {
    tracker.current.markedUnread(t.address, t.turn ?? 0)
    void rowOp(t.address, () => ops.unread({ terminal: t.address }))
  }

  // Seen, automatic: the agent whose pane is shown, while the page is visible and focused, once for each new turn.
  const attended = usePageAttended()
  const shown = resolved.pane?.terminal ?? null
  const turn = shown?.turn ?? 0
  const seen = shown ? seenTurn(shown) : null
  const shownAddress = shown && shown.state !== "finished" && isAgent(shown) ? shown.address : null
  useEffect(() => {
    if (!shownAddress || disabled) return
    const write = tracker.current.decide({ address: shownAddress, turn, seen }, attended)
    if (write === null) return
    void ops.seen({ terminal: shownAddress, turn: write }).then((r) => {
      if (!r.ok) tracker.current.failed(shownAddress, write)
    })
  }, [shownAddress, turn, seen, attended, disabled, ops])

  return (
    <div className="flex h-svh min-w-0 overflow-hidden">
      {sidebarOpen && (
        <Sidebar
          shell={shell}
          groups={groups}
          resolved={resolved}
          now={now}
          stale={stale && state.ready}
          onSelect={setSelection}
          onCollapse={() => setSidebarOpen(false)}
          onSignOut={onSignOut}
          disabled={disabled}
          rowErrors={rowErrors}
          onPin={onPin}
          onUnread={onUnread}
          onKill={setKilling}
        />
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        <Banner state={state} />
        <TabStrip
          resolved={resolved}
          sidebarOpen={sidebarOpen}
          onOpenSidebar={() => setSidebarOpen(true)}
          onSelect={setSelection}
          ops={ops}
          disabled={disabled}
          onStarted={setArriving}
          onKill={setKilling}
        />
        <div data-stale={stale && state.ready} className={stale && state.ready ? "flex min-h-0 flex-1 flex-col opacity-60" : "flex min-h-0 flex-1 flex-col"}>
          {state.ready ? <MainArea resolved={resolved} selection={selection} terminals={state.terminals} onSelect={setSelection} /> : <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading…</div>}
        </div>
      </main>
      <KillDialog target={killing} ops={ops} disabled={disabled} onClose={() => setKilling(null)} onKilled={afterKill} />
    </div>
  )
}
