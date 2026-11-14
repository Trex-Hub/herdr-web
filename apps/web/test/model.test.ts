import { describe, expect, it } from "vitest"
import { agentGroups, buildShell, locateTerminal, machineOf, resolveSelection, THIS_COMPUTER } from "@/lib/model"
import type { LiveState } from "@/lib/store"
import { agent, empty, layout, machine, other, term, terminal, unavailable } from "./fixtures"

type S = Pick<LiveState, "terminals" | "machines" | "layouts">
function state(terminals: ReturnType<typeof terminal>[], layouts: S["layouts"], machines: S["machines"] = []): S {
  return { terminals: Object.fromEntries(terminals.map((t) => [t.address, t])), machines, layouts }
}
const local = (s: S) => buildShell(s).machines[0]!

describe("machineOf", () => {
  it("local addresses have no machine, remote ones carry its name", () => {
    expect(machineOf("t7")).toBeNull()
    expect(machineOf("cachyos/t7")).toBe("cachyos")
  })
})

describe("shell: machines and spaces", () => {
  it("lists This computer first, then machines by name, whatever order they arrive in", () => {
    const shell = buildShell(state([], { "": layout(null, []), zed: layout("zed", []), alpha: layout("alpha", []) }, [machine("zed"), machine("alpha")]))
    expect(shell.machines.map((m) => [m.name, m.title])).toEqual([[null, THIS_COMPUTER], ["alpha", "alpha"], ["zed", "zed"]])
  })

  it("keeps the layout's order for spaces and tabs, numbers unnamed tabs by position", () => {
    const m = local(
      state([terminal("t1"), terminal("t2"), terminal("t3")], {
        "": layout(null, [
          { id: "s1", name: "first", tabs: [{ id: "a", name: "named", panes: [term("t1")] }, { id: "b", panes: [term("t2")] }] },
          { id: "s2", name: "second", tabs: [{ id: "c", panes: [term("t3")] }] },
        ]),
      }),
    )
    expect(m.spaces.map((s) => s.name)).toEqual(["first", "second"])
    expect(m.spaces[0]!.tabs.map((t) => t.label)).toEqual(["named", "2"])
    expect(m.spaces[1]!.tabs.map((t) => t.label)).toEqual(["1"])
    expect(m.flat).toBeNull()
    expect(m.notice).toBeNull()
  })

  it("a machine that is not connected says so, with the reason, and lists nothing", () => {
    const m = buildShell(state([], { "": layout(null, []), box: unavailable("box", "machine unreachable: ssh timed out") }, [machine("box", "unreachable", "ssh timed out")])).machines[1]!
    expect(m.down).toEqual({ state: "unreachable", why: "ssh timed out" })
    expect(m.flat).toBeNull()
    expect(m.notice).toBeNull()
    expect(m.spaces).toEqual([])
  })

  it("a machine in the machine list with no layout yet is waiting, not missing", () => {
    const m = buildShell(state([terminal("box/t1")], { "": layout(null, []) }, [machine("box")])).machines[1]!
    expect(m.notice).toBe("Waiting for the layout.")
    expect(m.flat?.tabs.map((t) => t.panes[0]!.terminal!.address)).toEqual(["box/t1"])
  })
})

