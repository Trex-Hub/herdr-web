// Tester's cases for DEV-21: the event table of the herdr-core API doc, checked against whole records.
import { beforeEach, describe, expect, it } from "vitest";
import { TerminalStore } from "../src/store.js";
import type { Terminal, TerminalEvent } from "../src/types.js";

const fg = { pid: 100, name: "sh", argv: ["sh"], cwd: "/" };

function full(address: string, extra: Partial<Terminal> = {}): Terminal {
  return {
    address,
    argv: ["sh"],
    cols: 80,
    rows: 24,
    created_ms: 1,
    cwd: "/",
    state: "live",
    screen: "exact",
    labels: { keep: "me" },
    pid: 100,
    foreground: fg,
    keep: false,
    reason: null,
    exit_code: null,
    signal: null,
    finished_ms: null,
    status: { state: "working" },
    records: { main: { state: "working" } },
    reported: true,
    turn: 2,
    title: "title",
    name: "n",
    ...extra,
  };
}

let store: TerminalStore;
let seq: number;

function ev<T extends TerminalEvent["type"]>(type: T, terminal: string | undefined, data: Extract<TerminalEvent, { type: T }>["data"]): boolean {
  seq += 1;
  return store.applyEvent({ seq, type, terminal, data } as TerminalEvent);
}

function without<T extends object>(o: T, ...keys: string[]): Partial<T> {
  const copy = { ...o } as Record<string, unknown>;
  for (const k of keys) delete copy[k];
  return copy as Partial<T>;
}

beforeEach(() => {
  store = new TerminalStore();
  seq = 10;
  store.replaceSnapshot(10, [full("t1"), full("t2"), full("cachyos/t7")]);
});

