import { describe, expect, it } from "vitest";
import type { ThreadSnapshot } from "@herdr-web/agents/rows";
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
  chat: false,
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

const threadSnapshot: ThreadSnapshot = {
  seq: 3,
  identity: { agent: "pi", terminalId: "t7", sessionId: "s", sessionFile: "/x/s.jsonl", title: "hello", cwd: "/x" },
  rows: [
    { kind: "user", id: "u1", at: 1, text: "hi", images: 0 },
    { kind: "assistant", id: "a1.1", at: 2, text: "hello", model: "p/m", effort: "high" },
    { kind: "model", id: "m1", at: 3, model: "p/other" },
  ],
  hasMore: false,
  live: { working: false, reply: null, tools: [], pending: [], usage: null, notice: null, asks: [] },
  capabilities: { send: true, stop: true, models: null, efforts: null },
};

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
  { type: "app.shared", shared: { "agents.groups": [{ id: "g1", name: "ayra" }], "agents.groupLabel": { "gr-g1": "ayra" }, "agents.agentGroup": { t7: "g1" }, "agents.agentLabel": { t7: "ui-lead" }, "agents.spaceGroup": { sp1: "g1" }, "space.colors": { sp1: "ansi4" } } },
  { type: "app.shared", shared: null },
  { type: "chat.snapshot", terminal: "t7", snapshot: threadSnapshot },
  { type: "chat.change", terminal: "t7", change: { type: "update", seq: 4, live: { ...threadSnapshot.live, working: true } } },
  { type: "chat.change", terminal: "t7", change: { type: "reset", seq: 1, snapshot: { ...threadSnapshot, seq: 1 } } },
  { type: "chat.unavailable", terminal: "t7", reason: "pi is not connected to the bridge." },
  { type: "chat.snapshot", terminal: "t7", snapshot: { ...threadSnapshot, capabilities: { send: false, stop: false, models: null, efforts: null, disabled: "Control is off for this pi." } } },
  { type: "chat.snapshot", terminal: "t7", snapshot: { ...threadSnapshot, capabilities: { ...threadSnapshot.capabilities, disabled: null } } },
];

describe("server messages", () => {
  it.each(examples.map((m) => [m.type, m] as const))("%s round-trips through encode and parse", (_type, message) => {
    const parsed = parseServerMessage(encodeMessage(message));
    expect(parsed).toEqual({ ok: true, message });
  });

  it("covers every message type of the protocol", () => {
    expect([...new Set(examples.map((m) => m.type))].sort()).toEqual(
      ["connection", "hello", "layout", "layout.removed", "machines", "pong", "app.shared", "snapshot", "terminal", "terminal.removed", "chat.snapshot", "chat.change", "chat.unavailable"].sort(),
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
    ["a terminal without the chat flag", JSON.stringify({ type: "terminal", terminal: { ...terminal, chat: undefined } })],
    ["a chat row of a kind the schema does not have", JSON.stringify({ type: "chat.snapshot", terminal: "t7", snapshot: { ...threadSnapshot, rows: [{ kind: "hologram", id: "x", at: null }] } })],
    ["an assistant row without effort", JSON.stringify({ type: "chat.snapshot", terminal: "t7", snapshot: { ...threadSnapshot, rows: [{ kind: "assistant", id: "x", at: null, text: "", model: null }] } })],
    ["a disabled that is not a sentence", JSON.stringify({ type: "chat.snapshot", terminal: "t7", snapshot: { ...threadSnapshot, capabilities: { ...threadSnapshot.capabilities, disabled: 5 } } })],
    ["app.shared with a key missing", JSON.stringify({ type: "app.shared", shared: { "agents.groups": [] } })],
    ["app.shared with a label that is not a string", JSON.stringify({ type: "app.shared", shared: { "agents.groups": [], "agents.groupLabel": {}, "agents.agentGroup": {}, "agents.agentLabel": { t1: 3 }, "agents.spaceGroup": {}, "space.colors": {} } })],
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

  it("accepts subscribing to and leaving a chat", () => {
    expect(parseClientMessage('{"type":"chat.subscribe","terminal":"t7"}')).toEqual({ ok: true, message: { type: "chat.subscribe", terminal: "t7" } });
    expect(parseClientMessage('{"type":"chat.unsubscribe","terminal":"t12"}').ok).toBe(true);
  });

  it.each([
    '{"type":"chat.subscribe"}',
    '{"type":"chat.subscribe","terminal":"cachyos/t7"}',
    '{"type":"chat.subscribe","terminal":"../t7"}',
    '{"type":"chat.subscribe","terminal":"t7","extra":1}',
    '{"type":"chat.unsubscribe","terminal":7}',
  ])("rejects %j", (text) => {
    expect(parseClientMessage(text).ok).toBe(false);
  });

  it.each(["", "{", "[]", "{}", '{"type":"pong"}', '{"type":"login"}'])("rejects %j", (text) => {
    expect(parseClientMessage(text).ok).toBe(false);
  });
});
