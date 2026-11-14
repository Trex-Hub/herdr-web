import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  encodeMessage,
  parseClientMessage,
  parseServerMessage,
  type Layout,
  type ServerMessage,
  type Terminal,
} from "../src/index.js";

const terminal: Terminal = {
  address: "cachyos/t7",
  name: null,
  state: "live",
  argv: ["pi"],
  cwd: "/home/x",
  cols: 200,
  rows: 50,
  created_ms: 1,
  finished_ms: null,
  exit_code: null,
  signal: null,
  reason: null,
  title: "pi",
  labels: { "herdr.seen": "2" },
  status: { state: "working", msg: "thinking", progress: 40 },
  status_ms: 5,
  turn: 3,
  foreground: { pid: 9, name: "node", argv: ["node"], cwd: "/home/x" },
  keep: true,
  parent: null,
  template: "pi",
};

const layout: Layout = {
  machine: "cachyos",
  status: "ok",
  reason: null,
  version: 14,
  spaces: [{ id: "sp1", name: "work", folder: "/home/x", tabs: [{ id: "tb1", name: "", panes: [{ id: "p1", kind: "terminal", terminal: "cachyos/t7" }, { id: "p2", kind: "other", mod: null }] }] }],
};

const connection = { state: "connected", error: null, core: { id: "i", name: "mac", version: "0.1.21" } } as const;
const machine = { name: "cachyos", id: "i", host: "h", target: "ssh", version: "0.1.21", state: "connected", why: null, since_ms: null, temporary: false };

const examples: ServerMessage[] = [
  { type: "hello", protocol: PROTOCOL_VERSION, build: "abc1234" },
  { type: "snapshot", connection, terminals: [terminal], machines: [machine], layouts: [layout] },
  { type: "terminal", terminal },
  { type: "terminal.removed", address: "t7" },
  { type: "machines", machines: [machine] },
  { type: "layout", layout },
  { type: "layout.removed", machine: null },
  { type: "connection", connection: { state: "reconnecting", error: "cannot connect", core: null } },
  { type: "pong" },
];

describe("server messages", () => {
  it.each(examples.map((m) => [m.type, m] as const))("%s round-trips through encode and parse", (_type, message) => {
    const parsed = parseServerMessage(encodeMessage(message));
    expect(parsed).toEqual({ ok: true, message });
  });

  it("covers every message type of the protocol", () => {
    expect(examples.map((m) => m.type).sort()).toEqual(
      ["connection", "hello", "layout", "layout.removed", "machines", "pong", "snapshot", "terminal", "terminal.removed"].sort(),
    );
  });

  it("ignores fields it does not know, so a newer bridge adding one does not break a browser", () => {
    const parsed = parseServerMessage(JSON.stringify({ type: "terminal", terminal: { ...terminal, future: 1 }, extra: true }));
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && JSON.stringify(parsed.message)).not.toContain("future");
  });

  it.each([
    ["not JSON", "{"],
    ["not an object", "7"],
    ["no type", "{}"],
    ["an unknown type", JSON.stringify({ type: "teleport" })],
    ["hello without a build", JSON.stringify({ type: "hello", protocol: 1 })],
    ["a terminal without an address", JSON.stringify({ type: "terminal", terminal: { ...terminal, address: undefined } })],
    ["a terminal state core never says", JSON.stringify({ type: "terminal", terminal: { ...terminal, state: "zombie" } })],
    ["a pane of an unknown kind", JSON.stringify({ type: "layout", layout: { ...layout, spaces: [{ ...layout.spaces[0], tabs: [{ id: "t", name: "", panes: [{ id: "p", kind: "hologram" }] }] }] } })],
    ["a layout status not in the list", JSON.stringify({ type: "layout", layout: { ...layout, status: "maybe" } })],
    ["a connection state not in the list", JSON.stringify({ type: "connection", connection: { ...connection, state: "dreaming" } })],
  ])("rejects %s, with a reason", (_name, text) => {
    const parsed = parseServerMessage(text);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toMatch(/\S/);
  });
});

describe("client messages", () => {
  it("accepts ping", () => {
    expect(parseClientMessage('{"type":"ping"}')).toEqual({ ok: true, message: { type: "ping" } });
  });

  it.each(["", "{", "[]", "{}", '{"type":"pong"}', '{"type":"login"}'])("rejects %j", (text) => {
    expect(parseClientMessage(text).ok).toBe(false);
  });
});
