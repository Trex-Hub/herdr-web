// DEV-33, tester's tests: edges of the path rule, tile contrast for every hash hue, grouping with an empty or stale file.
import { describe, expect, it } from "vitest"
import type { AppShared } from "@herdr-web/protocol"
import { agentGroups, buildShell } from "@/lib/model"
import { displayFolder } from "@/lib/paths"
import { ANSI_HUES, tileFor } from "@/lib/space-colors"
import type { LiveState } from "@/lib/store"
import { agent, layout, term } from "./fixtures"

describe("displayFolder edges", () => {
  it.each([
    ["/Users", "/Users"], // no name: not a home folder
    ["/Usersx/dev/a/b/c", "/…/b/c"],
    ["/home", "/home"],
    ["/rootless/a/b/c", "/…/b/c"], // /root is a folder, not a prefix of a name
    ["/Users/dev//Desktop///x", "~/Desktop/x"], // doubled slashes
    ["/Users/dev/a b/c d/e f", "~/…/c d/e f"], // spaces in names
    ["/Users/dev/projets/café/événement", "~/…/café/événement"],
    ["/Users/dev/Desktop/~/x", "~/…/~/x"], // a ~ inside is just a name
    ["/home/zosma/very-long-folder-name-that-goes-on-and-on-and-on-and-on-and-on-forever/x", "~/very-long-folder-name-that-goes-on-and-on-and-on-and-on-and-on-forever/x"], // never cuts a name
    ["C:\\Users\\dev\\x\\y\\z", "C:\\Users\\dev\\x\\y\\z"],
    ["", ""],
    ["relative/a/b/c", "relative/a/b/c"],
  ])("%s", (folder, shown) => expect(displayFolder(folder)).toBe(shown))

  it("is the same when called on its own output (so showing it twice never makes it longer)", () => {
    for (const p of ["/Users/dev/a/b/c/d", "/srv/a/b/c", "/root/x", "/home/z"]) expect(displayFolder(displayFolder(p))).toBe(displayFolder(p))
  })
})

describe("tile contrast", () => {
  it("the text on a tile reads at 4.5:1 for every ansi colour and for the hash colours of 5000 names", () => {
    for (const c of Object.keys(ANSI_HUES)) expect(tileFor("x", c).ratio, c).toBeGreaterThanOrEqual(4.5)
    const hues = new Set<string>()
    const ratios = Array.from({ length: 5000 }, (_, i) => `space-${i.toString(36)}`).map((n) => {
      const t = tileFor(n)
      hues.add(t.background)
      return t.ratio
    })
    expect(hues.size).toBeGreaterThan(300) // the names do cover the hue circle
    expect(Math.min(...ratios)).toBeGreaterThanOrEqual(4.5)
  })
})

describe("grouping when the file says little or is stale", () => {
  const empty: AppShared = { "agents.groups": [], "agents.groupLabel": {}, "agents.agentGroup": {}, "agents.agentLabel": {}, "agents.spaceGroup": {}, "space.colors": {} }
  const terminals = [agent("t1", "idle", { name: "one", created_ms: 1 }), agent("t2", "idle", { name: "two", created_ms: 2 }), agent("t3", "idle", { name: "loose", created_ms: 3 })]
  const base = {
    terminals: Object.fromEntries(terminals.map((t) => [t.address, t])),
    machines: [],
    layouts: { "": layout(null, [{ id: "s1", name: "work", tabs: [{ id: "a", panes: [term("t1")] }] }, { id: "s2", name: "play", tabs: [{ id: "b", panes: [term("t2")] }] }]) },
  } as Pick<LiveState, "terminals" | "machines" | "layouts">
  const shell = buildShell(base)
  const shape = (sh: AppShared | null | undefined) => agentGroups({ ...base, appShared: sh ?? null }, shell).map((g) => [g.title, g.agents.map((a) => a.terminal.name)])

  it("a file that exists but has no groups, labels or assignments groups exactly as no file does", () => {
    expect(shape(empty)).toEqual(shape(null))
  })

  it("a name or an assignment for an agent that is not running changes nothing", () => {
    expect(shape({ ...empty, "agents.agentGroup": { t99: "ga", "m/t1": "ga" }, "agents.agentLabel": { t99: "ghost" }, "agents.groups": [{ id: "ga", name: "A" }] })).toEqual(shape(null))
  })

  it("an agent whose own group is gone still goes to its space's group", () => {
    const sh: AppShared = { ...empty, "agents.groups": [{ id: "gb", name: "B" }], "agents.agentGroup": { t1: "gone" }, "agents.spaceGroup": { s1: "gb" } }
    expect(shape(sh)[0]).toEqual(["B", ["one"]])
  })

  it("a group listed in one order and labelled in another keeps the listed order", () => {
    const sh: AppShared = { ...empty, "agents.groups": [{ id: "b", name: "B" }, { id: "a", name: "A" }], "agents.agentGroup": { t1: "a", t2: "b" }, "agents.groupLabel": { "gr-a": "Zed", "gr-b": "Alpha" } }
    expect(shape(sh).slice(0, 2).map(([t]) => t)).toEqual(["Alpha", "Zed"])
  })

  it("a pinned agent is first inside its custom group, whatever its age", () => {
    const pinned = agent("t2", "idle", { name: "two", created_ms: 2, labels: { "herdr.pinned": "1" } })
    const b = { ...base, terminals: { ...base.terminals, t2: pinned } }
    const sh: AppShared = { ...empty, "agents.groups": [{ id: "g", name: "G" }], "agents.agentGroup": { t1: "g", t2: "g", t3: "g" } }
    expect(agentGroups({ ...b, appShared: sh }, buildShell(b))[0]!.agents.map((a) => a.terminal.name)).toEqual(["two", "one", "loose"])
  })
})