describe("shell: layout versus terminals", () => {
  it("a pane whose terminal is not live is hidden: finished, or not known at all", () => {
    const m = local(
      state([terminal("t1"), terminal("t2", { state: "finished" })], {
        "": layout(null, [{ id: "s", tabs: [{ id: "tb", name: "x", panes: [term("t1"), term("t2"), term("t404")] }] }]),
      }),
    )
    expect(m.spaces[0]!.tabs[0]!.panes.map((p) => p.terminal?.address)).toEqual(["t1"])
  })

  it("a tab whose terminals are all gone stays, with no panes", () => {
    const m = local(state([], { "": layout(null, [{ id: "s", tabs: [{ id: "tb", name: "x", panes: [term("t1")] }] }]) }))
    expect(m.spaces[0]!.tabs[0]!.panes).toEqual([])
  })

  it("a pane that holds no terminal is shown, as a pane without one", () => {
    const m = local(state([terminal("t1")], { "": layout(null, [{ id: "s", tabs: [{ id: "tb", panes: [term("t1"), other("m1", "chat")] }] }]) }))
    expect(m.spaces[0]!.tabs[0]!.panes.map((p) => [p.kind, p.terminal?.address ?? null, p.mod])).toEqual([["terminal", "t1", null], ["other", null, "chat"]])
  })

  it("a live terminal labelled for a space but in no pane becomes an extra tab of that space", () => {
    const m = local(
      state(
        [terminal("t1"), terminal("t2", { labels: { "herdr.space": "s1", "herdr.tab": "tb-new" }, name: "build", created_ms: 5 }), terminal("t3", { labels: { "herdr.space": "s1" }, created_ms: 4, title: "logs" })],
        { "": layout(null, [{ id: "s1", tabs: [{ id: "tb1", name: "one", panes: [term("t1")] }] }, { id: "s2", tabs: [{ id: "tb2", panes: [] }] }]) },
      ),
    )
    const tabs = m.spaces[0]!.tabs
    expect(tabs.map((t) => [t.label, t.extra])).toEqual([["one", false], ["logs", true], ["build", true]]) // by creation time
    expect(tabs[1]!.panes[0]!.terminal!.address).toBe("t3")
    expect(m.spaces[1]!.tabs).toHaveLength(1) // not shown in the other space
  })

  it("a labelled terminal that is in a pane is not also an extra tab", () => {
    const m = local(state([terminal("t1", { labels: { "herdr.space": "s1" } })], { "": layout(null, [{ id: "s1", tabs: [{ id: "tb", panes: [term("t1")] }] }]) }))
    expect(m.spaces[0]!.tabs).toHaveLength(1)
  })

  it("a terminal in a pane of another space is not an extra tab even if its label says otherwise", () => {
    const m = local(
      state([terminal("t1", { labels: { "herdr.space": "s1" } })], { "": layout(null, [{ id: "s1", tabs: [] }, { id: "s2", tabs: [{ id: "tb", panes: [term("t1")] }] }]) }),
    )
    expect(m.spaces[0]!.tabs).toEqual([])
    expect(m.spaces[1]!.tabs[0]!.panes).toHaveLength(1)
  })

  it("a finished terminal labelled for a space is not an extra tab", () => {
    const m = local(state([terminal("t1", { state: "finished", labels: { "herdr.space": "s1" } })], { "": layout(null, [{ id: "s1", tabs: [] }]) }))
    expect(m.spaces[0]!.tabs).toEqual([])
  })

  it("labels on a remote machine match that machine's space ids, and only that machine's", () => {
    const shell = buildShell(
      state(
        [terminal("box/t9", { labels: { "herdr.space": "s1" } }), terminal("t8", { labels: { "herdr.space": "s1" } })],
        { "": layout(null, [{ id: "s1", tabs: [] }]), box: layout("box", [{ id: "s1", tabs: [] }]) },
        [machine("box")],
      ),
    )
    expect(shell.machines[0]!.spaces[0]!.tabs.map((t) => t.panes[0]!.terminal!.address)).toEqual(["t8"])
    expect(shell.machines[1]!.spaces[0]!.tabs.map((t) => t.panes[0]!.terminal!.address)).toEqual(["box/t9"])
  })

  it.each([
    ["unavailable", unavailable(null, "unknown node type \"x\""), /^Layout unavailable: unknown node type/],
    ["empty", empty(null), /^No layout yet/],
  ])("a %s layout lists the machine's live terminals flat, one tab each, with a notice", (_name, lay, notice) => {
    const m = local(state([terminal("t1", { created_ms: 2 }), terminal("t2", { created_ms: 1, name: "web" }), terminal("t3", { state: "finished" }), terminal("box/t4")], { "": lay }))
    expect(m.spaces).toEqual([])
    expect(m.notice).toMatch(notice)
    expect(m.flat!.tabs.map((t) => [t.label, t.panes[0]!.terminal!.address])).toEqual([["web", "t2"], ["t1", "t1"]]) // only this machine's, only live
  })
})

describe("shell: tabs", () => {
  it("a tab holding an agent says so (for the icon)", () => {
    const m = local(state([terminal("t1"), agent("t2", "working")], { "": layout(null, [{ id: "s", tabs: [{ id: "a", panes: [term("t1")] }, { id: "b", panes: [term("t2")] }] }]) }))
    expect(m.spaces[0]!.tabs.map((t) => t.hasAgent)).toEqual([false, true])
  })
})

