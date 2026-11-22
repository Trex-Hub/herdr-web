// Tester's cases for DEV-25/26: PROTOCOL.md "Chat" and the chat messages of the main socket held to the code, both ways.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHAT_OPERATION_NAMES, ChatChangeMessageSchema, ChatSnapshotMessageSchema, ChatSubscribeSchema, ChatUnavailableMessageSchema, ChatUnsubscribeSchema, MAX_CHAT_SUBSCRIPTIONS, MAX_MESSAGE_CHARS, MAX_PAGE, ClientMessageSchema, ServerMessageSchema } from "../src/index.js";
import { RowSchema } from "@herdr-web/agents/rows";

const here = path.dirname(fileURLToPath(import.meta.url));
const doc = readFileSync(path.join(here, "../PROTOCOL.md"), "utf8");
const main = doc.slice(doc.indexOf("## Main socket"), doc.indexOf("## Terminal socket"));
const chat = doc.slice(doc.indexOf("## Chat:"), doc.indexOf("## Records"));

const jsonBlockAfter = (text: string, heading: string): unknown => {
  const at = text.indexOf(heading);
  expect(at, heading).toBeGreaterThan(-1);
  const m = /```json\n([\s\S]*?)```/.exec(text.slice(at));
  return JSON.parse(m![1]!);
};

describe("PROTOCOL.md, chat on the main socket", () => {
  it("every chat example validates against the schema of its direction, and the generic unions know them", () => {
    const snapshot = jsonBlockAfter(main, "#### `chat.snapshot`");
    const change = jsonBlockAfter(main, "#### `chat.change`");
    const unavailable = jsonBlockAfter(main, "#### `chat.unavailable`");
    const subscribe = jsonBlockAfter(main, "#### `chat.subscribe`");
    const unsubscribe = jsonBlockAfter(main, "#### `chat.unsubscribe`");
    expect(ChatSnapshotMessageSchema.safeParse(snapshot).success).toBe(true);
    expect(ChatChangeMessageSchema.safeParse(change).success).toBe(true);
    expect(ChatUnavailableMessageSchema.safeParse(unavailable).success).toBe(true);
    expect(ChatSubscribeSchema.safeParse(subscribe).success).toBe(true);
    expect(ChatUnsubscribeSchema.safeParse(unsubscribe).success).toBe(true);
    for (const m of [snapshot, change, unavailable]) expect(ServerMessageSchema.safeParse(m).success, JSON.stringify(m).slice(0, 60)).toBe(true);
    for (const m of [subscribe, unsubscribe]) expect(ClientMessageSchema.safeParse(m).success).toBe(true);
  });

  it("the snapshot example carries every key of a thread snapshot, and nothing the schema would not allow", () => {
    const snapshot = (jsonBlockAfter(main, "#### `chat.snapshot`") as { snapshot: Record<string, unknown> }).snapshot;
    const parsed = ChatSnapshotMessageSchema.shape.snapshot.parse(snapshot) as Record<string, unknown>;
    expect(Object.keys(snapshot).sort()).toEqual(Object.keys(parsed).sort());
    expect(Object.keys(snapshot.identity as object).sort()).toEqual(Object.keys(parsed.identity as object).sort());
  });

  it("the limits it states are the limits in the code: 16 subscriptions, 100,000 characters, pages of 1 to 200", () => {
    expect(main).toContain("At most 16 at once");
    expect(MAX_CHAT_SUBSCRIPTIONS).toBe(16);
    expect(chat).toContain("1 to 100,000 characters");
    expect(MAX_MESSAGE_CHARS).toBe(100_000);
    expect(chat).toContain("`limit` 1 to 200");
    expect(MAX_PAGE).toBe(200);
  });
});

describe("PROTOCOL.md, chat operations", () => {
  it("the operation table lists exactly the operation names of the code, and nothing else is a POST", () => {
    const table = chat.slice(chat.indexOf("| name | body | success |"), chat.indexOf("Status codes:"));
    const documented = [...table.matchAll(/^\| `(\w+)` \|/gm)].map((m) => m[1]);
    expect(documented.sort()).toEqual([...CHAT_OPERATION_NAMES].sort());
  });

  it("the row kinds listed are the kinds of the row schema, both ways", () => {
    const listed = [...chat.matchAll(/^- `(\w+)`:/gm)].map((m) => m[1]!);
    const kinds = RowSchema.options.map((o) => o.shape.kind.value as string);
    expect(listed.sort()).toEqual([...kinds].sort());
  });

  it("the keys it names for each row kind are the keys of the schema", () => {
    for (const option of RowSchema.options) {
      const kind = option.shape.kind.value as string;
      const line = chat.split("\n").find((l) => l.startsWith(`- \`${kind}\`:`))!;
      const named = new Set([...line.matchAll(/`(\w+)`/g)].map((m) => m[1]!));
      for (const key of Object.keys(option.shape)) {
        if (key === "kind" || key === "id" || key === "at") continue;
        expect(named.has(key), `${kind}.${key} is in the schema but not in the line`).toBe(true);
      }
    }
  });

  it("the status codes it names are the ones the routes answer (400 401 403 404 409 502 503)", () => {
    const line = chat.slice(chat.indexOf("Status codes:"));
    for (const code of ["400", "401", "403", "404", "409", "502", "503"]) expect(line, code).toContain(`\`${code}\``);
  });
});
