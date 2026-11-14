// Adversarial checks of what the shell's components render, and of the rules that only a component
// enforces. Rendered to static markup (no browser): the markup carries the same data-testid /
// data-* attributes the browser tests read.
import type { Layout } from "@herdr-web/protocol"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Banner, bannerFor } from "@/components/shell/banner"
import { MainArea, TabStrip } from "@/components/shell/main-area"
import { Sidebar } from "@/components/shell/sidebar"
import { agentGroups, buildShell, resolveSelection, type Selection } from "@/lib/model"
import { initialState, type LiveState } from "@/lib/store"
import { agent, connected, empty, layout, machine, other, term, terminal, unavailable } from "./fixtures"

const noop = () => {}
const NONE: Selection = { space: null, tab: null, pane: null }

function live(over: Partial<LiveState> = {}): LiveState {
  return { ...initialState, ready: true, link: "open", connection: connected, ...over }
}

function stateOf(terminals: ReturnType<typeof terminal>[], layouts: Layout[], machines = [] as ReturnType<typeof machine>[], over: Partial<LiveState> = {}): LiveState {
  return live({
    terminals: Object.fromEntries(terminals.map((t) => [t.address, t])),
    layouts: Object.fromEntries(layouts.map((l) => [l.machine ?? "", l])),
    machines,
    ...over,
  })
}

function sidebar(state: LiveState, selection: Selection = NONE, stale = false): string {
  const shell = buildShell(state)
  return renderToStaticMarkup(
    createElement(Sidebar, { shell, groups: agentGroups(state, shell), resolved: resolveSelection(shell, selection), now: 1_000_000, stale, onSelect: noop, onCollapse: noop, onSignOut: noop }),
  )
}

function main(state: LiveState, selection: Selection = NONE): string {
  const shell = buildShell(state)
  return renderToStaticMarkup(createElement(MainArea, { resolved: resolveSelection(shell, selection), now: 1_000_000, onSelect: noop }))
}

function tabs(state: LiveState, selection: Selection = NONE, sidebarOpen = true): string {
  const shell = buildShell(state)
  return renderToStaticMarkup(createElement(TabStrip, { resolved: resolveSelection(shell, selection), sidebarOpen, onOpenSidebar: noop, onSelect: noop }))
}

const count = (html: string, needle: string): number => html.split(needle).length - 1

describe("banner", () => {
  it("says nothing while everything is current, and before the first snapshot while connecting says so", () => {
    expect(bannerFor(live())).toBeNull()
    expect(renderToStaticMarkup(createElement(Banner, { state: live() }))).toBe("")
    expect(bannerFor({ ...initialState, link: "connecting" })?.kind).toBe("connecting")
    expect(bannerFor({ ...initialState, link: "reconnecting" })).toMatchObject({ kind: "connecting", text: expect.stringContaining("Retrying") })
  })

  it("backend lost beats core lost: with the page's own link down, core's state is not worth reporting", () => {
    const s = live({ link: "reconnecting", connection: { state: "reconnecting", error: "boom", core: null } })
    expect(bannerFor(s)?.kind).toBe("backend")
  })

  it("core lost shows the reason it was given, escaped", () => {
    const s = live({ connection: { state: "reconnecting", error: "<img src=x onerror=alert(1)>", core: null } })
    const html = renderToStaticMarkup(createElement(Banner, { state: s }))
    expect(html).toContain('data-kind="core"')
    expect(html).not.toContain("<img")
    expect(html).toContain("&lt;img")
  })

  it("every connection state that is not `connected` counts as core being lost, and says no reason when there is none", () => {
    for (const state of ["reconnecting", "connecting", "closed", "whatever"]) {
      const b = bannerFor(live({ connection: { state, error: null, core: null } }))
      expect(b?.kind, state).toBe("core")
      expect(b?.text, state).not.toContain("()")
    }
  })

  it("a reload request wins over everything and brings a Reload button; the others have none", () => {
    const html = renderToStaticMarkup(createElement(Banner, { state: live({ reload: "The backend was updated since this page was loaded.", link: "reconnecting" }) }))
    expect(html).toContain('data-kind="reload"')
    expect(html).toContain("Reload</button>")
    const other = renderToStaticMarkup(createElement(Banner, { state: live({ link: "reconnecting" }) }))
    expect(other).not.toContain("<button")
  })
})

