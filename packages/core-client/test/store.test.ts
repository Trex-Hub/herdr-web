import { beforeEach, describe, expect, it } from "vitest";
import { TerminalStore } from "../src/store.js";
import type { Terminal, TerminalEvent } from "../src/types.js";

function term(address: string, extra: Partial<Terminal> = {}): Terminal {
  return {
    address,
    argv: ["sh"],
    cols: 80,
    rows: 24,
    created_ms: 1,
    cwd: "/",
    state: "live",
    screen: "exact",
    labels: {},
    pid: 100,
    foreground: { pid: 100, name: "sh", argv: ["sh"], cwd: "/" },
    turn: 0,
    title: "",
    ...extra,
  };
}

let store: TerminalStore;
let seq: number;

/** Apply an event with the next seq. */
function ev<T extends TerminalEvent["type"]>(
  type: T,
  terminal: string | undefined,
  data: Extract<TerminalEvent, { type: T }>["data"],
  extra: { machine?: string } = {},
): boolean {
  seq += 1;
  return store.applyEvent({ seq, type, terminal, data, ...extra } as TerminalEvent);
}

beforeEach(() => {
  store = new TerminalStore();
  seq = 10;
  store.replaceSnapshot(10, [term("t1"), term("t2"), term("cachyos/t7")]);
});

describe("snapshot", () => {
  it("holds every terminal in core's order, including those on added machines", () => {
    expect(store.list().map((t) => t.address)).toEqual(["t1", "t2", "cachyos/t7"]);
    expect(store.seq).toBe(10);
  });

  it("keeps the machine list beside the terminals", () => {
    const machines = [{ name: "cachyos", target: "x", id: "i", host: "h", version: "1", state: "connected" }];
    store.setMachines(machines);
    expect(store.machines).toEqual(machines);
  });

  it("ignores events before any snapshot", () => {
    const fresh = new TerminalStore();
    expect(fresh.applyEvent({ seq: 1, type: "created", terminal: "t1", data: term("t1") })).toBe(false);
    expect(fresh.list()).toEqual([]);
  });
});

