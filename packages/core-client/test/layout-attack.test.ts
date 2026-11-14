// Tester's cases for DEV-22: how the session keeps layouts true — ordering, odd answers, machines coming and going.
// Tests under "defects" fail on the current product code; see the report on DEV-22.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoreSession, type MachineLayout, type SessionChange } from "../src/index.js";
import type { MachineView } from "../src/types.js";
import { FakeCore } from "./fake-core.js";
import { realShaped } from "./layout-fixture.js";
import { RawCore, type Call, type RawConn } from "./raw-core.js";

const machine = (name: string, state = "connected", why?: string): MachineView => ({ name, target: "x", id: name, host: "h", version: "1", state, ...(why && { why }) });
const doc = (...terminals: string[]) => ({
  spaces: [{ id: "s", name: "space", folder: "/", tabs: [{ id: "t", name: "tab", root: { id: "t", type: "row", children: terminals.map((t, i) => ({ id: `p${i}`, type: "block", content: { terminal: t } })) } }] }],
});
const panes = (l: MachineLayout | undefined) => l?.spaces.flatMap((s) => s.tabs.flatMap((t) => t.panes.map((p) => (p.kind === "terminal" ? p.terminal : `other:${p.mod}`)))) ?? [];

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let session: CoreSession | undefined;
afterEach(async () => {
  await session?.stop();
  session = undefined;
});
const newSession = (path: string, machinePollMs = 100) => (session = new CoreSession({ endpoint: () => path, backoff: { initialMs: 20, maxMs: 100 }, machinePollMs }));

