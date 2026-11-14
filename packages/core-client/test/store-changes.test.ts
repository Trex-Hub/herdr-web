import { describe, expect, it } from "vitest";
import { TerminalStore, type StoreChange } from "../src/store.js";
import type { Terminal } from "../src/types.js";

const term = (address: string, extra: Partial<Terminal> = {}): Terminal => ({
  address, argv: ["sh"], cols: 80, rows: 24, created_ms: 1, cwd: "/", state: "live", screen: "exact", labels: {}, ...extra,
});

function watch(store: TerminalStore): StoreChange[] {
  const seen: StoreChange[] = [];
  store.subscribe((c) => seen.push(c));
  return seen;
}

describe("store changes", () => {
  it("announces each applied event with the resulting record, and removals", () => {
    const store = new TerminalStore();
    store.replaceSnapshot(1, [term("t1")]);
    const seen = watch(store);
    store.applyEvent({ seq: 2, type: "created", terminal: "t2", data: term("t2") });
    store.applyEvent({ seq: 3, type: "labels", terminal: "t2", data: { labels: { a: "b" } } });
    store.applyEvent({ seq: 4, type: "finished", terminal: "t1", data: { reason: "killed", exit_code: null, signal: 1, finished_ms: 5 } });
    store.applyEvent({ seq: 5, type: "removed", terminal: "t2", data: {} });
    expect(seen.map((c) => (c.type === "terminal" ? [c.type, c.terminal.address, c.terminal.labels, c.terminal.state] : [c.type, (c as { address: string }).address]))).toEqual([
      ["terminal", "t2", {}, "live"],
      ["terminal", "t2", { a: "b" }, "live"],
      ["terminal", "t1", {}, "finished"],
      ["terminal-removed", "t2"],
    ]);
  });

  it("says nothing for events it did not apply (stale seq, unknown terminal, doc)", () => {
    const store = new TerminalStore();
    store.replaceSnapshot(10, [term("t1")]);
    const seen = watch(store);
    store.applyEvent({ seq: 10, type: "title", terminal: "t1", data: { title: "old" } });
    store.applyEvent({ seq: 11, type: "title", terminal: "t404", data: { title: "x" } });
    store.applyEvent({ seq: 12, type: "doc", data: { name: "herdr-app", version: 1 } });
    store.applyEvent({ seq: 13, type: "removed", terminal: "t404", data: {} });
    expect(seen).toEqual([]);
  });

  it("a new snapshot announces only what differs from what was held", () => {
    const store = new TerminalStore();
    store.replaceSnapshot(5, [term("t1"), term("t2"), term("t3")]);
    const seen = watch(store);
    store.applyMissed(9, [term("t1"), term("t2", { title: "changed" }), term("t4")]);
    expect(seen).toEqual([
      { type: "terminal", terminal: term("t2", { title: "changed" }) },
      { type: "terminal", terminal: term("t4") },
      { type: "terminal-removed", address: "t3" },
    ]);
  });

  it("announces the machine list only when it changes", () => {
    const store = new TerminalStore();
    const seen = watch(store);
    const m = { name: "a", target: "x", id: "i", host: "h", version: "1", state: "connected" };
    store.setMachines([m]);
    store.setMachines([{ ...m }]);
    store.setMachines([{ ...m, state: "unreachable" }]);
    expect(seen.map((c) => c.type)).toEqual(["machines", "machines"]);
  });

  it("a throwing listener does not stop the others or the store", () => {
    const store = new TerminalStore();
    store.subscribe(() => {
      throw new Error("boom");
    });
    const seen = watch(store);
    store.replaceSnapshot(1, [term("t1")]);
    expect(seen).toHaveLength(1);
    expect(store.get("t1")).toBeDefined();
  });

  it("unsubscribe stops notifications", () => {
    const store = new TerminalStore();
    const seen: StoreChange[] = [];
    const off = store.subscribe((c) => seen.push(c));
    off();
    store.replaceSnapshot(1, [term("t1")]);
    expect(seen).toEqual([]);
  });
});
