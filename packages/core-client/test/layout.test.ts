import { describe, expect, it } from "vitest";
import { parseLayout, unavailableLayout } from "../src/layout.js";
import { realShaped } from "./layout-fixture.js";

describe("parseLayout", () => {
  it("flattens a real-shaped document into spaces, tabs and ordered panes", () => {
    const layout = parseLayout(null, realShaped, 156);
    expect(layout).toMatchObject({ machine: null, status: "ok", reason: null, version: 156 });
    expect(layout.spaces.map((s) => [s.name, s.folder, s.tabs.length])).toEqual([
      ["zosmaai", "/Users/x/work/zosmaai", 2],
      ["devendra", "/Users/x", 1],
    ]);
    expect(layout.spaces[0]!.tabs[0]).toEqual({
      id: "tb00000000000000000000000000000001",
      name: "ayra",
      panes: [{ id: "p1", kind: "terminal", terminal: "t9" }],
    });
    // depth first, in tree order; a mod pane has no terminal; split geometry is gone
    expect(layout.spaces[0]!.tabs[1]!.panes).toEqual([
      { id: "p2", kind: "terminal", terminal: "t10" },
      { id: "p3", kind: "terminal", terminal: "t12" },
      { id: "p4", kind: "other", mod: "chat" },
    ]);
    expect(layout.spaces[0]!.tabs[1]!.name).toBe("");
    expect(layout.spaces[1]!.tabs[0]!.panes).toEqual([]);
    expect(JSON.stringify(layout)).not.toContain("weight");
    expect(JSON.stringify(layout)).not.toContain("color");
  });

  it("qualifies a remote machine's addresses with its name, and nothing else", () => {
    const layout = parseLayout("cachyos", realShaped, 3);
    const panes = layout.spaces[0]!.tabs[1]!.panes;
    expect(panes.map((p) => (p.kind === "terminal" ? p.terminal : p.mod))).toEqual(["cachyos/t10", "cachyos/t12", "chat"]);
    expect(layout.machine).toBe("cachyos");
    expect(layout.spaces[0]!.id).toBe("spa1b2c3d4e5f60718293a4b5c6d7e8f9");
  });

  it("an unwritten document (value null) is empty, with a reason", () => {
    expect(parseLayout(null, null, 0)).toEqual({
      machine: null,
      status: "empty",
      reason: "no layout document written yet",
      version: 0,
      spaces: [],
    });
  });

  it("an unknown node type makes the layout unavailable, naming the type, and does not throw", () => {
    const doc = { spaces: [{ id: "s", name: "n", folder: "/", tabs: [{ id: "t", name: "", root: { id: "t", type: "row", children: [{ id: "x", type: "carousel", children: [] }] } }] }] };
    const layout = parseLayout("box", doc, 4);
    expect(layout).toMatchObject({ machine: "box", status: "unavailable", spaces: [], version: 4 });
    expect(layout.reason).toContain("carousel");
  });

  it("a block with content of an unknown kind is unavailable", () => {
    const doc = { spaces: [{ id: "s", tabs: [{ id: "t", root: { id: "t", type: "block", content: { widget: 1 } } }] }] };
    expect(parseLayout(null, doc, 1)).toMatchObject({ status: "unavailable" });
  });

  it.each([
    ["a string", "hello"],
    ["a number", 7],
    ["a list", []],
    ["spaces not a list", { spaces: "x" }],
    ["a space that is not an object", { spaces: [1] }],
    ["tabs not a list", { spaces: [{ tabs: {} }] }],
    ["a tab that is not an object", { spaces: [{ tabs: [null] }] }],
    ["a root that is not an object", { spaces: [{ tabs: [{ root: 5 }] }] }],
    ["children not a list", { spaces: [{ tabs: [{ root: { type: "row", children: "x" } }] }] }],
    ["a block without content", { spaces: [{ tabs: [{ root: { type: "block" } }] }] }],
    ["a node without a type", { spaces: [{ tabs: [{ root: { id: "a" } }] }] }],
    ["undefined (a malformed reply)", undefined],
  ])("an unreadable document (%s) is unavailable with a reason, never a throw", (_name, value) => {
    const layout = parseLayout(null, value, 1);
    expect(layout.status).toBe("unavailable");
    expect(layout.reason).toMatch(/\S/);
    expect(layout.spaces).toEqual([]);
  });

  it("fills in what the desktop app defaults: a bare space or tab is empty, not an error", () => {
    expect(parseLayout(null, { spaces: [{}] }, 1).spaces).toEqual([{ id: "", name: "", folder: "", tabs: [] }]);
    expect(parseLayout(null, { spaces: [{ tabs: [{}] }] }, 1).spaces[0]!.tabs).toEqual([{ id: "", name: "", panes: [] }]);
    expect(parseLayout(null, {}, 1)).toMatchObject({ status: "ok", spaces: [] });
  });

  it("counts tab and agent content, and every child of a stack, as panes without a terminal", () => {
    const doc = {
      spaces: [{ tabs: [{ root: { id: "r", type: "stack", children: [{ id: "a", type: "block", content: { tab: "active" } }, { id: "b", type: "block", content: { agent: "focused" } }] } }] }],
    };
    expect(parseLayout(null, doc, 1).spaces[0]!.tabs[0]!.panes).toEqual([
      { id: "a", kind: "other", mod: null },
      { id: "b", kind: "other", mod: null },
    ]);
  });

  it("unavailableLayout carries the reason and no spaces", () => {
    expect(unavailableLayout("box", "machine unreachable")).toEqual({
      machine: "box",
      status: "unavailable",
      reason: "machine unreachable",
      version: null,
      spaces: [],
    });
  });
});