describe("sidebar: spaces", () => {
  const two = (names: string[]) => stateOf([], [layout(null, names.map((n, i) => ({ id: `s${i}`, name: n, tabs: [] })))])

  it("escapes names and folders from the layout", () => {
    const html = sidebar(
      stateOf([], [layout(null, [{ id: "s1", name: '<script>alert("x")</script>', folder: "/tmp/<b>x</b>/<i>y</i>", tabs: [] }])]),
    )
    expect(html).not.toContain("<script>")
    expect(html).not.toContain("<b>x</b>")
    expect(html).toContain("&lt;script&gt;")
  })

  it("the badge shows the first letter, capitalised; an empty or blank name shows a question mark", () => {
    const html = sidebar(two(["alpha", "", "   "]))
    const badges = [...html.matchAll(/text-white[^>]*>([^<]*)</g)].map((m) => m[1])
    expect(badges).toEqual(["A", "?", "?"])
  })

  it("marks only the selected space", () => {
    const html = sidebar(two(["a", "b"]), { space: "|s1", tab: null, pane: null })
    expect([...html.matchAll(/data-selected="(true|false)"/g)].map((m) => m[1])).toEqual(["false", "true"])
  })

  it("a machine that is down shows its state and why, and no spaces and no terminals row", () => {
    const html = sidebar(stateOf([], [], [machine("mavbook", "unreachable", "cannot reach host")]))
    expect(html).toContain('data-testid="machine-down"')
    expect(html).toContain("unreachable: cannot reach host")
    expect(count(html, 'data-testid="space-row"')).toBe(1) // only This computer's own flat row
  })

  it("a machine that is down but has no reason shows only the state", () => {
    const html = sidebar(stateOf([], [], [machine("mavbook", "connecting", null)]))
    expect(html).toMatch(/connecting<\/p>/)
  })

  it("a machine without a readable layout becomes one `· terminals` row with the live count", () => {
    const html = sidebar(stateOf([terminal("cx/t1"), terminal("cx/t2"), terminal("cx/t3", { state: "finished" })], [unavailable("cx", "doc.get failed")], [machine("cx")]))
    expect(html).toContain("cx · terminals")
    expect(html).toContain("2 live")
    expect(html).toContain("Layout unavailable: doc.get failed")
  })

  it("1000 spaces render without throwing (keys are unique)", () => {
    const names = Array.from({ length: 1000 }, (_, i) => `space ${i}`)
    expect(count(sidebar(two(names)), 'data-testid="space-row"')).toBeGreaterThanOrEqual(1000)
  })
})