describe("event table, whole records", () => {
  it("lost: changes only reason, exit_code, signal, finished_ms, pid and foreground", () => {
    const before = store.get("t1")!;
    ev("lost", "t1", { reason: "signaled", exit_code: null, signal: 9, finished_ms: null });
    expect(store.get("t1")).toEqual({ ...without(before, "pid", "foreground"), reason: "signaled", exit_code: null, signal: 9, finished_ms: null });
    expect(store.get("t1")?.state).toBe("live");
  });

  it("lost: sets exit_code and finished_ms when the event carries them, state stays live", () => {
    ev("lost", "t1", { reason: "exited", exit_code: 2, signal: null, finished_ms: null });
    expect(store.get("t1")).toMatchObject({ state: "live", reason: "exited", exit_code: 2, finished_ms: null });
  });

  it("lost then restarted: the new record replaces the lost one, pid and foreground are back", () => {
    ev("lost", "t1", { reason: "signaled", exit_code: null, signal: 9, finished_ms: null });
    const fresh = full("t1", { pid: 555, foreground: { ...fg, pid: 555 }, reason: null, signal: null, keep: true });
    ev("restarted", "t1", fresh);
    expect(store.get("t1")).toEqual(fresh);
  });

  it("lost on a record that has no pid or foreground adds neither key", () => {
    store.replaceSnapshot(10, [without(full("t1"), "pid", "foreground") as Terminal]);
    ev("lost", "t1", { reason: "signaled", exit_code: null, signal: 9, finished_ms: null });
    expect(store.get("t1")).not.toHaveProperty("pid");
    expect(store.get("t1")).not.toHaveProperty("foreground");
  });

  it("finished after a status clear: ends live with status null, keeps its other fields, drops foreground", () => {
    ev("status", "t1", { status: null, records: {}, reported: true });
    ev("finished", "t1", { reason: "exited", exit_code: 0, signal: null, finished_ms: 1234 });
    const t = store.get("t1")!;
    expect(t).toMatchObject({ state: "finished", reason: "exited", exit_code: 0, signal: null, finished_ms: 1234, status: null, records: {}, reported: true });
    expect(t).not.toHaveProperty("foreground");
    expect(t).toMatchObject({ title: "title", turn: 2, labels: { keep: "me" }, name: "n", cols: 80 });
  });

  it("finished: records the signal and reason when killed", () => {
    ev("finished", "t1", { reason: "killed", exit_code: null, signal: 1, finished_ms: 99 });
    expect(store.get("t1")).toMatchObject({ state: "finished", reason: "killed", exit_code: null, signal: 1, finished_ms: 99 });
  });

  it("finished on a terminal already lost (no pid): still becomes finished", () => {
    ev("lost", "t1", { reason: "signaled", exit_code: null, signal: 9, finished_ms: null });
    ev("finished", "t1", { reason: "killed", exit_code: null, signal: 1, finished_ms: 77 });
    expect(store.get("t1")).toMatchObject({ state: "finished", reason: "killed", finished_ms: 77 });
  });

  it("status: replaces status, records and reported together, whatever was there", () => {
    const idle = { state: "idle", app: "claude" };
    ev("status", "t1", { status: idle, records: { a: idle, b: { state: "blocked" } }, reported: true });
    expect(store.get("t1")).toMatchObject({ status: idle, records: { a: idle, b: { state: "blocked" } }, reported: true });
    ev("status", "t1", { status: null, records: {}, reported: false });
    expect(store.get("t1")).toMatchObject({ status: null, records: {}, reported: false });
  });

  it("labels: an empty label set clears all labels", () => {
    ev("labels", "t1", { labels: {} });
    expect(store.get("t1")?.labels).toEqual({});
  });

  it("labels with a record: the record replaces what is held, field by field", () => {
    const record = full("t1", { labels: { new: "1" }, title: "from record", cols: 100 });
    ev("labels", "t1", { labels: { new: "1" }, record });
    expect(store.get("t1")).toEqual(record);
  });

  it("labels without a record for a terminal not held: nothing is created", () => {
    expect(ev("labels", "t99", { labels: { a: "b" } })).toBe(false);
    expect(store.get("t99")).toBeUndefined();
  });

  it("title, turn, keep, size: change their own fields and nothing else", () => {
    const before = store.get("t1")!;
    ev("title", "t1", { title: "new" });
    ev("turn", "t1", { turn: 9, state: "done" });
    ev("keep", "t1", { keep: true });
    ev("size", "t1", { cols: 132, rows: 43 });
    expect(store.get("t1")).toEqual({ ...before, title: "new", turn: 9, keep: true, cols: 132, rows: 43 });
  });

  it("foreground: replaces what runs now", () => {
    const vim = { pid: 7, name: "vim", argv: ["vim"], cwd: "/src" };
    ev("foreground", "t1", vim);
    expect(store.get("t1")?.foreground).toEqual(vim);
  });

  it("removed: drops only that terminal, and a second removed changes nothing", () => {
    expect(ev("removed", "t1", {})).toBe(true);
    expect(ev("removed", "t1", {})).toBe(false);
    expect(store.list().map((t) => t.address)).toEqual(["t2", "cachyos/t7"]);
  });

  it("removed with no terminal named drops nothing", () => {
    expect(ev("removed", undefined, {})).toBe(false);
    expect(store.list()).toHaveLength(3);
  });

  it("a remote terminal and a local one with the same number are different terminals", () => {
    store.replaceSnapshot(10, [full("t7", { title: "local" }), full("cachyos/t7", { title: "remote" })]);
    ev("title", "cachyos/t7", { title: "remote changed" });
    ev("removed", "t7", {});
    expect(store.list().map((t) => [t.address, t.title])).toEqual([["cachyos/t7", "remote changed"]]);
  });

  it("created: a terminal added later is listed after those from the snapshot, a re-created one keeps its place", () => {
    ev("created", "t3", full("t3"));
    ev("created", "t1", full("t1", { title: "again" }));
    expect(store.list().map((t) => t.address)).toEqual(["t1", "t2", "cachyos/t7", "t3"]);
    expect(store.get("t1")?.title).toBe("again");
  });

  it("an event type from a newer core leaves the terminal alone and still advances seq", () => {
    const before = store.get("t1");
    expect(store.applyEvent({ seq: 11, type: "from-the-future", terminal: "t1", data: { x: 1 } } as unknown as TerminalEvent)).toBe(false);
    expect(store.get("t1")).toBe(before);
    expect(store.seq).toBe(11);
  });

  it("the same event delivered twice is applied once", () => {
    const e = { seq: 11, type: "created", terminal: "t3", data: full("t3") } as TerminalEvent;
    expect(store.applyEvent(e)).toBe(true);
    seq = 11;
    ev("removed", "t3", {}); // seq 12
    expect(store.applyEvent(e)).toBe(false);
    expect(store.get("t3")).toBeUndefined();
  });

  it("a gap in seq is applied, not treated as an error", () => {
    expect(store.applyEvent({ seq: 15, type: "title", terminal: "t1", data: { title: "gap" } })).toBe(true);
    expect(store.seq).toBe(15);
  });
});

describe("missed", () => {
  it("replaces terminals that changed or vanished meanwhile, keeps the machine list", () => {
    store.setMachines([{ name: "cachyos", target: "x", id: "i", host: "h", version: "1", state: "connected" }]);
    store.applyMissed(40, [full("t2", { title: "changed" }), full("t8")]);
    expect(store.list().map((t) => [t.address, t.title])).toEqual([
      ["t2", "changed"],
      ["t8", "title"],
    ]);
    expect(store.machines).toHaveLength(1);
  });

  it("a snapshot with a lower seq than before (new core process) takes over", () => {
    store.applyMissed(3, [full("t1")]);
    expect(store.seq).toBe(3);
    expect(ev("title", "t1", { title: "next" })).toBe(true);
  });
});
