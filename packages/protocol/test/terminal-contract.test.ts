// Tester's cases for DEV-23: PROTOCOL.md "Terminal socket" held to the code, both ways.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_DIMENSION, MAX_HISTORY, Tag, TerminalClientMessageSchema, TerminalClose, TerminalServerMessageSchema, isTerminalAddress, parseTerminalSocketPath, terminalSocketPath } from "../src/index.js";

const doc = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../PROTOCOL.md"), "utf8");
const section = doc.slice(doc.indexOf("## Terminal socket"), doc.indexOf("## Records"));

const blocks = (text: string): unknown[] => [...text.matchAll(/```json\n([\s\S]*?)```/g)].flatMap((m) => parseBlock(m[1]!));
function parseBlock(src: string): unknown[] {
  // a block holds one JSON object, or several one after another
  const out: unknown[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of src) {
    cur += ch;
    if (ch === "{") depth++;
    if (ch === "}" && --depth === 0) {
      out.push(JSON.parse(cur));
      cur = "";
    }
  }
  return out;
}

describe("PROTOCOL.md, terminal socket section", () => {
  const clientHeadings = section.slice(section.indexOf("### Browser → bridge"), section.indexOf("### Bridge → browser"));
  const serverHeadings = section.slice(section.indexOf("### Bridge → browser"), section.indexOf("### Binary messages"));

  it("every example message validates against the schema of its direction, and every message type of the schema has an example", () => {
    const client = blocks(clientHeadings);
    const server = blocks(serverHeadings);
    for (const m of client) expect(TerminalClientMessageSchema.safeParse(m).success, JSON.stringify(m)).toBe(true);
    for (const m of server) expect(TerminalServerMessageSchema.safeParse(m).success, JSON.stringify(m)).toBe(true);
    expect(new Set(client.map((m) => (m as { type: string }).type))).toEqual(new Set(["attach", "resize", "focus", "display", "consumed"]));
    expect(new Set(server.map((m) => (m as { type: string }).type))).toEqual(new Set(["attached", "ended"]));
    // and the schema has no type the document leaves out
    for (const option of TerminalClientMessageSchema.options) expect(clientHeadings, option.shape.type.value).toContain(`"${option.shape.type.value}"`);
    for (const option of TerminalServerMessageSchema.options) expect(serverHeadings, option.shape.type.value).toContain(`"${option.shape.type.value}"`);
  });

  it("every key an example uses is a key the schema knows, and every key the schema has appears in an example", () => {
    const keysOf = (messages: unknown[]) => new Map(messages.map((m) => [(m as { type: string }).type, Object.keys(m as object).sort()]));
    const clientKeys = keysOf(blocks(clientHeadings));
    for (const option of TerminalClientMessageSchema.options) expect(clientKeys.get(option.shape.type.value), option.shape.type.value).toEqual(Object.keys(option.shape).sort());
    const serverKeys = keysOf(blocks(serverHeadings));
    for (const option of TerminalServerMessageSchema.options) expect(serverKeys.get(option.shape.type.value), option.shape.type.value).toEqual(Object.keys(option.shape).sort());
  });

  it("the close-code table is the TerminalClose table, code for code", () => {
    const table = section.slice(section.indexOf("### Close codes"));
    const documented = [...table.matchAll(/^\| (\d+) \|/gm)].map((m) => Number(m[1]));
    expect(documented.sort()).toEqual(Object.values(TerminalClose).sort());
  });

  it("the tag table is the Tag table", () => {
    const table = section.slice(section.indexOf("| tag |"), section.indexOf("`tagMessage(tag"));
    const documented = [...table.matchAll(/^\| `(\d)` \|/gm)].map((m) => Number(m[1]));
    expect(documented.sort()).toEqual(Object.values(Tag).sort());
  });

  it("the limits the text states are the limits in the code: 1 to 1000 cells, 0 to 100000 history", () => {
    expect(section).toContain("(1 to 1000)");
    expect(section).toContain("(0 to 100000)");
    expect(MAX_DIMENSION).toBe(1000);
    expect(MAX_HISTORY).toBe(100_000);
  });

  it("the sizes it states match the bridge: 10 s to attach, 1 MiB per message, 8 MiB outstanding", () => {
    const code = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../apps/backend/src/terminal-socket.ts"), "utf8");
    expect(section).toContain("within 10 s");
    expect(code).toContain("attachTimeoutMs ?? 10_000");
    expect(section).toContain("larger than 1 MiB");
    expect(code).toContain("MAX_MESSAGE_BYTES = 1024 * 1024");
    expect(section).toContain("(8 MiB)");
    expect(code).toContain("maxOutstandingBytes ?? 8 * 1024 * 1024");
  });
});

describe("defects", () => {
  // Core's addresses are base 32 once a counter passes 31 (t1b, t1c, t2j … in a real core), not only digits.
  const real = ["t1", "t9", "t10", "t1b", "t1c", "t1v", "t2j", "t2n", "t3z", "cachyos/t2", "cachyos/t1b", "devserver/t3k"];

  it("every address a real core hands out is a terminal address", () => {
    for (const a of real) expect(isTerminalAddress(a), a).toBe(true);
  });

  it("the socket path for such an address reads back as the same address", () => {
    for (const a of real) expect(parseTerminalSocketPath(terminalSocketPath(a)), a).toBe(a);
  });
});
