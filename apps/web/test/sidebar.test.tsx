// @vitest-environment jsdom
import type { AppShared } from "@herdr-web/protocol"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Sidebar } from "@/components/shell/sidebar"
import { agentGroups, buildShell, resolveSelection, type Selection } from "@/lib/model"
import { ANSI_HUES } from "@/lib/space-colors"
import { initialState, type LiveState } from "@/lib/store"
import { agent, connected, layout, machine, term } from "./fixtures"

const noop = () => {}
const NONE: Selection = { space: null, tab: null, pane: null }
const shared = (over: Partial<AppShared> = {}): AppShared => ({ "agents.groups": [], "agents.groupLabel": {}, "agents.agentGroup": {}, "agents.agentLabel": {}, "agents.spaceGroup": {}, "space.colors": {}, ...over })

function render(state: Partial<LiveState>, selection: Selection = NONE, appShared: AppShared | null = null): string {
  const s: LiveState = { ...initialState, ready: true, link: "open", connection: connected, appShared, ...state }
  const shell = buildShell(s)
  return renderToStaticMarkup(
    createElement(Sidebar, { shell, groups: agentGroups(s, shell), resolved: resolveSelection(shell, selection), now: 1_000_000, stale: false, onSelect: noop, onCollapse: noop, onSignOut: noop, disabled: false, rowErrors: {}, onPin: noop, onUnread: noop, onKill: noop, shared: appShared }),
  )
}
const doc = (html: string) => new DOMParser().parseFromString(html, "text/html")
const byId = (d: Document, id: string) => [...d.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)]

const terminals = [agent("t1", "working", { name: "pi-one", created_ms: 1 }), { ...agent("t2", "idle", { name: "claude-one", created_ms: 2 }), status: { state: "idle", app: "claude" } }]
const withSpaces = {
  terminals: Object.fromEntries(terminals.map((t) => [t.address, t])),
  layouts: {
    "": layout(null, [
      { id: "s1", name: "home", folder: "/Users/dev", tabs: [{ id: "a", panes: [term("t1")] }] },
      { id: "s2", name: "deep", folder: "/Users/dev/Desktop/devendras-work/herdr-web", tabs: [{ id: "b", panes: [term("t2")] }] },
      { id: "s3", name: "nopath", folder: "", tabs: [] },
    ]),
  },
}

// @vitest-environment jsdom
describe("sidebar: Spaces", () => {
  it("every space row has the same height class whether or not it has a path, and the tile is 20px with a 6px radius", () => {
    const rows = byId(doc(render(withSpaces)), "space-row")
    expect(rows).toHaveLength(3)
    for (const r of rows) expect(r.className).toMatch(/(^| )h-10( |$)/)
    const tile = byId(doc(render(withSpaces)), "space-tile")[0]!
    expect(tile.className).toContain("size-5")
    expect(tile.className).toContain("rounded-[6px]")
  })

  it("shows ~ paths, the full path in the title, and nothing for a space with no path", () => {
    const rows = byId(doc(render(withSpaces)), "space-row")
    expect(rows.map((r) => r.querySelector('[data-testid="space-path"]')?.textContent ?? null)).toEqual(["~", "~/…/devendras-work/herdr-web", null])
    expect(rows.map((r) => r.getAttribute("title"))).toEqual(["/Users/dev", "/Users/dev/Desktop/devendras-work/herdr-web", null])
  })

  it("the tile takes its colour from herdr-app's space.colors by the space's id, and from its name without one", () => {
    const hueOf = (html: string, n: number) => /oklch\(0\.62 0\.12 (\d+)\)/.exec(byId(doc(html), "space-tile")[n]!.getAttribute("style")!)![1]
    const coloured = render(withSpaces, NONE, shared({ "space.colors": { s1: "ansi6", s2: "ansi1" } }))
    expect(hueOf(coloured, 0)).toBe(String(ANSI_HUES["ansi6"]))
    expect(hueOf(coloured, 1)).toBe(String(ANSI_HUES["ansi1"]))
    const plain = render(withSpaces)
    expect(hueOf(plain, 2)).toBe(hueOf(coloured, 2)) // no entry: today's hash colour
  })

  it("an added machine's spaces are looked up as machine/space", () => {
    const state = { layouts: { box: layout("box", [{ id: "sp9", name: "boxy", folder: "/home/zosma/p", tabs: [] }]) }, machines: [machine("box")] }
    const html = render(state, NONE, shared({ "space.colors": { "box/sp9": "ansi5", sp9: "ansi2" } }))
    const box = byId(doc(html), "machine").find((e) => e.dataset["machine"] === "box")!
    expect(/oklch\(0\.62 0\.12 (\d+)\)/.exec(box.innerHTML)![1]).toBe(String(ANSI_HUES["ansi5"]))
  })

  it("the selected row is marked, and light has one clear step for it", () => {
    const rows = byId(doc(render(withSpaces, { space: "|s2", tab: null, pane: null })), "space-row")
    expect(rows.map((r) => r.dataset["selected"])).toEqual(["false", "true", "false"])
    expect(rows[1]!.className).toContain("bg-black/[0.06]")
    expect(rows[0]!.className).not.toContain("bg-black/[0.06]")
  })
})

