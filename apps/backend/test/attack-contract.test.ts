// Tester's cases for DEV-22: the layout parser against hostile and odd documents, and PROTOCOL.md against the code.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseLayout } from "@herdr-web/core-client";
import { ClientMessageSchema, LayoutSchema, MachineSchema, ServerMessageSchema, StatusSchema, TerminalSchema, ForegroundSchema, parseServerMessage } from "@herdr-web/protocol";
import { describe, expect, it } from "vitest";
import { realShaped } from "../../../packages/core-client/test/layout-fixture.js";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

describe("layout parser", () => {
  const junk = (r: () => number, depth = 0): unknown => {
    const x = r();
    if (depth > 4 || x < 0.35) return [null, true, false, 0, -1, 1.5, "", "t1", "row", "block", "stack", "column", "terminal", "mod", "__proto__", "constructor"][Math.floor(r() * 16)];
    if (x < 0.6) return Array.from({ length: Math.floor(r() * 4) }, () => junk(r, depth + 1));
    const keys = ["id", "name", "folder", "tabs", "spaces", "root", "type", "children", "content", "terminal", "mod", "tab", "agent", "size", "__proto__", "value"];
    const o: Record<string, unknown> = {};
    for (let i = Math.floor(r() * 5); i > 0; i--) Object.defineProperty(o, keys[Math.floor(r() * keys.length)]!, { value: junk(r, depth + 1), enumerable: true, configurable: true, writable: true });
    return o;
  };
  /** Take the real-shaped document and break it in one or two places. */
  const mutate = (r: () => number): unknown => {
    const copy = JSON.parse(JSON.stringify(realShaped)) as unknown;
    const paths: Array<Array<string | number>> = [];
    const walk = (v: unknown, p: Array<string | number>) => {
      paths.push(p);
      if (Array.isArray(v)) v.forEach((c, i) => walk(c, [...p, i]));
      else if (v && typeof v === "object") for (const [k, c] of Object.entries(v)) walk(c, [...p, k]);
    };
    walk(copy, []);
    for (let n = 1 + Math.floor(r() * 2); n > 0; n--) {
      const p = paths[1 + Math.floor(r() * (paths.length - 1))]!;
      let parent: any = copy;
      for (const k of p.slice(0, -1)) parent = parent?.[k];
      if (parent && typeof parent === "object") {
        if (r() < 0.3) Array.isArray(parent) ? parent.splice(p.at(-1) as number, 1) : delete parent[p.at(-1)!]; // (a JSON document has no holes)
        else parent[p.at(-1)!] = junk(r);
      }
    }
    return copy;
  };

  it("never throws, and always returns something the protocol accepts, for 4000 random and 4000 mutated documents", () => {
    const r = rng(20241114);
    const seen = new Set<string>();
    for (let i = 0; i < 8000; i++) {
      const value = i % 2 ? mutate(r) : junk(r);
      const machine = r() < 0.5 ? null : "cachyos";
      const version = [1, null, undefined, "7", NaN][Math.floor(r() * 5)] as number | null | undefined;
      const layout = parseLayout(machine, value, version);
      const parsed = LayoutSchema.safeParse(JSON.parse(JSON.stringify(layout)));
      expect(parsed.success, (parsed.success ? "" : parsed.error.message) + JSON.stringify(layout)).toBe(true);
      seen.add(layout.status);
      if (layout.status === "ok") {
        expect(layout.reason).toBeNull();
        for (const s of layout.spaces) for (const t of s.tabs) for (const p of t.panes) if (p.kind === "terminal" && machine) expect(p.terminal.startsWith(`${machine}/`)).toBe(true);
      } else {
        expect(layout.spaces).toEqual([]);
        expect(layout.reason).toMatch(/\S/);
      }
      if (layout.status === "unavailable") expect(typeof layout.reason).toBe("string");
    }
    expect([...seen].sort()).toEqual(["empty", "ok", "unavailable"].filter((x) => seen.has(x)));
    expect(seen.has("ok") && seen.has("unavailable")).toBe(true);
  });

  it("a string version is not a version", () => {
    expect(parseLayout(null, { spaces: [] }, "7" as unknown as number).version).toBeNull();
  });

  it("a layout with a NaN version still validates after JSON (NaN becomes null)", () => {
    const l = parseLayout(null, realShaped, Number.NaN);
    expect(LayoutSchema.safeParse(JSON.parse(JSON.stringify(l))).success).toBe(true);
  });

  it("a document nested fifty thousand levels deep is unavailable, not a crash", () => {
    let node: Record<string, unknown> = { id: "leaf", type: "block", content: { terminal: "t1" } };
    for (let i = 0; i < 50_000; i++) node = { id: `n${i}`, type: "row", children: [node] };
    const l = parseLayout(null, { spaces: [{ id: "s", tabs: [{ id: "t", root: node }] }] }, 1);
    expect(l.status).toBe("unavailable");
    expect(l.spaces).toEqual([]);
  });

  it("a document with a hundred thousand panes is read in under a second", () => {
    const children = Array.from({ length: 100_000 }, (_, i) => ({ id: `p${i}`, type: "block", content: { terminal: `t${i}` } }));
    const start = Date.now();
    const l = parseLayout("m", { spaces: [{ id: "s", tabs: [{ id: "t", root: { type: "row", children } }] }] }, 1);
    expect(l.status).toBe("ok");
    expect(l.spaces[0]!.tabs[0]!.panes).toHaveLength(100_000);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("`__proto__` and `constructor` keys in a document change nothing about the result or about Object", () => {
    const hostile = JSON.parse('{"spaces":[{"id":"s","__proto__":{"polluted":true},"tabs":[{"id":"t","root":{"type":"block","content":{"terminal":"t1","__proto__":{"polluted":true}}}}]}],"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
    const l = parseLayout(null, hostile, 1);
    expect(l.status).toBe("ok");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("a terminal id that looks like another machine's address is only prefixed, never reinterpreted", () => {
    const l = parseLayout("cachyos", { spaces: [{ tabs: [{ root: { type: "block", content: { terminal: "../devserver/t1" } } }] }] }, 1);
    expect(l.spaces[0]!.tabs[0]!.panes[0]).toEqual({ id: "", kind: "terminal", terminal: "cachyos/../devserver/t1" });
  });

  it("the document of the real shape: ids, names and folders are carried as written, tab and pane order kept", () => {
    const l = parseLayout(null, realShaped, 156);
    expect(l.spaces.map((s) => s.name)).toEqual(["zosmaai", "devendra"]);
    expect(l.spaces[0]!.tabs.map((t) => t.name)).toEqual(["ayra", ""]);
    expect(l.spaces[0]!.tabs[1]!.panes.map((p) => (p.kind === "terminal" ? p.terminal : p.mod))).toEqual(["t10", "t12", "chat"]);
    expect(l.version).toBe(156);
  });
});

describe("PROTOCOL.md and the code", () => {
  const md = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/protocol/PROTOCOL.md"), "utf8");
  const section = (from: string, to?: string): string => {
    const a = md.indexOf(from);
    expect(a, from).toBeGreaterThan(-1);
    const b = to ? md.indexOf(to, a + from.length) : md.length;
    return md.slice(a, b < 0 ? md.length : b);
  };
  const toBrowser = section("### Bridge → browser", "### Browser → bridge");
  const toBridge = section("### Browser → bridge", "## Terminal socket");
  const headings = (s: string) => [...s.matchAll(/^#### `([^`]+)`/gm)].map((m) => m[1]!);
  const examples = (s: string) => {
    const out = new Map<string, unknown>();
    for (const block of s.split(/^#### /m).slice(1)) {
      const name = /^`([^`]+)`/.exec(block)![1]!;
      const json = /```json\n([\s\S]*?)```/.exec(block)?.[1];
      if (json) out.set(name, JSON.parse(json));
    }
    return out;
  };
  const typesOf = (schema: { options: Array<{ shape: { type: { value: string } } }> }) => schema.options.map((o) => o.shape.type.value);
  const shapeKeys = (schema: { shape: Record<string, unknown> }) => Object.keys(schema.shape).sort();

  it("documents exactly the messages the bridge can send, and exactly the ones it accepts", () => {
    expect(headings(toBrowser).sort()).toEqual(typesOf(ServerMessageSchema as never).sort());
    expect(headings(toBridge).sort()).toEqual(typesOf(ClientMessageSchema as never).sort());
  });

  it("every message example has exactly the fields the schema has (a `…` entry stands for a record shown below)", () => {
    const ex = examples(toBrowser);
    for (const option of ServerMessageSchema.options) {
      const type = option.shape.type.value;
      const example = ex.get(type) as Record<string, unknown> | undefined;
      expect(example, `an example for ${type}`).toBeDefined();
      expect(Object.keys(example!).sort(), type).toEqual(Object.keys(option.shape).sort());
      expect(example!["type"]).toBe(type);
    }
    expect(examples(toBridge).get("ping")).toEqual({ type: "ping" });
  });

  it("an example message is valid once its elided records are filled in", () => {
    const terminal = JSON.parse(/\*\*Terminal\*\*[\s\S]*?```json\n([\s\S]*?)```/.exec(md)![1]!);
    const machine = JSON.parse(/\*\*Machine\*\*:\s*```json\n([\s\S]*?)```/.exec(md)![1]!);
    const layout = JSON.parse(/\*\*Layout\*\*[\s\S]*?```json\n([\s\S]*?)```/.exec(md)![1]!);
    const ex = examples(toBrowser);
    expect(parseServerMessage(JSON.stringify(ex.get("hello"))).ok).toBe(true);
    expect(parseServerMessage(JSON.stringify(ex.get("terminal.removed"))).ok).toBe(true);
    expect(parseServerMessage(JSON.stringify(ex.get("layout.removed"))).ok).toBe(true);
    expect(parseServerMessage(JSON.stringify(ex.get("pong"))).ok).toBe(true);
    expect(parseServerMessage(JSON.stringify(ex.get("connection"))).ok).toBe(true);
    expect(parseServerMessage(JSON.stringify(ex.get("layout"))).ok).toBe(true);
    expect(parseServerMessage(JSON.stringify({ ...(ex.get("terminal") as object), terminal })).ok).toBe(true);
  });

  it("the Terminal, Machine and Layout examples are complete: every field of the schema, and no field the schema lacks", () => {
    const terminal = JSON.parse(/\*\*Terminal\*\*[\s\S]*?```json\n([\s\S]*?)```/.exec(md)![1]!);
    const machine = JSON.parse(/\*\*Machine\*\*:\s*```json\n([\s\S]*?)```/.exec(md)![1]!);
    const layout = JSON.parse(/\*\*Layout\*\*[\s\S]*?```json\n([\s\S]*?)```/.exec(md)![1]!);
    expect(Object.keys(terminal).sort()).toEqual(shapeKeys(TerminalSchema));
    expect(TerminalSchema.parse(terminal)).toEqual(terminal); // nothing dropped: no unknown field, no wrong type
    expect(Object.keys(terminal.foreground).sort()).toEqual(shapeKeys(ForegroundSchema));
    expect(Object.keys(terminal.status).every((k) => k in StatusSchema.shape)).toBe(true);
    expect(Object.keys(machine).sort()).toEqual(shapeKeys(MachineSchema));
    expect(MachineSchema.parse(machine)).toEqual(machine);
    expect(Object.keys(layout).sort()).toEqual(shapeKeys(LayoutSchema));
    expect(LayoutSchema.parse(layout)).toEqual(layout);
  });

  it("the documented status values, machine states and connection states are the ones the schema takes", () => {
    const connection = section("#### `connection`", "#### `pong`");
    for (const state of ["connecting", "connected", "reconnecting", "stopped"]) expect(connection).toContain(`\`${state}\``);
    const machineText = section("**Machine**", "**Layout**");
    for (const state of ["connecting", "connected", "needs_login", "unreachable"]) expect(machineText).toContain(`\`${state}\``);
    const layoutText = section("**Layout**");
    for (const status of ["ok", "empty", "unavailable"]) expect(layoutText).toContain(`\`${status}\``);
  });

  it("the numbers and codes it states are the ones the code uses", () => {
    expect(md).toContain("`PROTOCOL_VERSION` is **2**");
    for (const code of ["1003", "1008", "1013"]) expect(md).toContain(code);
    expect(md).toContain("5 wrong passphrases");
    expect(md).toContain("`herdr_web_session`");
    expect(md).toContain("30 days");
  });
});