describe("locateTerminal and selection", () => {
  const s = state(
    [terminal("t1"), terminal("t2"), terminal("t3", { labels: { "herdr.space": "s2" } })],
    { "": layout(null, [{ id: "s1", name: "one", tabs: [{ id: "a", panes: [term("t1", "pA"), term("t2", "pB")] }] }, { id: "s2", name: "two", tabs: [] }]) },
  )
  const shell = buildShell(s)

  it("finds a terminal's space, tab and pane, including extra tabs", () => {
    const at = locateTerminal(shell, "t2")!
    expect([at.space.name, at.tab.id, at.pane.id]).toEqual(["one", "a", "pB"])
    expect(locateTerminal(shell, "t3")!.tab.extra).toBe(true)
    expect(locateTerminal(shell, "t404")).toBeNull()
  })

  it("resolves a stored selection that still exists", () => {
    const r = resolveSelection(shell, { space: "|s1", tab: "a", pane: "pB" })
    expect([r.space!.id, r.tab!.id, r.pane!.id]).toEqual(["s1", "a", "pB"])
  })

  it("falls back level by level when what was stored is gone", () => {
    expect(resolveSelection(shell, { space: "|s1", tab: "gone", pane: "gone" })).toMatchObject({ space: { id: "s1" }, tab: { id: "a" }, pane: { id: "pA" } })
    expect(resolveSelection(shell, { space: "|s1", tab: "a", pane: "gone" }).pane!.id).toBe("pA")
    expect(resolveSelection(shell, { space: "|gone", tab: "a", pane: "pB" }).space!.id).toBe("s1")
    expect(resolveSelection(shell, { space: null, tab: null, pane: null }).space!.id).toBe("s1")
  })

  it("prefers the first space that has tabs, and is empty when there is nothing", () => {
    const sh = buildShell(state([terminal("t1")], { "": layout(null, [{ id: "empty", tabs: [] }, { id: "full", tabs: [{ id: "a", panes: [term("t1")] }] }]) }))
    expect(resolveSelection(sh, { space: null, tab: null, pane: null }).space!.id).toBe("full")
    const nothing = resolveSelection(buildShell(state([], {})), { space: "x", tab: "y", pane: "z" })
    expect([nothing.tab, nothing.pane]).toEqual([null, null]) // no layout and no terminals: an empty flat list
    expect(resolveSelection({ machines: [] }, { space: null, tab: null, pane: null })).toEqual({ space: null, tab: null, pane: null })
  })

  it("can select a flat machine's terminal", () => {
    const sh = buildShell(state([terminal("t1")], { "": unavailable(null, "x") }))
    const r = resolveSelection(sh, { space: "|flat", tab: "x:t1", pane: "x:t1" })
    expect([r.space!.id, r.pane!.terminal!.address]).toEqual(["flat", "t1"])
  })
})

describe("agentGroups", () => {
  const terminals = [
    agent("t1", "idle", { name: "pi-evals", created_ms: 1 }),
    agent("t2", "working", { name: "second", created_ms: 2 }),
    agent("t3", "idle", { name: "pinned", created_ms: 3, labels: { "herdr.pinned": "1" } }),
    agent("t4", "idle", { name: "other-space", created_ms: 4 }),
    agent("t5", "idle", { name: "loose", created_ms: 5 }),
    agent("box/t6", "idle", { name: "remote-loose", created_ms: 6 }),
    terminal("t7"), // a shell: not an agent
    agent("t8", "idle", { state: "finished" }),
  ]
  const s = state(terminals, {
    "": layout(null, [
      { id: "s1", name: "zosmaai", tabs: [{ id: "a", panes: [term("t1"), term("t2"), term("t3")] }] },
      { id: "s2", name: "devendra", tabs: [{ id: "b", panes: [term("t4")] }] },
    ]),
  })
  const shell = buildShell(s)

  it("groups by space in the order spaces are listed, pinned first, shells and finished left out", () => {
    const groups = agentGroups(s, shell)
    expect(groups.map((g) => [g.title, g.agents.map((a) => a.terminal.name)])).toEqual([
      ["zosmaai", ["pinned", "pi-evals", "second"]],
      ["devendra", ["other-space"]],
      ["Not in a space (This computer)", ["loose"]],
      ["Not in a space (box)", ["remote-loose"]],
    ])
  })

  it("each agent knows where to select it", () => {
    const g = agentGroups(s, shell)
    expect(g[0]!.agents[1]!.located).toMatchObject({ space: { id: "s1" }, tab: { id: "a" }, pane: { id: "p-t1" } })
    expect(g[2]!.agents[0]!.located).toBeNull()
  })

  it("an agent in an extra tab or a flat machine is grouped with that space", () => {
    const s2 = state([agent("t1", "idle", { labels: { "herdr.space": "s1" } }), agent("box/t2", "idle")], { "": layout(null, [{ id: "s1", name: "work", tabs: [] }]), box: unavailable("box", "x") }, [machine("box")])
    expect(agentGroups(s2, buildShell(s2)).map((g) => g.title)).toEqual(["work", "box"])
  })
})