describe("with a core that answers as the real one does", () => {
  let core: FakeCore;
  let changes: SessionChange[];
  beforeEach(async () => {
    core = new FakeCore();
    await core.listen();
    changes = [];
  });
  afterEach(async () => {
    await session?.stop();
    session = undefined;
    await core.dispose();
  });
  const start = (poll?: number) => {
    const s = newSession(core.path, poll);
    s.subscribe((c) => changes.push(c));
    s.start();
    return s;
  };

  it("a machine going unreachable shows as unavailable with core's reason, then comes back with its current document", async () => {
    core.machines = [machine("cachyos")];
    core.docs.set("cachyos", { value: doc("t1"), version: 1 });
    const s = start();
    await until(() => panes(s.layouts.get("cachyos")).length === 1);
    core.machines = [machine("cachyos", "unreachable", "ssh: connection refused")];
    await until(() => s.layouts.get("cachyos")?.status === "unavailable");
    expect(s.layouts.get("cachyos")).toEqual({ machine: "cachyos", status: "unavailable", reason: "machine unreachable: ssh: connection refused", version: null, spaces: [] });
    core.docs.set("cachyos", { value: doc("t1", "t2"), version: 2 }); // changed while it was away, no event reached us
    core.machines = [machine("cachyos")];
    await until(() => s.layouts.get("cachyos")?.status === "ok");
    expect(panes(s.layouts.get("cachyos"))).toEqual(["cachyos/t1", "cachyos/t2"]);
    expect(s.layouts.get("cachyos")!.version).toBe(2);
  });

  it("the core's own layout is untouched while a machine is unreachable", async () => {
    core.machines = [machine("cachyos", "unreachable", "down")];
    core.docs.set("", { value: realShaped, version: 3 });
    const s = start();
    await until(() => s.layouts.list().length === 2);
    expect(s.layouts.get(null)!.status).toBe("ok");
    expect(s.layouts.get("cachyos")!.status).toBe("unavailable");
  });

  it("every state that is not connected makes the layout unavailable, naming the state", async () => {
    core.machines = [machine("a", "connecting"), machine("b", "needs_login", "ssh key not accepted"), machine("c", "unreachable")];
    const s = start();
    await until(() => s.layouts.list().length === 4);
    expect(s.layouts.get("a")!.reason).toBe("machine connecting");
    expect(s.layouts.get("b")!.reason).toBe("machine needs_login: ssh key not accepted");
    expect(s.layouts.get("c")!.reason).toBe("machine unreachable");
    expect(core.docGets.filter((g) => g.on)).toEqual([]); // nobody asked an unconnected machine for a document
  });

  it("a machine that is added later gets its layout without waiting for an event", async () => {
    const s = start();
    await until(() => s.layouts.get(null) !== undefined);
    core.docs.set("new", { value: doc("t3"), version: 1 });
    core.machines = [machine("new")];
    await until(() => panes(s.layouts.get("new")).length === 1);
    expect(panes(s.layouts.get("new"))).toEqual(["new/t3"]);
  });

  it("a machine that is renamed is a new machine: the old layout goes, the new one appears", async () => {
    core.machines = [machine("old")];
    core.docs.set("old", { value: doc("t1"), version: 1 });
    core.docs.set("new", { value: doc("t1"), version: 1 });
    const s = start();
    await until(() => s.layouts.get("old")?.status === "ok");
    core.machines = [machine("new")];
    await until(() => s.layouts.get("new")?.status === "ok" && s.layouts.get("old") === undefined);
    expect(changes.filter((c) => c.type === "layout-removed")).toEqual([{ type: "layout-removed", machine: "old" }]);
  });

  it("after a reconnect, a machine that vanished meanwhile has no layout, and one that changed has the new one", async () => {
    core.machines = [machine("gone"), machine("stays")];
    core.docs.set("gone", { value: doc("t1"), version: 1 });
    core.docs.set("stays", { value: doc("t1"), version: 1 });
    const s = start();
    await until(() => s.layouts.list().length === 3);
    await core.stop();
    await until(() => s.state !== "connected");
    core.machines = [machine("stays")];
    core.docs.set("stays", { value: doc("t9"), version: 2 });
    await core.listen();
    await until(() => s.state === "connected" && s.layouts.get("gone") === undefined);
    await until(() => panes(s.layouts.get("stays"))[0] === "stays/t9");
    expect(s.layouts.list().map((l) => l.machine).sort()).toEqual([null, "stays"].sort());
  });

  it("layouts stay (with the connection reported as down) while core is away, and are corrected on return", async () => {
    core.docs.set("", { value: doc("t1"), version: 1 });
    const s = start();
    await until(() => panes(s.layouts.get(null)).length === 1);
    await core.stop();
    await until(() => s.state === "reconnecting");
    expect(panes(s.layouts.get(null))).toEqual(["t1"]);
    core.docs.set("", { value: doc("t5", "t6"), version: 4 });
    await core.listen();
    await until(() => panes(s.layouts.get(null)).length === 2);
    expect(s.state).toBe("connected");
  });

  it("`missed` re-reads every layout, including ones whose doc event was among those lost", async () => {
    core.machines = [machine("cachyos")];
    core.docs.set("", { value: doc("t1"), version: 1 });
    core.docs.set("cachyos", { value: doc("t1"), version: 1 });
    const s = start();
    await until(() => s.layouts.list().length === 2);
    core.docs.set("", { value: doc("t2"), version: 2 }); // written, and the event for it is not delivered
    core.docs.set("cachyos", { value: doc("t2"), version: 2 });
    core.raw("missed", { seq: core.seq + 5, terminals: [] });
    await until(() => panes(s.layouts.get(null))[0] === "t2" && panes(s.layouts.get("cachyos"))[0] === "cachyos/t2");
  });

  it("a doc event for a machine we do not know leaves no layout behind for long", async () => {
    const s = start();
    await until(() => s.layouts.get(null) !== undefined);
    core.event("doc", undefined, { name: "herdr-app", version: 1 }, "ghost");
    await sleep(300); // a few polls
    expect(s.layouts.get("ghost")).toBeUndefined();
    expect(s.layouts.list().map((l) => l.machine)).toEqual([null]);
  });

  it("odd answers to doc.get never throw and never leave the old layout in place", async () => {
    core.docs.set("", { value: doc("t1"), version: 1 });
    const s = start();
    await until(() => s.layouts.get(null)?.status === "ok");
    const odd: Array<[string, unknown]> = [
      ["a string", "spaces"],
      ["a number", 7],
      ["a list", []],
      ["true", true],
      ["spaces not a list", { spaces: {} }],
      ["a space that is null", { spaces: [null] }],
      ["tabs that are null elements", { spaces: [{ tabs: [null] }] }],
      ["a root that is null", { spaces: [{ tabs: [{ root: null }] }] }],
      ["a block that is null", { spaces: [{ tabs: [{ root: { type: "row", children: [null] } }] }] }],
      ["children that is a string", { spaces: [{ tabs: [{ root: { type: "row", children: "p1" } }] }] }],
      ["a terminal that is a number", { spaces: [{ tabs: [{ root: { type: "block", content: { terminal: 5 } } }] }] }],
      ["content null", { spaces: [{ tabs: [{ root: { type: "block", content: null } }] }] }],
    ];
    let version = 1;
    for (const [name, value] of odd) {
      core.setDoc(value);
      version += 1;
      await until(() => s.layouts.get(null)?.version === version, 2000).catch(() => {
        throw new Error(`${name}: layout never updated`);
      });
      const l = s.layouts.get(null)!;
      expect(l.status, name).toBe("unavailable");
      expect(l.reason, name).toMatch(/\w/);
      expect(l.spaces, name).toEqual([]);
    }
    core.setDoc(doc("t8"));
    await until(() => panes(s.layouts.get(null))[0] === "t8");
    expect(s.layouts.get(null)!.status).toBe("ok");
  });

  it("an answer with no value or no version is read as far as it can be", async () => {
    core.docs.set("", {} as never);
    const s = start();
    await until(() => s.layouts.get(null) !== undefined);
    const l = s.layouts.get(null)!;
    expect(["empty", "unavailable"]).toContain(l.status);
    expect(l.version).toBeNull();
    expect(l.spaces).toEqual([]);
  });

  it("listeners hear one layout change per real change, and none when a re-read finds the same document", async () => {
    core.machines = [machine("cachyos")];
    core.docs.set("cachyos", { value: doc("t1"), version: 1 });
    const s = start(30);
    await until(() => s.layouts.get("cachyos")?.status === "ok");
    changes.length = 0;
    await sleep(400); // many polls, nothing changed
    expect(changes.filter((c) => c.type === "layout")).toEqual([]);
    core.setDoc(doc("t2"), "cachyos");
    await until(() => changes.some((c) => c.type === "layout"));
    await sleep(100);
    expect(changes.filter((c) => c.type === "layout")).toHaveLength(1);
  });
});

