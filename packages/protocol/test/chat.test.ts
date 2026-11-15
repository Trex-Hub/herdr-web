import { describe, expect, it } from "vitest";
import {
  CHAT_OPERATION_NAMES,
  CHAT_PREFIX,
  ChatEffortInputSchema,
  ChatModelInputSchema,
  ChatOlderInputSchema,
  ChatResultInputSchema,
  ChatSendInputSchema,
  ChatStopInputSchema,
  MAX_MESSAGE_CHARS,
  MAX_PAGE,
  chatPath,
} from "../src/index.js";

describe("chat operation inputs", () => {
  it("names six operations under one prefix", () => {
    expect(CHAT_OPERATION_NAMES).toEqual(["send", "stop", "model", "effort", "older", "result"]);
    expect(chatPath("older")).toBe(`${CHAT_PREFIX}older`);
  });

  it("accepts a well-formed input of each", () => {
    expect(ChatSendInputSchema.safeParse({ terminal: "t7", text: "hello" }).success).toBe(true);
    expect(ChatStopInputSchema.safeParse({ terminal: "t7" }).success).toBe(true);
    expect(ChatModelInputSchema.safeParse({ terminal: "t7", model: "p/m" }).success).toBe(true);
    expect(ChatEffortInputSchema.safeParse({ terminal: "t7", effort: "high" }).success).toBe(true);
    expect(ChatOlderInputSchema.safeParse({ terminal: "t7", before: "row.1" }).success).toBe(true);
    expect(ChatOlderInputSchema.safeParse({ terminal: "t7", before: "row.1", limit: MAX_PAGE }).success).toBe(true);
    expect(ChatResultInputSchema.safeParse({ terminal: "t7", row: "row.1" }).success).toBe(true);
  });

  it.each([
    ["a terminal on another machine", ChatSendInputSchema, { terminal: "cachyos/t7", text: "x" }],
    ["a terminal that is a name", ChatSendInputSchema, { terminal: "pi-one", text: "x" }],
    ["an empty message", ChatSendInputSchema, { terminal: "t7", text: "" }],
    ["a message past the limit", ChatSendInputSchema, { terminal: "t7", text: "x".repeat(MAX_MESSAGE_CHARS + 1) }],
    ["a message that is not text", ChatSendInputSchema, { terminal: "t7", text: 7 }],
    ["an extra field", ChatStopInputSchema, { terminal: "t7", force: true }],
    ["no model", ChatModelInputSchema, { terminal: "t7" }],
    ["an empty effort", ChatEffortInputSchema, { terminal: "t7", effort: "" }],
    ["a page limit of zero", ChatOlderInputSchema, { terminal: "t7", before: "r", limit: 0 }],
    ["a page limit past the maximum", ChatOlderInputSchema, { terminal: "t7", before: "r", limit: MAX_PAGE + 1 }],
    ["a fractional page limit", ChatOlderInputSchema, { terminal: "t7", before: "r", limit: 1.5 }],
    ["no row", ChatResultInputSchema, { terminal: "t7" }],
  ])("refuses %s", (_name, schema, input) => {
    expect(schema.safeParse(input).success).toBe(false);
  });
});