describe("sidebar: agents", () => {
  const ls = layout(null, [{ id: "s1", name: "work", tabs: [{ id: "a", name: "one", panes: [term("t1"), term("t2"), term("t3"), term("t4"), term("t5")] }] }])

  it("shows every state by the rules, pinned first, and a dot per state", () => {
    const html = sidebar(
      stateOf(
        [
          agent("t1", "blocked", { created_ms: 1, name: "needs" }),
          agent("t2", "working", { created_ms: 2, name: "busy" }),
          agent("t3", "idle", { created_ms: 3, name: "fresh", turn: 3, labels: { "herdr.seen": "2" } }),
          agent("t4", "idle", { created_ms: 4, name: "seen", turn: 3, labels: { "herdr.seen": "3" } }),
          agent("t5", "idle", { created_ms: 5, name: "pinned", labels: { "herdr.pinned": "1" } }),
        ],
        [ls],
      ),
    )
    const rows = [...html.matchAll(/data-address="(t\d)" data-state="([a-z_]+)"/g)].map((m) => `${m[1]}:${m[2]}`)
    expect(rows).toEqual(["t5:idle", "t1:needs_you", "t2:working", "t3:done", "t4:idle"])
    expect(html).toContain('aria-label="Pinned"')
  })

  it("a terminal without status is not an agent; a finished agent is not listed", () => {
    const html = sidebar(stateOf([terminal("t1"), agent("t2", "idle", { state: "finished" })], [ls]))
    expect(count(html, 'data-testid="agent-row"')).toBe(0)
    expect(html).toContain("No agents running.")
  })

  it("an agent that sits in no pane is listed under Not in a space and cannot be clicked", () => {
    const html = sidebar(stateOf([agent("t9", "idle", { name: "stray" })], [ls]))
    expect(html).toContain("Not in a space (This computer)")
    expect(html).toMatch(/data-testid="agent-row"[^>]*disabled/)
    expect(html).toContain("Not in any space&#x27;s layout")
  })

  it("the name of an agent is escaped", () => {
    const html = sidebar(stateOf([agent("t1", "idle", { name: "<b onclick=x>hi</b>" })], [ls]))
    expect(html).not.toContain("<b onclick")
  })

  it("stale marks both halves", () => {
    expect(count(sidebar(stateOf([], [ls]), NONE, true), 'data-stale="true"')).toBe(1)
    expect(count(sidebar(stateOf([], [ls]), NONE, false), 'data-stale="true"')).toBe(0)
  })

  it("the age of an agent comes from status_ms, empty when there is none", () => {
    const html = sidebar(stateOf([agent("t1", "idle", { status_ms: 1_000_000 - 3 * 3600_000 }), agent("t2", "idle", { status_ms: null })], [ls]))
    expect(html).toContain(">3h<")
  })
})

describe("tab strip", () => {
  const ls = layout(null, [{ id: "s1", name: "work", tabs: [{ id: "a", name: "named", panes: [term("t1")] }, { id: "b", panes: [term("t2")] }] }])

  it("the open-sidebar button appears only while the sidebar is closed", () => {
    expect(tabs(stateOf([terminal("t1")], [ls]), NONE, true)).not.toContain("open-sidebar")
    expect(tabs(stateOf([terminal("t1")], [ls]), NONE, false)).toContain("open-sidebar")
  })

  it("names unnamed tabs by position, marks extra tabs, and selects the remembered one", () => {
    const html = tabs(stateOf([terminal("t1"), terminal("t2"), terminal("t3", { name: "loose", labels: { "herdr.space": "s1" } })], [ls]), { space: "|s1", tab: "b", pane: null })
    expect([...html.matchAll(/data-selected="(\w+)" data-extra="(\w+)"/g)].map((m) => `${m[1]}/${m[2]}`)).toEqual(["false/false", "true/false", "false/true"])
    expect(html).toContain(">named<")
    expect(html).toContain(">2<")
    expect(html).toContain(">loose<")
  })

  it("no space: empty strip, no crash", () => {
    expect(tabs(stateOf([], []))).toContain('role="tablist"')
  })
})

