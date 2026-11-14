// The age shown next to an agent is `status_ms`: when its state last changed. Core's list carries
// it; the event stream does not, so the store stamps it. These checks hold the stamp to what the
// list would say.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalStore } from "../src/store.js";
import type { Terminal, TerminalEvent } from "../src/types.js";

const NOW = 1_800_000_000_000;

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

function status(address: string, state: string | null, extra: Record<string, unknown> = {}): void {
  seq += 1;
  store.applyEvent({
    seq,
    type: "status",
    terminal: address,
    data: { status: state === null ? null : { state, ...extra }, records: {}, reported: true },
  } as TerminalEvent);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  store = new TerminalStore();
  seq = 10;
  store.replaceSnapshot(10, [term("t1"), term("t2", { status: { state: "working" }, status_ms: NOW - 600_000 })]);
});
afterEach(() => vi.useRealTimers());

const age = (a: string) => store.get(a)?.status_ms;

describe("status_ms stamped from events", () => {
  it("a first status is stamped now; the same state again, with another message, kind or progress, keeps it", () => {
    status("t1", "blocked", { kind: "permission", msg: "a" });
    expect(age("t1")).toBe(NOW);
    vi.setSystemTime(NOW + 60_000);
    status("t1", "blocked", { kind: "question", msg: "b", progress: 5 });
    status("t1", "blocked", { kind: "question", msg: "c", progress: 6, app: "pi" });
    expect(age("t1")).toBe(NOW);
  });

  it("a state change is stamped at the change, and changing back is a change", () => {
    status("t1", "working");
    vi.setSystemTime(NOW + 10_000);
    status("t1", "idle");
    expect(age("t1")).toBe(NOW + 10_000);
    vi.setSystemTime(NOW + 20_000);
    status("t1", "working");
    expect(age("t1")).toBe(NOW + 20_000);
  });

  it("a state seen in the list before the event keeps core's time, not ours", () => {
    status("t2", "working", { msg: "still" });
    expect(age("t2")).toBe(NOW - 600_000);
  });

  it("clearing the status clears the time; the same state after a clear is a fresh start", () => {
    status("t2", null);
    expect(age("t2")).toBeNull();
    vi.setSystemTime(NOW + 5_000);
    status("t2", "working");
    expect(age("t2")).toBe(NOW + 5_000);
  });

  it("clearing twice stays null; clearing a terminal that never had a status stays null", () => {
    status("t1", null);
    status("t2", null);
    status("t2", null);
    expect(age("t1")).toBeNull();
    expect(age("t2")).toBeNull();
  });

  it("other events leave the time alone", () => {
    seq += 1;
    store.applyEvent({ seq, type: "turn", terminal: "t2", data: { turn: 3, state: "done" } } as TerminalEvent);
    seq += 1;
    store.applyEvent({ seq, type: "title", terminal: "t2", data: { title: "x" } } as TerminalEvent);
    seq += 1;
    store.applyEvent({ seq, type: "labels", terminal: "t2", data: { labels: { "herdr.seen": "3" } } } as TerminalEvent);
    expect(age("t2")).toBe(NOW - 600_000);
  });

  it("a `labels` event carrying a whole record, or `created`/`restarted`, brings core's own time", () => {
    seq += 1;
    store.applyEvent({
      seq,
      type: "labels",
      terminal: "t2",
      data: { labels: {}, record: term("t2", { status: { state: "idle" }, status_ms: 123 }) },
    } as TerminalEvent);
    expect(age("t2")).toBe(123);
    seq += 1;
    store.applyEvent({ seq, type: "restarted", terminal: "t2", data: term("t2") } as TerminalEvent);
    expect(age("t2")).toBeUndefined();
  });

  it("a lost status event (seq at or below the snapshot) does not restamp", () => {
    store.applyEvent({ seq: 9, type: "status", terminal: "t2", data: { status: { state: "idle" }, records: {}, reported: true } } as TerminalEvent);
    expect(age("t2")).toBe(NOW - 600_000);
    expect(store.get("t2")?.status?.state).toBe("working");
  });

  it("`missed` takes core's times again: what the list says wins over what we stamped", () => {
    status("t1", "working");
    expect(age("t1")).toBe(NOW);
    store.applyMissed(50, [term("t1", { status: { state: "working" }, status_ms: NOW - 1_000_000 })]);
    expect(age("t1")).toBe(NOW - 1_000_000);
    // and later events carry on from there
    vi.setSystemTime(NOW + 1000);
    status("t1", "working", { msg: "x" });
    expect(age("t1")).toBe(NOW - 1_000_000);
  });

  it("the state is compared as given: a different case is a different state (core always sends lower case)", () => {
    status("t1", "working");
    vi.setSystemTime(NOW + 1000);
    status("t1", "Working");
    // documents today's behaviour rather than a rule
    expect(age("t1")).toBe(NOW + 1000);
  });

  describe("a list without times", () => {
    it("the first event of the same state stamps now; the next one keeps that stamp", () => {
      // snapshot says: working, but no time (older core). The first event of the same state stamps
      // `now`, which is the time of the event, not of the change. That is accepted; the second must keep it.
      store.replaceSnapshot(20, [term("t3", { status: { state: "working" }, status_ms: null })]);
      seq = 20;
      status("t3", "working");
      const first = age("t3");
      vi.setSystemTime(NOW + 99_000);
      status("t3", "working", { msg: "again" });
      expect(age("t3")).toBe(first);
    });
  });
});
