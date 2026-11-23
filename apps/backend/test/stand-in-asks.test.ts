// The browser e2e's stand-in pi (apps/web/e2e/stand-in.ts) can park ask_user prompts and answer them, checked through the backend.
import type { Terminal } from "@herdr-web/core-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tmpDir } from "../../../packages/agents/test/helpers.js";
import { StandIn } from "../../web/e2e/stand-in.js";
import { ORIGIN, startHarness, until, type Harness } from "./helpers.js";

const term = (address: string): Terminal => ({ address, argv: ["pi"], cols: 80, rows: 24, created_ms: 1, cwd: "/", state: "live", screen: "exact", labels: {}, title: "", turn: 0 });

let h: Harness;
let cookie: string;
let pi: StandIn;

beforeEach(async () => {
  h = await startHarness({ connectCore: false, live: { terminalWaitMs: 300, coreWaitMs: 500, followMs: 600, connection: { thread: { actionTimeoutMs: 400, entryWaitMs: 100 } } } });
  h.core.terminals = [term("t1")];
  h.session.start();
  await until(() => h.session.state === "connected" && h.session.store.get("t1") !== undefined);
  cookie = await h.cookie();
  pi = await StandIn.connect({ liveDir: h.liveDir!, terminalId: "t1", dir: tmpDir(), stepMs: 5 });
  await until(() => h.chat.has("t1"));
});
afterEach(async () => {
  pi.close();
  await h.stop();
});

const post = async (name: string, body: unknown) => {
  const res = await fetch(`${h.base}/api/chat/${name}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const thread = () => h.chat.thread("t1")!.snapshot();
const asks = () => thread().live.asks.map((a) => a.id);
const askRow = (id: string) => thread().rows.find((r) => r.kind === "tool" && r.callId === id);
const question = { question: "Which color?", options: [{ title: "Green" }, { title: "Blue" }], allowMultiple: false, allowFreeform: true, allowComment: true };
const batch = { heading: "Setup", allowComment: false, questions: [{ question: "One?", options: [{ title: "a" }], allowMultiple: false, allowFreeform: false }, { question: "Two?", options: [{ title: "b" }], allowMultiple: false, allowFreeform: false }] };

describe("the stand-in's prompts", () => {
  it("park: the ask is in the thread, without an expiresAt it is null, and the call shows as a running tool", async () => {
    const id = pi.park("ask_user.question", question);
    await until(() => asks().length === 1);
    expect(thread().live.asks[0]).toMatchObject({ id, kind: "ask_user.question", title: "Which color?", expiresAt: null });
    expect(thread().live.tools.map((t) => t.callId)).toContain(id);
    expect(thread().live.working).toBe(true);
  });

  it("answered from the browser: delivered, the ask goes, the row carries the details", async () => {
    const id = pi.park("ask_user.question", question);
    await until(() => asks().length === 1);
    const r = await post("answer", { terminal: "t1", id, answer: { kind: "selection", selections: ["Blue"], comment: "sky" } });
    expect(r).toEqual({ status: 200, body: { status: "delivered" } });
    await until(() => asks().length === 0 && askRow(id) !== undefined && (askRow(id) as any).status === "ok");
    expect(askRow(id)).toMatchObject({ name: "ask_user", details: { cancelled: false, response: { kind: "selection", selections: ["Blue"], comment: "sky" } } });
    expect(thread().live.working).toBe(false);
    expect(pi.answers).toHaveLength(1);
  });

  it("an invalid answer says why and leaves it open; a freeform answer is taken", async () => {
    const id = pi.park("ask_user.question", { ...question, allowFreeform: false });
    await until(() => asks().length === 1);
    expect((await post("answer", { terminal: "t1", id, answer: { kind: "selection", selections: ["Purple"] } })).body).toEqual({ status: "invalid", reason: 'option "Purple" not offered' });
    expect((await post("answer", { terminal: "t1", id, answer: { kind: "selection", selections: ["Green", "Blue"] } })).body).toEqual({ status: "invalid", reason: "only one selection allowed" });
    expect((await post("answer", { terminal: "t1", id, answer: { kind: "freeform", text: "Teal" } })).body).toEqual({ status: "invalid", reason: "freeform not allowed" });
    expect(asks()).toEqual([id]);
    const other = pi.park("ask_user.question", question, { id: "second" });
    await until(() => asks().length === 2);
    expect((await post("answer", { terminal: "t1", id: other, answer: { kind: "freeform", text: "Teal" } })).body).toEqual({ status: "delivered" });
    await until(() => asks().length === 1);
  });

  it("a batch with a skip", async () => {
    const id = pi.park("ask_user.batch", batch);
    await until(() => asks().length === 1);
    expect((await post("answer", { terminal: "t1", id, answer: { answers: [{ status: "skipped" }] } })).body).toEqual({ status: "invalid", reason: "expected 2 answers, got 1" });
    const answers = [{ status: "skipped" }, { status: "answered", response: { kind: "selection", selections: ["b"] } }];
    expect((await post("answer", { terminal: "t1", id, answer: { answers } })).body).toEqual({ status: "delivered" });
    await until(() => (askRow(id) as any)?.details !== undefined);
    expect(askRow(id)).toMatchObject({ details: { kind: "batch", answers, cancelled: false } });
  });

  it("answered at the keyboard, or cancelled: the ask goes and a late answer is closed", async () => {
    const a = pi.park("ask_user.question", question);
    const b = pi.park("ask_user.question", question, { id: "second" });
    await until(() => asks().length === 2);
    pi.answerAtKeyboard(a, { kind: "freeform", text: "Teal" });
    pi.cancelAsk(b);
    await until(() => asks().length === 0);
    expect(await post("answer", { terminal: "t1", id: a, answer: { kind: "freeform", text: "late" } })).toEqual({ status: 200, body: { status: "closed" } });
    expect((await post("answer", { terminal: "t1", id: "nope", answer: { kind: "freeform", text: "x" } })).body).toEqual({ status: "not_found" });
    await until(() => (askRow(b) as any)?.details?.cancelled === true);
  });

  it("stop while asking closes the ask with abort and leaves the call without a result", async () => {
    const id = pi.park("ask_user.question", question);
    await until(() => asks().length === 1);
    expect((await post("stop", { terminal: "t1" })).status).toBe(200);
    await until(() => asks().length === 0 && !thread().live.working);
    expect(pi.openAsks()).toEqual([]);
    expect((askRow(id) as any).result).toBeNull();
  });

  it("an expiresAt, when given, reaches the ask", async () => {
    const at = Date.now() + 60_000;
    pi.park("ask_user.question", question, { expiresAt: at });
    await until(() => asks().length === 1);
    expect(thread().live.asks[0]!.expiresAt).toBe(at);
  });
});