describe("event table", () => {
  it("created: adds the record", () => {
    expect(ev("created", "t3", term("t3", { title: "new" }))).toBe(true);
    expect(store.get("t3")?.title).toBe("new");
    expect(store.list()).toHaveLength(4);
  });

  it("created: replaces a record already held (a machine's line came back)", () => {
    ev("created", "cachyos/t7", term("cachyos/t7", { title: "again" }), { machine: "cachyos" });
    expect(store.list()).toHaveLength(3);
    expect(store.get("cachyos/t7")?.title).toBe("again");
  });

  it("lost: sets the reason and exit fields, clears pid, drops foreground, stays live", () => {
    ev("lost", "t1", { reason: "signaled", exit_code: null, signal: 9, finished_ms: null });
    expect(store.get("t1")).toMatchObject({ state: "live", reason: "signaled", signal: 9, exit_code: null, finished_ms: null });
    expect(store.get("t1")).not.toHaveProperty("pid");
    expect(store.get("t1")).not.toHaveProperty("foreground");
  });

  it("restarted: replaces the record", () => {
    ev("restarted", "t1", term("t1", { pid: 999, title: "fresh shell", keep: true }));
    expect(store.get("t1")).toMatchObject({ pid: 999, title: "fresh shell", keep: true });
  });

  it("keep: sets keep", () => {
    ev("keep", "t1", { keep: true });
    expect(store.get("t1")?.keep).toBe(true);
    ev("keep", "t1", { keep: false });
    expect(store.get("t1")?.keep).toBe(false);
  });

  it("finished: sets state, reason, exit fields and finished_ms; drops foreground", () => {
    ev("finished", "t1", { reason: "exited", exit_code: 3, signal: null, finished_ms: 555 });
    expect(store.get("t1")).toMatchObject({ state: "finished", reason: "exited", exit_code: 3, signal: null, finished_ms: 555 });
    expect(store.get("t1")).not.toHaveProperty("foreground");
    expect(store.get("t2")?.state).toBe("live");
  });

  it("removed: drops the terminal", () => {
    ev("removed", "t2", {});
    expect(store.list().map((t) => t.address)).toEqual(["t1", "cachyos/t7"]);
  });

  it("removed: drops a terminal on an added machine by its full address", () => {
    ev("removed", "cachyos/t7", {}, { machine: "cachyos" });
    expect(store.get("cachyos/t7")).toBeUndefined();
  });

  it("status: replaces status, records and reported", () => {
    const working = { state: "working", msg: "thinking" };
    ev("status", "t1", { status: working, records: { main: working }, reported: true });
    expect(store.get("t1")).toMatchObject({ status: working, records: { main: working }, reported: true });
    ev("status", "t1", { status: null, records: {}, reported: true });
    expect(store.get("t1")).toMatchObject({ status: null, records: {}, reported: true });
  });

  it("turn: sets turn", () => {
    ev("turn", "t1", { turn: 4, state: "done" });
    expect(store.get("t1")?.turn).toBe(4);
  });

  it("title: sets title", () => {
    ev("title", "t1", { title: "vim" });
    expect(store.get("t1")?.title).toBe("vim");
  });

  it("labels: replaces all labels", () => {
    store.replaceSnapshot(10, [term("t1", { labels: { a: "1", b: "2" } })]);
    ev("labels", "t1", { labels: { c: "3" } });
    expect(store.get("t1")?.labels).toEqual({ c: "3" });
  });

  it("labels: with a record, adds the whole record", () => {
    ev("labels", "t9", { labels: { a: "1" }, record: term("t9", { labels: { a: "1" } }) });
    expect(store.get("t9")?.labels).toEqual({ a: "1" });
  });

  it("size: sets cols and rows", () => {
    ev("size", "t1", { cols: 120, rows: 40 });
    expect(store.get("t1")).toMatchObject({ cols: 120, rows: 40 });
  });

  it("foreground: sets what runs now, and null clears it", () => {
    const fg = { pid: 7, name: "vim", argv: ["vim", "a"], cwd: "/tmp" };
    ev("foreground", "t1", fg);
    expect(store.get("t1")?.foreground).toEqual(fg);
    ev("foreground", "t1", null);
    expect(store.get("t1")?.foreground).toBeNull();
  });

  it("applies events to terminals on added machines", () => {
    ev("title", "cachyos/t7", { title: "remote" }, { machine: "cachyos" });
    expect(store.get("cachyos/t7")?.title).toBe("remote");
  });

  it("leaves other terminals untouched, and replaces rather than mutates the record", () => {
    const before = store.get("t1")!;
    const other = store.get("t2");
    ev("title", "t1", { title: "x" });
    expect(before.title).toBe("");
    expect(store.get("t2")).toBe(other);
  });

  it("advances seq, also past events it does not act on (doc, unknown terminal)", () => {
    expect(ev("doc", undefined, { name: "herdr-app", version: 2 })).toBe(false);
    expect(store.seq).toBe(11);
    expect(ev("title", "t404", { title: "x" })).toBe(false);
    expect(store.seq).toBe(12);
  });
});

describe("seq and missed", () => {
  it("drops events whose seq is not above the snapshot's", () => {
    expect(store.applyEvent({ seq: 10, type: "title", terminal: "t1", data: { title: "old" } })).toBe(false);
    expect(store.applyEvent({ seq: 3, type: "title", terminal: "t1", data: { title: "older" } })).toBe(false);
    expect(store.get("t1")?.title).toBe("");
    expect(store.seq).toBe(10);
  });

  it("missed: replaces its contents with the new snapshot", () => {
    store.applyMissed(57, [term("t5"), term("t6")]);
    expect(store.list().map((t) => t.address)).toEqual(["t5", "t6"]);
    expect(store.seq).toBe(57);
  });

  it("missed: then drops events at or below the snapshot seq and applies later ones", () => {
    store.applyMissed(57, [term("t5")]);
    expect(store.applyEvent({ seq: 57, type: "title", terminal: "t5", data: { title: "stale" } })).toBe(false);
    expect(store.applyEvent({ seq: 40, type: "removed", terminal: "t5", data: {} })).toBe(false);
    expect(store.get("t5")?.title).toBe("");
    expect(store.applyEvent({ seq: 58, type: "title", terminal: "t5", data: { title: "fresh" } })).toBe(true);
    expect(store.get("t5")?.title).toBe("fresh");
  });

  it("a fresh snapshot from a restarted core resets seq to a lower number", () => {
    store.replaceSnapshot(2, [term("t1")]);
    expect(store.seq).toBe(2);
    expect(store.applyEvent({ seq: 3, type: "title", terminal: "t1", data: { title: "ok" } })).toBe(true);
  });
});
