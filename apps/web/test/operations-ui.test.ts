// What the controls look like when they must not work: no "+" for a machine with no readable layout,
// every control off while the backend or core is away, and the menu names what it offers.
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { TabStrip } from "@/components/shell/main-area"
import { Sidebar } from "@/components/shell/sidebar"
import { agentGroups, buildShell, resolveSelection, type Selection } from "@/lib/model"
import { operations } from "@/lib/operations"
import { initialState, type LiveState } from "@/lib/store"
import { agent, connected, layout, term, terminal, unavailable } from "./fixtures"

const noop = () => {}
const ops = operations("http://backend.invalid")
const NONE: Selection = { space: null, tab: null, pane: null }

const state = (over: Partial<LiveState>): LiveState => ({ ...initialState, ready: true, link: "open", connection: connected, ...over })

function strip(s: LiveState, disabled = false): string {
  const shell = buildShell(s)
  return renderToStaticMarkup(
    createElement(TabStrip, { resolved: resolveSelection(shell, NONE), sidebarOpen: true, onOpenSidebar: noop, onSelect: noop, ops, disabled, onStarted: noop, onKill: noop }),
  )
}

/** The opening tag of the element with this test id. */
const button = (html: string, testId: string): string => {
  const at = html.indexOf(`data-testid="${testId}"`)
  expect(at, testId).toBeGreaterThan(-1)
  return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1)
}
// a real attribute, not a `disabled:` class
const OFF = /\sdisabled(=""|\s|>)/

const withSpace = state({
  terminals: { t1: terminal("t1") },
  layouts: { "": layout(null, [{ id: "s1", tabs: [{ id: "a", panes: [term("t1")] }] }]) },
})

describe("the new-terminal control", () => {
  it("is on a space of a readable layout, and off while disconnected", () => {
    expect(strip(withSpace)).toContain('data-testid="new-terminal"')
    expect(button(strip(withSpace), "new-terminal")).not.toMatch(OFF)
    expect(button(strip(withSpace, true), "new-terminal")).toMatch(OFF)
  })
  it("is not there for a machine with no readable layout (its terminals are listed flat)", () => {
    const flat = state({ terminals: { t1: terminal("t1") }, layouts: { "": unavailable(null, "unreadable") } })
    expect(strip(flat)).not.toContain('data-testid="new-terminal"')
  })
})

describe("the tab and agent menus", () => {
  it("every control is off while the backend or core is away", () => {
    const s = state({ terminals: { t1: agent("t1", "idle", { turn: 2 }) }, layouts: { "": layout(null, [{ id: "s1", tabs: [{ id: "a", panes: [term("t1")] }] }]) } })
    const shell = buildShell(s)
    const html = renderToStaticMarkup(
      createElement(Sidebar, {
        shell, groups: agentGroups(s, shell), resolved: resolveSelection(shell, NONE), now: 1_000_000, stale: true,
        onSelect: noop, onCollapse: noop, onSignOut: noop, disabled: true, rowErrors: { t1: "t1 has ended." }, onPin: noop, onUnread: noop, onKill: noop,
      }),
    )
    expect(button(html, "agent-menu")).toMatch(OFF)
    expect(html).toContain("t1 has ended.") // an error stays next to its row
    expect(button(strip(s, true), "tab-menu")).toMatch(OFF)
  })
})