describe("sidebar: machines", () => {
  const down = { machines: [machine("cachyos", "unreachable", "ssh: connect to host cachyos port 22: Connection timed out after 30 seconds")] }

  it("an unreachable machine is one line: the name, then an amber dot and Unreachable on the right, with the reason in the title", () => {
    const d = doc(render({ ...withSpaces, ...down }))
    const m = byId(d, "machine").find((e) => e.dataset["machine"] === "cachyos")!
    const header = m.firstElementChild as HTMLElement
    expect(header.textContent).toBe("cachyosUnreachable")
    expect(header.getAttribute("title")).toContain("Connection timed out")
    const status = byId(d, "machine-down")[0]!
    expect(header.contains(status)).toBe(true)
    expect(status.className).toContain("ml-auto")
    expect(status.querySelector(".bg-amber-500")?.className).toContain("size-1.5")
    expect(m.textContent).not.toContain("ssh: connect") // the reason is not inline
    expect(m.querySelectorAll('[data-testid="space-row"]')).toHaveLength(0)
  })

  it("no reason: the title is the state; a machine that is up has no status", () => {
    const d = doc(render({ machines: [machine("a", "needs_login", null), machine("b")], layouts: { b: layout("b", []) } }))
    const a = byId(d, "machine").find((e) => e.dataset["machine"] === "a")!
    expect(a.firstElementChild!.getAttribute("title")).toBe("Needs login")
    const b = byId(d, "machine").find((e) => e.dataset["machine"] === "b")!
    expect(b.querySelector('[data-testid="machine-down"]')).toBeNull()
  })
})

describe("sidebar: Agents", () => {
  it("is a block under Spaces, kept to half the height, with a hairline above it; Spaces takes the rest", () => {
    const d = doc(render(withSpaces))
    const spaces = byId(d, "spaces-block")[0]!
    const agents = byId(d, "agents-block")[0]!
    expect(spaces.compareDocumentPosition(agents) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(agents.className).toContain("max-h-1/2")
    expect(agents.className).toContain("shrink-0") // sizes to its content
    expect(agents.className).toContain("overflow-y-auto") // and scrolls inside past half
    expect(agents.className).toContain("border-t")
    expect(spaces.className).toContain("flex-1")
    expect(spaces.className).toContain("overflow-y-auto")
    expect(spaces.className).not.toContain("max-h")
  })

  it("with no agents: one muted line, no Agents heading", () => {
    const d = doc(render({ layouts: withSpaces.layouts }))
    const agents = byId(d, "agents-block")[0]!
    expect(agents.textContent).toBe("No agents running")
    expect(agents.querySelector("h2")).toBeNull()
    expect(byId(d, "agent-row")).toHaveLength(0)
  })

  it("a pi agent has pi's mark; any other agent has the bot icon", () => {
    const icons = byId(doc(render(withSpaces)), "agent-icon")
    expect(icons.map((i) => i.dataset["icon"])).toEqual(["pi", "bot"])
    expect(icons[0]!.tagName.toLowerCase()).toBe("svg")
    expect(icons[0]!.getAttribute("fill")).toBe("currentColor")
    expect(icons[0]!.getAttribute("class")).toContain("size-4")
  })

  it("rows are 32px, with the age in a fixed-width right-aligned column and the menu hidden until hover, focus or selection", () => {
    const d = doc(render(withSpaces, { space: "|s1", tab: "a", pane: "p-t1" }))
    for (const r of byId(d, "agent-row")) expect(r.className).toMatch(/(^| )h-8( |$)/)
    const age = byId(d, "agent-row")[0]!.querySelector(".tabular-nums")!
    expect(age.className).toContain("w-8")
    expect(age.className).toContain("text-right")
    const menu = byId(d, "agent-menu")[0]!
    expect(menu.className).toContain("opacity-0")
    expect(menu.className).toContain("group-hover/row:opacity-100")
    expect(menu.className).toContain("group-focus-within/row:opacity-100")
    expect(menu.className).toContain("group-data-[row-selected=true]/row:opacity-100")
    expect(menu.className).toContain("aria-expanded:opacity-100")
  })

  it("group headers are weight 500 at 70% of the sidebar's text; the section headers are muted and plain", () => {
    const d = doc(render(withSpaces, NONE))
    const group = byId(d, "agent-group")[0]!.firstElementChild!
    expect(group.className).toContain("font-medium")
    expect(group.className).toContain("text-sidebar-foreground/70")
    const section = byId(d, "agents-block")[0]!.querySelector("h2")!
    expect(section.className).toContain("text-muted-foreground")
    expect(section.className).not.toContain("font-medium")
  })

  it("the space is named after the agent's name when the group is not that space; not when it is", () => {
    const bySpace = byId(doc(render(withSpaces)), "agent-space")
    expect(bySpace).toHaveLength(0) // grouped by space: the header says it
    const html = render(withSpaces, NONE, shared({ "agents.groups": [{ id: "g", name: "mine" }], "agents.agentGroup": { t1: "g", t2: "g" } }))
    expect(byId(doc(html), "agent-space").map((e) => e.textContent)).toEqual(["· home", "· deep"])
  })

  it("herdr-app's name is on the row and in the menu's label", () => {
    const html = render(withSpaces, NONE, shared({ "agents.agentLabel": { t1: "ui-lead" } }))
    const d = doc(html)
    expect(byId(d, "agent-name").map((e) => e.textContent)).toEqual(["ui-lead", "claude-one"])
    expect(html).toContain('aria-label="Menu for ui-lead"')
  })
})
