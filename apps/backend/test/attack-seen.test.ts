// Tester's cases for DEV-29 D2 and D3 as the page sees them: the memory of what `seen` was written, and a core that answers late.
import type { Terminal } from "@herdr-web/core-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ORIGIN, startHarness, until, type Harness } from "./helpers.js";

const term = (address: string, extra: Partial<Terminal> = {}): Terminal => ({
  address, argv: ["sh"], cols: 80, rows: 24, created_ms: 1, cwd: "/", state: "live", screen: "exact", labels: {}, title: "", turn: 0, ...extra,
});

let h: Harness;
let cookie: string;
const post = async (path: string, body: unknown) => {
  const res = await fetch(`${h.base}${path}`, { method: "POST", headers: { Origin: ORIGIN, Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as { error?: string } & Record<string, unknown> };
};
const seen = (t: string, turn: number) => post("/api/ops/seen", { terminal: t, turn });
const writes = () => h.core.calls.filter((c) => c.method === "terminal.label").map((c) => (c.params as { labels: Record<string, string> }).labels["herdr.seen"]);
const labelEvent = async (t: string, value: string) => {
  h.core.event("labels", t, { labels: { "herdr.seen": value } });
  await until(() => h.session.store.get(t)?.labels?.["herdr.seen"] === value);
};

async function boot(terminals: Terminal[]): Promise<void> {
  if (h) await h.stop();
  h = await startHarness({ connectCore: false, callTimeoutMs: 300 });
  h.core.machines = [{ name: "cachyos", target: "x", id: "i", host: "h", version: "1", state: "connected" }];
  h.core.terminals = terminals;
  h.core.rpc.set("terminal.label", () => term("t1"));
  h.core.rpc.set("terminal.run", () => term("t7"));
  h.core.docs.set("", { value: { spaces: [{ id: "sp", name: "sp", folder: "/work", tabs: [] }] }, version: 1 });
  h.session.start();
  await until(() => h.session.state === "connected" && h.session.layouts.list().length >= 1 && terminals.every((t) => h.session.store.get(t.address) !== undefined));
  cookie = await h.cookie();
}
beforeEach(async () => {
  await boot([term("t1", { turn: 5, labels: { "herdr.seen": "0" } })]);
});
afterEach(async () => {
  await h.stop();
});

describe("the memory of what was written", () => {
  it("many windows at once: 30 turns in a random order leave writes that only go up, and the label ends at the highest that was accepted", async () => {
    await boot([term("t1", { turn: 100, labels: { "herdr.seen": "0" } })]);
    const turns = Array.from({ length: 30 }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
    const results = await Promise.all(turns.map((n) => seen("t1", n)));
    const ok = turns.filter((_, i) => results[i]!.status === 200);
    const written = writes().map(Number);
    for (let i = 1; i < written.length; i++) expect(written[i]!, `writes ${written.join(",")}`).toBeGreaterThan(written[i - 1]!);
    expect(Math.max(...written)).toBe(Math.max(...ok));
    expect(results.filter((r) => r.status !== 200).every((r) => r.status === 409)).toBe(true);
  });

  it("mark unread, wait for core's event, then seen at the turn: allowed, and written", async () => {
    await boot([term("t1", { turn: 5, labels: { "herdr.seen": "5" } })]);
    expect((await post("/api/ops/unread", { terminal: "t1" })).status).toBe(200);
    await labelEvent("t1", "4");
    expect((await seen("t1", 5)).status).toBe(200);
    expect(writes()).toEqual(["4", "5"]);
  });

  it("a failed write does not leave a floor: the same turn can be tried again at once", async () => {
    h.core.rpc.set("terminal.label", () => ({ error: { message: "core is busy" } }) as never);
    expect((await seen("t1", 5)).status).toBe(502);
    h.core.rpc.set("terminal.label", () => term("t1"));
    expect((await seen("t1", 5)).status).toBe(200);
  });

  it("a request refused by the bridge (below the floor, above the turn, on a finished terminal) leaves the floor where it was", async () => {
    expect((await seen("t1", 4)).status).toBe(200);
    expect((await seen("t1", 3)).status).toBe(409);
    expect((await seen("t1", 6)).status).toBe(409);
    expect((await seen("t1", 5)).status).toBe(200);
    expect(writes()).toEqual(["4", "5"]);
  });

  it("the memory is per terminal and per address: a remote terminal with the same number has its own", async () => {
    await boot([term("t1", { turn: 5, labels: { "herdr.seen": "0" } }), term("cachyos/t1", { turn: 5, labels: { "herdr.seen": "0" } })]);
    expect((await seen("t1", 5)).status).toBe(200);
    expect((await seen("cachyos/t1", 2)).status).toBe(200);
  });
});

describe("a start that core did, but answered too late (the page sees 504)", () => {
  it("the page is told in a sentence that says to look at the terminal list; the retry starts a second terminal (known, documented)", async () => {
    let started = 0;
    h.core.rpc.set("terminal.run", () => {
      started++;
      if (started === 1) h.core.muted = true; // core ran it, and its answer does not come
      return term("t7");
    });
    const first = await post("/api/ops/start", { machine: null, space: "sp", what: { kind: "shell" } });
    expect(first.status).toBe(504);
    expect(first.body.error).toMatch(/^Core did not answer/);
    h.core.muted = false;
    const second = await post("/api/ops/start", { machine: null, space: "sp", what: { kind: "shell" } });
    expect(second.status).toBe(200);
    expect(started).toBe(2); // two terminals: a person has to look, as PROTOCOL.md says
    const tabs = h.core.calls.filter((c) => c.method === "terminal.run").map((c) => (c.params as { labels: Record<string, string> }).labels["herdr.tab"]);
    expect(new Set(tabs).size).toBe(2);
  });

  it("a kill that timed out can be repeated: the repeat is refused as 409 once the terminal is seen to have ended, not another 504", async () => {
    h.core.rpc.set("terminal.kill", () => {
      h.core.muted = true;
      return term("t1", { state: "finished", reason: "killed" });
    });
    expect((await post("/api/ops/kill", { terminal: "t1" })).status).toBe(504);
    h.core.muted = false;
    h.core.event("finished", "t1", { reason: "killed", exit_code: null, signal: 1 });
    await until(() => h.session.store.get("t1")?.state === "finished", 2000);
    expect((await post("/api/ops/kill", { terminal: "t1" })).status).toBe(409);
  });
});

describe("core's own label after the page's write", () => {
  it("seen, core's event, then a person labels it lower with `hc label`: the page's next seen is judged by core's value, not by the memory ", async () => {
    expect((await seen("t1", 5)).status).toBe(200);
    await labelEvent("t1", "5");
    await labelEvent("t1", "1"); // `hc label t1 herdr.seen=1`
    const r = await seen("t1", 4);
    expect({ status: r.status, error: r.body.error }).toEqual({ status: 200, error: undefined });
    expect(writes()).toEqual(["5", "4"]);
  });

});
