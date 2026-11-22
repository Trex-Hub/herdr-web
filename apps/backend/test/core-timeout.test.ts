import type { Terminal } from "@herdr-web/core-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chatPicture } from "../../../packages/agents/test/fake-pi-live.js";
import { LivePi } from "./fake-pi.js";
import { ORIGIN, startHarness, until, type Harness } from "./helpers.js";

// DEV-29 D2 and D3: the highest `seen` written wins; a core that stops answering ends a request with a sentence (504).

const term = (address: string, extra: Partial<Terminal> = {}): Terminal => ({
  address, argv: ["sh"], cols: 80, rows: 24, created_ms: 1, cwd: "/", state: "live", screen: "exact", labels: {}, title: "", turn: 0, ...extra,
});

let h: Harness;
let cookie: string;
const post = async (path: string, body: unknown) => {
  const res = await fetch(`${h.base}${path}`, { method: "POST", headers: { Origin: ORIGIN, Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as { error?: string } };
};
const seenWrites = () => h.core.calls.filter((c) => c.method === "terminal.label").map((c) => Number((c.params as { labels: Record<string, string> }).labels["herdr.seen"]));

beforeEach(async () => {
  h = await startHarness({ connectCore: false, live: true, callTimeoutMs: 300 });
  h.core.terminals = [term("t1", { turn: 5, labels: { "herdr.seen": "0" } }), term("t2", { turn: 5, labels: { "herdr.seen": "0" } })];
  h.core.rpc.set("terminal.label", () => term("t1"));
  h.core.rpc.set("terminal.send", () => ({ turn: 1, started: true, status: "idle" }));
  h.session.start();
  await until(() => h.session.state === "connected" && h.session.store.get("t2") !== undefined);
  cookie = await h.cookie();
});
afterEach(async () => {
  await h.stop();
});

describe("seen only goes up (D2)", () => {
  it("5 then 3 before core's event is back: the 3 is refused (409) and only the 5 is written", async () => {
    expect((await post("/api/ops/seen", { terminal: "t1", turn: 5 })).status).toBe(200);
    const late = await post("/api/ops/seen", { terminal: "t1", turn: 3 });
    expect(late.status).toBe(409);
    expect(late.body.error).toMatch(/already marked seen at 5/);
    expect(seenWrites()).toEqual([5]);
  });

  it("a request that fails does not leave its value behind: a lower one is allowed afterwards", async () => {
    h.core.rpc.set("terminal.label", () => ({ error: { message: "no", kind: "invalid_params" } }) as never);
    expect((await post("/api/ops/seen", { terminal: "t1", turn: 5 })).status).toBe(502);
    h.core.rpc.set("terminal.label", () => term("t1"));
    expect((await post("/api/ops/seen", { terminal: "t1", turn: 3 })).status).toBe(200);
    expect(seenWrites()).toEqual([5, 3]);
  });

  it("mark unread is the reader's own way down: after it, the lower value is the floor", async () => {
    expect((await post("/api/ops/seen", { terminal: "t1", turn: 5 })).status).toBe(200);
    expect((await post("/api/ops/unread", { terminal: "t1" })).status).toBe(200);
    expect(seenWrites()).toEqual([5, 4]);
    expect((await post("/api/ops/seen", { terminal: "t1", turn: 5 })).status).toBe(200);
    expect(seenWrites()).toEqual([5, 4, 5]);
  });

  it("each terminal has its own floor", async () => {
    expect((await post("/api/ops/seen", { terminal: "t1", turn: 5 })).status).toBe(200);
    expect((await post("/api/ops/seen", { terminal: "t2", turn: 3 })).status).toBe(200);
  });

  it("when core's own value has caught up the memory goes: a person's `hc label` to a lower value is not fought", async () => {
    expect((await post("/api/ops/seen", { terminal: "t1", turn: 5 })).status).toBe(200);
    h.core.event("labels", "t1", { labels: { "herdr.seen": "5" } });
    await until(() => h.session.store.get("t1")?.labels?.["herdr.seen"] === "5");
    expect((await post("/api/ops/seen", { terminal: "t1", turn: 5 })).status).toBe(409); // equal: already seen
    h.core.event("labels", "t1", { labels: { "herdr.seen": "1" } });
    await until(() => h.session.store.get("t1")?.labels?.["herdr.seen"] === "1");
    expect((await post("/api/ops/seen", { terminal: "t1", turn: 3 })).status).toBe(200);
  });
});

describe("a core that stopped answering (D3)", () => {
  it("an operation ends with 504 and a sentence within the limit, and the bridge stays usable", async () => {
    h.core.muted = true;
    const began = Date.now();
    const r = await post("/api/ops/pin", { terminal: "t1", pinned: true });
    expect(r.status).toBe(504);
    expect(r.body.error).toMatch(/^Core did not answer/);
    expect(Date.now() - began).toBeLessThan(2000);
    h.core.muted = false;
    expect((await post("/api/ops/pin", { terminal: "t1", pinned: true })).status).toBe(200);
  });

  it("a timed-out seen releases its claim so the next one is not refused for a write that never happened", async () => {
    h.core.muted = true;
    expect((await post("/api/ops/seen", { terminal: "t1", turn: 5 })).status).toBe(504);
    h.core.muted = false;
    expect((await post("/api/ops/seen", { terminal: "t1", turn: 4 })).status).toBe(200);
  });

  it("typing a `/command` into the terminal ends with 504 too", async () => {
    const pi = await LivePi.start(h.liveDir!, { terminal: "t1", config: { chat: chatPicture() } });
    await until(() => h.chat.has("t1"));
    h.core.muted = true;
    const r = await post("/api/chat/send", { terminal: "t1", text: "/model" });
    expect(r.status).toBe(504);
    expect(r.body.error).toMatch(/^Core did not answer/);
    await pi.stop();
  });

  it("the event stream is not given a limit: core staying silent for longer than a call may wait does not drop the session", async () => {
    h.core.muted = true;
    await new Promise((r) => setTimeout(r, 700));
    expect(h.session.state).toBe("connected");
  });
});
