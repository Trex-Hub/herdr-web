"use client"

import { useMemo, useState } from "react"
import { PanelLeftOpen } from "lucide-react"
import { Sidebar } from "@/components/shell/sidebar"
import { Button } from "@/components/ui/button"
import { agentGroups, buildShell, resolveSelection, type Selection } from "@/lib/model"
import { NOW, shellFixture, type ShellScenario } from "@/dev/shell-fixtures"

const NOOP = () => {}
const CHOICES: { key: keyof ShellScenario; label: string }[] = [
  { key: "file", label: "herdr-app file" },
  { key: "agents", label: "Agents" },
  { key: "many", label: "Many spaces" },
  { key: "crowd", label: "Many agents" },
]

/** The real sidebar on fixture data (this computer, two added machines, a dozen agents) beside a stand-in main area. */
export function DevShell() {
  const [scenario, setScenario] = useState<ShellScenario>({ file: true, agents: true, many: false, crowd: false })
  const [selection, setSelection] = useState<Selection>({ space: "|sp-herdr", tab: null, pane: null })
  const [open, setOpen] = useState(true)
  const state = useMemo(() => shellFixture(scenario), [scenario])
  const shell = useMemo(() => buildShell(state), [state])
  const groups = useMemo(() => agentGroups(state, shell), [state, shell])
  const resolved = useMemo(() => resolveSelection(shell, selection), [shell, selection])

  return (
    <div className="flex h-svh min-w-0 overflow-hidden" data-testid="dev-shell">
      {open && (
        <Sidebar
          shell={shell}
          groups={groups}
          resolved={resolved}
          now={NOW}
          stale={false}
          onSelect={setSelection}
          onCollapse={() => setOpen(false)}
          onSignOut={NOOP}
          disabled={false}
          rowErrors={{}}
          onPin={NOOP}
          onUnread={NOOP}
          onKill={NOOP}
          shared={state.appShared}
        />
      )}
      <main className="flex min-w-0 flex-1 flex-col gap-4 p-6 text-sm">
        {!open && (
          <Button variant="ghost" size="icon-sm" aria-label="Open sidebar" className="self-start" onClick={() => setOpen(true)}>
            <PanelLeftOpen className="size-4" />
          </Button>
        )}
        <h1 className="text-base font-semibold">Shell fixture</h1>
        <p className="text-muted-foreground">The sidebar on fixture data. Selected: {resolved.space?.name ?? "nothing"}.</p>
        <div className="flex flex-col gap-2" data-testid="dev-shell-controls">
          {CHOICES.map(({ key, label }) => (
            <label key={key} className="flex items-center gap-2">
              <input type="checkbox" checked={scenario[key]} onChange={(e) => setScenario({ ...scenario, [key]: e.target.checked })} />
              {label}
            </label>
          ))}
        </div>
      </main>
    </div>
  )
}