describe("main area", () => {
  it("says what is missing: nothing at all, a space without tabs, a tab without live panes", () => {
    expect(main(stateOf([], []))).toContain("This space has no tabs yet.") // This computer is always listed, even with nothing
    expect(main(stateOf([], [layout(null, [{ id: "s1", tabs: [] }])]))).toContain("This space has no tabs yet.")
    expect(main(stateOf([], [layout(null, [{ id: "s1", tabs: [{ id: "a", panes: [term("gone")] }] }])]))).toContain("This tab has no live panes.")
  })

  it("a single pane has no pane switcher, several do, and the switcher names mod panes", () => {
    const one = stateOf([terminal("t1")], [layout(null, [{ id: "s1", tabs: [{ id: "a", panes: [term("t1")] }] }])])
    expect(main(one)).not.toContain("pane-switch")
    const many = stateOf([terminal("t1", { name: "alpha" })], [layout(null, [{ id: "s1", tabs: [{ id: "a", panes: [term("t1"), other("p2", "chat"), other("p3", null)] }] }])])
    const html = main(many)
    expect(count(html, 'data-testid="pane-switch"')).toBe(3)
    expect(html).toContain("chat pane")
    expect(html).toContain("Pane 3")
  })

  it("a mod pane has a card that says it has no terminal, and a pane without a mod name says so", () => {
    const html = main(stateOf([], [layout(null, [{ id: "s1", tabs: [{ id: "a", panes: [other("p1", "chat")] }] }])]))
    expect(html).toContain('data-kind="other"')
    expect(html).toContain("“chat”")
    const bare = main(stateOf([], [layout(null, [{ id: "s1", tabs: [{ id: "a", panes: [other("p1", null)] }] }])]))
    expect(bare).toContain("not a terminal")
  })

  it("a terminal card shows its facts, escaped, with `—` for empty values, and `no status reported` without status", () => {
    const html = main(stateOf([terminal("t1", { title: "<u>x</u>", cwd: "", argv: [] })], [layout(null, [{ id: "s1", tabs: [{ id: "a", panes: [term("t1")] }] }])]))
    expect(html).not.toContain("<u>")
    expect(html).toContain("no status reported")
    expect(html).toContain('data-testid="fact-folder">—<')
    expect(html).toContain('data-testid="fact-program">—<')
  })

  it("an agent card shows state, detail and message", () => {
    const t = agent("t1", "blocked", { status: { state: "blocked", kind: "permission", msg: "run rm -rf?", app: "pi" }, status_ms: 1_000_000 - 120_000 })
    const html = main(stateOf([t], [layout(null, [{ id: "s1", tabs: [{ id: "a", panes: [term("t1")] }] }])]))
    expect(html).toContain("Needs you")
    expect(html).toContain("run rm -rf?")
    expect(html).toContain("2m")
  })

  it("an empty-layout machine and a never-written layout still list terminals", () => {
    const html = sidebar(stateOf([terminal("t1")], [empty(null)]))
    expect(html).toContain("No layout yet; showing its terminals.")
    expect(html).toContain("1 live")
  })
})

describe("remembered selection", () => {
  const shell = buildShell(stateOf([terminal("t1")], [layout(null, [{ id: "s1", tabs: [{ id: "a", panes: [term("t1")] }] }])]))

  it("falls back to the first space, tab and pane for anything that no longer exists", () => {
    const r = resolveSelection(shell, { space: "|gone", tab: "gone", pane: "gone" })
    expect([r.space?.id, r.tab?.id, r.pane?.id]).toEqual(["s1", "a", "p-t1"])
  })

  it("odd values that localStorage may hold (numbers, arrays, wrong shapes) never throw", () => {
    for (const value of [5, "x", [], {}, { space: 5, tab: {}, pane: [] }, true]) {
      expect(() => resolveSelection(shell, value as unknown as Selection), JSON.stringify(value)).not.toThrow()
    }
  })

  describe("defects", () => {
    it("a stored `null` (valid JSON) should fall back instead of crashing the whole page", () => {
      // useStored does JSON.parse(raw) and hands whatever it gets to resolveSelection.
      expect(() => resolveSelection(shell, null as unknown as Selection)).not.toThrow()
    })
  })
})

describe("defects", () => {
  it("a space whose name starts with an emoji should get the whole emoji as its badge, not half of it", () => {
    const html = sidebar(stateOf([], [layout(null, [{ id: "s1", name: "🚀 launch", tabs: [] }])]))
    const badge = [...html.matchAll(/text-white[^>]*>([^<]*)</g)].map((m) => m[1])[0]
    expect(badge).toBe("🚀")
  })

  it("a space name that starts with an accented or non-Latin letter keeps it whole", () => {
    const html = sidebar(stateOf([], [layout(null, [{ id: "s1", name: "école", tabs: [] }, { id: "s2", name: "日本", tabs: [] }])]))
    const badges = [...html.matchAll(/text-white[^>]*>([^<]*)</g)].map((m) => m[1])
    expect(badges).toEqual(["É", "日"])
  })
})
