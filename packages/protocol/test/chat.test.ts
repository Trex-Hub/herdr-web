import { describe, expect, it } from "vitest";
import {
  CHAT_OPERATION_NAMES,
  CHAT_PREFIX,
  ChatAnswerInputSchema,
  ChatAnswerResultSchema,
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
  it("names seven operations under one prefix", () => {
    expect(CHAT_OPERATION_NAMES).toEqual(["send", "stop", "model", "effort", "older", "result", "answer"]);
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
    expect(ChatAnswerInputSchema.safeParse({ terminal: "t7", id: "call_1", answer: { kind: "selection", selections: ["Blue"] } }).success).toBe(true);
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
    ["an answer with no id", ChatAnswerInputSchema, { terminal: "t7", answer: {} }],
    ["an answer with an empty id", ChatAnswerInputSchema, { terminal: "t7", id: "", answer: {} }],
    ["an answer that is a list", ChatAnswerInputSchema, { terminal: "t7", id: "c", answer: [] }],
    ["an answer that is text", ChatAnswerInputSchema, { terminal: "t7", id: "c", answer: "Blue" }],
    ["an answer on another machine", ChatAnswerInputSchema, { terminal: "cachyos/t7", id: "c", answer: {} }],
    ["an answer with an extra field", ChatAnswerInputSchema, { terminal: "t7", id: "c", answer: {}, force: true }],
  ])("refuses %s", (_name, schema, input) => {
    expect(schema.safeParse(input).success).toBe(false);
  });
});

describe("the answer result", () => {
  it.each([{ status: "delivered" }, { status: "invalid", reason: 'option "Purple" not offered' }, { status: "closed" }, { status: "not_found" }])("accepts %j", (result) => {
    expect(ChatAnswerResultSchema.safeParse(result).success).toBe(true);
  });

  it.each([{ status: "invalid" }, { status: "maybe" }, {}])("refuses %j", (result) => {
    expect(ChatAnswerResultSchema.safeParse(result).success).toBe(false);
  });
});