describe("with replies held back", () => {
  let core: RawCore;
  let held: Array<{ conn: RawConn; call: Call }>;
  let inFlight: Map<string, number>;
  let maxInFlight: Map<string, number>;
  let current: Map<string, { value: unknown; version: number }>;
  beforeEach(async () => {
    core = new RawCore();
    await core.listen();
    held = [];
    inFlight = new Map();
    maxInFlight = new Map();
    current = new Map();
  });
  afterEach(async () => {
    await session?.stop();
    session = undefined;
    await core.dispose();
  });
  const hold = () => {
    core.onCall = (conn, call) => {
      if (call.method !== "doc.get") return core.defaultCall(conn, call);
      const on = (call.params as { on?: string }).on ?? "";
      const n = (inFlight.get(on) ?? 0) + 1;
      inFlight.set(on, n);
      maxInFlight.set(on, Math.max(maxInFlight.get(on) ?? 0, n));
      // what the document is when the call arrives is what it answers with, whenever it is released
      const answer = current.get(on) ?? { value: null, version: 0 };
      held.push({
        conn,
        call: { ...call, params: { ...(call.params as object), answer } },
      });
    };
  };
  const release = (i = 0) => {
    const [h] = held.splice(i, 1);
    const p = h!.call.params as { on?: string; answer: unknown };
    inFlight.set(p.on ?? "", (inFlight.get(p.on ?? "") ?? 1) - 1);
    h!.conn.reply(h!.call.id, p.answer);
  };

  it("a document written between the snapshot and the first read is not lost: the last word wins", async () => {
    hold();
    core.seq = 5;
    current.set("", { value: doc("old"), version: 1 });
    const s = newSession(core.path);
    s.start();
    await until(() => held.length === 1); // the first read is out, its answer is the old document
    current.set("", { value: doc("new"), version: 2 });
    core.last.event(6, "doc", undefined, { name: "herdr-app", version: 2 }); // the write's event arrives while the read is out
    await sleep(50);
    expect(held).toHaveLength(1); // one read at a time: the second waits
    release();
    await until(() => held.length === 1); // the second read starts after the first ends
    expect(s.layouts.get(null)!.version).toBe(1);
    release();
    await until(() => s.layouts.get(null)?.version === 2);
    expect(panes(s.layouts.get(null))).toEqual(["new"]);
    expect(maxInFlight.get("")).toBe(1);
  });

  it("a flurry of events makes at most one read behind the one running, and ends with the newest", async () => {
    hold();
    current.set("", { value: doc("a"), version: 1 });
    const s = newSession(core.path);
    s.start();
    await until(() => held.length === 1);
    for (let v = 2; v <= 40; v++) {
      current.set("", { value: doc(`v${v}`), version: v });
      core.last.event(100 + v, "doc", undefined, { name: "herdr-app", version: v });
    }
    await sleep(100);
    release();
    await until(() => held.length === 1);
    release();
    await until(() => s.layouts.get(null)?.version === 40);
    await sleep(100);
    expect(held).toHaveLength(0);
    expect(panes(s.layouts.get(null))).toEqual(["v40"]);
    expect(maxInFlight.get("")).toBe(1);
  });

  it("a read still out when the connection drops does not write into the layouts afterwards", async () => {
    hold();
    current.set("", { value: doc("before"), version: 1 });
    const s = newSession(core.path);
    s.start();
    await until(() => held.length === 1);
    const old = held[0]!;
    core.connections.at(-1)!.destroy(); // the connection ends with the read out
    current.set("", { value: doc("after"), version: 2 }); // before the new connection's read arrives
    held.length = 0;
    inFlight.clear();
    await until(() => core.connections.length >= 2); // reconnected
    await until(() => held.length >= 1);
    expect(old.conn.socket.destroyed).toBe(true); // its answer can never arrive
    release(held.length - 1);
    await until(() => panes(s.layouts.get(null))[0] === "after");
    await sleep(50);
    expect(panes(s.layouts.get(null))).toEqual(["after"]);
  });

  it("two machines are read side by side, and a slow one does not hold the other's layout back", async () => {
    hold();
    core.machines = [machine("slow"), machine("fast")];
    current.set("slow", { value: doc("s1"), version: 1 });
    current.set("fast", { value: doc("f1"), version: 1 });
    const s = newSession(core.path);
    s.start();
    await until(() => held.length === 3); // core, slow, fast
    const idx = (on: string) => held.findIndex((h) => ((h.call.params as { on?: string }).on ?? "") === on);
    release(idx("fast"));
    await until(() => s.layouts.get("fast")?.status === "ok");
    expect(s.layouts.get("slow")).toBeUndefined();
    release(idx("slow"));
    release(idx(""));
    await until(() => s.layouts.list().length === 3);
  });
});

describe("defects", () => {
  let core: FakeCore;
  beforeEach(async () => {
    core = new FakeCore();
    await core.listen();
  });
  afterEach(async () => {
    await session?.stop();
    session = undefined;
    await core.dispose();
  });

  it("a doc.get that failed once on a machine that stays connected is tried again by the next poll", async () => {
    core.machines = [machine("cachyos")];
    core.docs.set("cachyos", { value: doc("t1"), version: 1 });
    core.docErrors.set("cachyos", "timed out");
    const s = newSession(core.path, 50);
    s.start();
    await until(() => s.layouts.get("cachyos")?.status === "unavailable");
    core.docErrors.delete("cachyos"); // the machine answers again; its state never left `connected`
    await until(() => s.layouts.get("cachyos")?.status === "ok", 2000);
  });

  it("a doc.get that failed once on the core itself is tried again by the next poll", async () => {
    core.docs.set("", { value: doc("t1"), version: 1 });
    core.docErrors.set("", "internal error");
    const s = newSession(core.path, 50);
    s.start();
    await until(() => s.layouts.get(null)?.status === "unavailable");
    core.docErrors.delete("");
    await until(() => s.layouts.get(null)?.status === "ok", 2000);
  });
});
