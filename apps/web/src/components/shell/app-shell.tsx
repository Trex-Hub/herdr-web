"use client"

import { useMemo } from "react"
import { agentGroups, buildShell, resolveSelection, type Selection } from "@/lib/model"
import { useLiveState, useNow, useStored } from "@/lib/live-context"
import { staleness } from "@/lib/store"
import { Banner } from "./banner"
import { MainArea, TabStrip } from "./main-area"
import { Sidebar } from "./sidebar"

const NO_SELECTION: Selection = { space: null, tab: null, pane: null }

export function AppShell({ onSignOut }: { onSignOut: () => void }) {
  const state = useLiveState()
  const now = useNow()
  const [selection, setSelection] = useStored<Selection>("herdr-web.selection", NO_SELECTION)
  const [sidebarOpen, setSidebarOpen] = useStored<boolean>("herdr-web.sidebar", true)

  const shell = useMemo(() => buildShell(state), [state])
  const groups = useMemo(() => agentGroups(state, shell), [state, shell])
  const resolved = useMemo(() => resolveSelection(shell, selection), [shell, selection])
  const stale = staleness(state) !== null

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
        />
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        <Banner state={state} />
        <TabStrip resolved={resolved} sidebarOpen={sidebarOpen} onOpenSidebar={() => setSidebarOpen(true)} onSelect={setSelection} />
        <div data-stale={stale && state.ready} className={stale && state.ready ? "flex min-h-0 flex-1 flex-col opacity-60" : "flex min-h-0 flex-1 flex-col"}>
          {state.ready ? <MainArea resolved={resolved} now={now} onSelect={setSelection} /> : <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading…</div>}
        </div>
      </main>
    </div>
  )
}
