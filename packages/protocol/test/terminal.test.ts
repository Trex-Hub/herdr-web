import { describe, expect, it } from "vitest";
import {
  Tag,
  encodeTerminalMessage,
  isTerminalAddress,
  parseTerminalClientMessage,
  parseTerminalServerMessage,
  parseTerminalSocketPath,
  splitTagged,
  tagMessage,
  terminalSocketPath,
} from "../src/index.js";

const display = { fg: "#d4d4d4", bg: "#1e1e1e", cursor: null, cell: [9, 18] as [number, number] };

describe("tag codec", () => {
  it("puts the tag first and the bytes after it", () => {
    expect([...tagMessage(Tag.INPUT, Uint8Array.from([0x61, 0x0d]))]).toEqual([1, 0x61, 0x0d]);
    expect([...tagMessage(Tag.AUTOMATIC, Uint8Array.from([0x1b, 0x5b, 0x63]))]).toEqual([2, 0x1b, 0x5b, 0x63]);
    expect([...tagMessage(Tag.OUTPUT, new Uint8Array())]).toEqual([0]);
  });

  it("splits a message into its tag and a view of the bytes", () => {
    const msg = tagMessage(Tag.OUTPUT, Uint8Array.from([1, 2, 3]));
    const t = splitTagged(msg)!;
    expect(t.tag).toBe(Tag.OUTPUT);
    expect([...t.bytes]).toEqual([1, 2, 3]);
    expect(t.bytes.buffer).toBe(msg.buffer); // a view
  });

  it("round-trips every byte value under every tag", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    for (const tag of [Tag.OUTPUT, Tag.INPUT, Tag.AUTOMATIC]) {
      const t = splitTagged(tagMessage(tag, all))!;
      expect(t.tag).toBe(tag);
      expect([...t.bytes]).toEqual([...all]);
    }
  });

  it("refuses an empty message and an unknown tag", () => {
    expect(splitTagged(new Uint8Array())).toBeNull();
    for (const tag of [3, 7, 255]) expect(splitTagged(Uint8Array.from([tag, 1]))).toBeNull();
  });
});

describe("socket path", () => {
  it("carries the address, remote ones too", () => {
    expect(terminalSocketPath("t7")).toBe("/api/terminal/t7");
    expect(terminalSocketPath("cachyos/t7")).toBe("/api/terminal/cachyos/t7");
  });

  it("parses what it builds and refuses anything that is not an address", () => {
    for (const a of ["t7", "t123456789", "cachyos/t7", "dev-server.1/t0", "A_b/t1".replace("_", "-")]) expect(parseTerminalSocketPath(terminalSocketPath(a)), a).toBe(a);
    for (const bad of ["/api/terminal/", "/api/terminal/t", "/api/terminal/7", "/api/terminal/name", "/api/terminal/a/b/t1", "/api/terminal/../t1", "/api/terminal/t7/", "/api/terminal/t7%00", "/api/terminal/%E0%A4%A", "/api/ws", "/api/terminal/t1234567890", "/api/terminal//t7"]) {
      expect(parseTerminalSocketPath(bad), bad).toBeNull();
    }
    expect(isTerminalAddress("t7")).toBe(true);
    expect(isTerminalAddress("x")).toBe(false);
  });
});

describe("control messages", () => {
  it("accept every client message", () => {
    const ok = [
      { type: "attach", cols: 80, rows: 24, history: 10_000, display },
      { type: "attach", cols: 1, rows: 1, history: 0, display: { fg: null, bg: null, cursor: null, cell: null } },
      { type: "resize", cols: 200, rows: 50 },
      { type: "focus", focused: true },
      { type: "display", display },
      { type: "consumed", bytes: 65536 },
    ];
    for (const m of ok) expect(parseTerminalClientMessage(JSON.stringify(m)), JSON.stringify(m)).toEqual({ ok: true, message: m });
  });

  it("refuse what breaks the rules", () => {
    const bad = [
      { type: "attach", cols: 0, rows: 24, history: 0, display },
      { type: "attach", cols: 80, rows: 24, history: -1, display },
      { type: "attach", cols: 80, rows: 24, history: 1e9, display },
      { type: "attach", cols: 80, rows: 24, history: 0 },
      { type: "attach", cols: 80.5, rows: 24, history: 0, display },
      { type: "resize", cols: 5000, rows: 24 },
      { type: "focus", focused: "yes" },
      { type: "display", display: { ...display, fg: "red" } },
      { type: "display", display: { ...display, cell: [0, 18] } },
      { type: "consumed", bytes: 0 },
      { type: "consumed", bytes: -5 },
      { type: "consumed", bytes: 1.5 },
      { type: "consumed" },
      { type: "nope" },
      {},
    ];
    for (const m of bad) expect(parseTerminalClientMessage(JSON.stringify(m)).ok, JSON.stringify(m)).toBe(false);
    expect(parseTerminalClientMessage("not json").ok).toBe(false);
    expect(parseTerminalClientMessage("null").ok).toBe(false);
  });

  it("accept every server message and round-trip through encodeTerminalMessage", () => {
    const msgs = [
      { type: "attached" as const, cols: 80, rows: 24, automaticInput: true },
      { type: "ended" as const, reason: "exited", exitCode: 0, signal: null },
      { type: "ended" as const, reason: "killed", exitCode: null, signal: 9 },
    ];
    for (const m of msgs) expect(parseTerminalServerMessage(encodeTerminalMessage(m))).toEqual({ ok: true, message: m });
    expect(parseTerminalServerMessage('{"type":"attached"}').ok).toBe(false);
  });
});
