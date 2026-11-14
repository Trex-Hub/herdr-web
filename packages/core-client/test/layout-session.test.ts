import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoreSession, type MachineLayout, type SessionChange } from "../src/index.js";
import type { MachineView, Terminal } from "../src/types.js";
import { FakeCore } from "./fake-core.js";
import { realShaped } from "./layout-fixture.js";

const machine = (name: string, state = "connected"): MachineView => ({ name, target: "x", id: name, host: "h", version: "1", state });
const term = (address: string): Terminal => ({ address, argv: ["sh"], cols: 80, rows: 24, created_ms: 1, cwd: "/", state: "live", screen: "exact", labels: {} });
const doc = (terminal: string) => ({ spaces: [{ id: "s", name: "space", folder: "/", tabs: [{ id: "t", name: "tab", root: { id: "t", type: "row", children: [{ id: "p", type: "block", content: { terminal } }] } }] }] });

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}
const paneOf = (l: MachineLayout | undefined) => (l?.spaces[0]?.tabs[0]?.panes[0] as { terminal?: string } | undefined)?.terminal;

let core: FakeCore;
let session: CoreSession;
let changes: SessionChange[];

beforeEach(async () => {
  core = new FakeCore();
  await core.listen();
  changes = [];
});
afterEach(async () => {
  await session?.stop();
  await core.dispose();
});

function start(): CoreSession {
  session = new CoreSession({ endpoint: () => core.path, backoff: { initialMs: 20, maxMs: 100 }, machinePollMs: 100 });
  session.subscribe((c) => changes.push(c));
  session.start();
  return session;
}

describe("layout documents", () => {
  it("reads herdr-app on the core and on every connected machine, after subscribing", async () => {
    core.machines = [machine("cachyos"), machine("devserver")];
    core.docs.set("", { value: realShaped, version: 5 });
    core.docs.set("cachyos", { value: doc("t7"), version: 2 });
    const s = start();
    await until(() => s.layouts.list().length === 3);
    expect(s.layouts.list().map((l) => [l.machine, l.status, l.version])).toEqual([
      [null, "ok", 5],
      ["cachyos", "ok", 2],
      ["devserver", "empty", 0],
    ]);
    expect(paneOf(s.layouts.get("cachyos")!)).toBe("cachyos/t7"); // qualified
    expect(core.docGets).toContainEqual({ name: "herdr-app" });
    expect(core.docGets).toContainEqual({ name: "herdr-app", on: "cachyos" });
  });

  it("reads again on a doc event for herdr-app, for the core and for a machine", async () => {
    core.machines = [machine("cachyos")];
    const s = start();
    await until(() => s.layouts.get("cachyos")?.status === "empty");
    core.setDoc(doc("t1"));
    await until(() => paneOf(s.layouts.get(null)) === "t1");
    core.setDoc(doc("t8"), "cachyos");
    await until(() => paneOf(s.layouts.get("cachyos")) === "cachyos/t8");
    expect(changes.filter((c) => c.type === "layout").map((c) => (c as { layout: MachineLayout }).layout.machine)).toEqual([null, "cachyos", null, "cachyos"]);
  });

  it("ignores doc events for other documents", async () => {
    const s = start();
    await until(() => s.layouts.get(null) !== undefined);
    const reads = core.docGets.length;
    core.event("doc", undefined, { name: "something-else", version: 1 });
    await new Promise((r) => setTimeout(r, 100));
    expect(core.docGets.length).toBe(reads);
  });

  it("reads again after `missed`", async () => {
    const s = start();
    await until(() => s.layouts.get(null)?.status === "empty");
    core.docs.set("", { value: doc("t3"), version: 9 }); // changed while we were not listening
    core.raw("missed", { seq: 20, terminals: [term("t3")] });
    await until(() => paneOf(s.layouts.get(null)) === "t3");
  });

  it("reads again after a reconnect", async () => {
    core.docs.set("", { value: doc("t1"), version: 1 });
    const s = start();
    await until(() => paneOf(s.layouts.get(null)) === "t1");
    core.docs.set("", { value: doc("t2"), version: 2 });
    core.dropConnections();
    await until(() => paneOf(s.layouts.get(null)) === "t2");
  });

  it("marks a machine's layout unavailable while its line is down, and reads it when the line comes back", async () => {
    core.machines = [machine("cachyos")];
    core.docs.set("cachyos", { value: doc("t7"), version: 1 });
    const s = start();
    await until(() => paneOf(s.layouts.get("cachyos")) === "cachyos/t7");

    core.machines = [{ ...machine("cachyos", "unreachable"), why: "ssh: timed out" }];
    await until(() => s.layouts.get("cachyos")?.status === "unavailable");
    expect(s.layouts.get("cachyos")?.reason).toBe("machine unreachable: ssh: timed out");

    core.docs.set("cachyos", { value: doc("t9"), version: 2 });
    core.machines = [machine("cachyos")];
    await until(() => paneOf(s.layouts.get("cachyos")) === "cachyos/t9");
  });

  it("drops the layout of a machine that was forgotten", async () => {
    core.machines = [machine("cachyos")];
    const s = start();
    await until(() => s.layouts.get("cachyos") !== undefined);
    core.machines = [];
    await until(() => s.layouts.get("cachyos") === undefined);
    expect(changes).toContainEqual({ type: "layout-removed", machine: "cachyos" });
  });

  it("a failing doc.get leaves that machine unavailable with core's message, and the rest unaffected", async () => {
    core.machines = [machine("cachyos")];
    core.docs.set("", { value: doc("t1"), version: 1 });
    core.docErrors.set("cachyos", "no machine cachyos");
    const s = start();
    await until(() => s.layouts.list().length === 2);
    expect(s.layouts.get("cachyos")).toMatchObject({ status: "unavailable", reason: "no machine cachyos" });
    expect(s.layouts.get(null)?.status).toBe("ok");
    expect(s.state).toBe("connected");
  });

  it("an undecodable document is unavailable, and the next good one replaces it", async () => {
    core.docs.set("", { value: { spaces: [{ tabs: [{ root: { type: "hologram" } }] }] }, version: 1 });
    const s = start();
    await until(() => s.layouts.get(null)?.status === "unavailable");
    core.setDoc(doc("t4"));
    await until(() => s.layouts.get(null)?.status === "ok");
  });

  it("two doc events in a row end with the newest document", async () => {
    const s = start();
    await until(() => s.layouts.get(null) !== undefined);
    core.setDoc(doc("t1"));
    core.setDoc(doc("t2"));
    await until(() => s.layouts.get(null)?.version === 2);
    expect(paneOf(s.layouts.get(null))).toBe("t2");
  });

  it("never writes: only doc.get is called for documents", async () => {
    core.machines = [machine("cachyos")];
    const s = start();
    await until(() => s.layouts.list().length === 2);
    core.setDoc(doc("t1"));
    await until(() => paneOf(s.layouts.get(null)) === "t1");
    expect(core.methodsCalled).not.toContain("doc.set");
  });
});

describe("session changes", () => {
  it("reports terminals, machines, layouts and the connection in order", async () => {
    core.terminals = [term("t1")];
    const s = start();
    await until(() => s.state === "connected" && s.layouts.get(null) !== undefined);
    core.event("created", "t2", term("t2"));
    core.event("title", "t2", { title: "hi" });
    core.event("removed", "t1", {});
    await until(() => changes.some((c) => c.type === "terminal-removed"));
    const kinds = changes.map((c) => c.type + (c.type === "terminal" ? `:${c.terminal.address}:${c.terminal.title ?? ""}` : c.type === "terminal-removed" ? `:${c.address}` : ""));
    expect(kinds.filter((k) => k.startsWith("terminal"))).toEqual(["terminal:t1:", "terminal:t2:", "terminal:t2:hi", "terminal-removed:t1"]);
    expect(changes.filter((c) => c.type === "connection").map((c) => (c as { connection: { state: string } }).connection.state)).toEqual(["connected"]);
  });

  it("reports connection changes when core goes away and returns, and diffs the new snapshot", async () => {
    core.terminals = [term("t1"), term("t2")];
    const s = start();
    await until(() => s.state === "connected");
    changes.length = 0;
    await core.stop();
    await until(() => s.state === "reconnecting" && s.lastError !== null);
    core.terminals = [term("t2"), term("t3")];
    core.seq = 1;
    await core.listen();
    await until(() => s.state === "connected");
    const summary = changes.map((c) => (c.type === "connection" ? `connection:${c.connection.state}` : c.type === "terminal" ? `terminal:${c.terminal.address}` : c.type === "terminal-removed" ? `removed:${c.address}` : c.type));
    expect(summary[0]).toBe("connection:reconnecting");
    expect(summary).toContain("terminal:t3");
    expect(summary).toContain("removed:t1");
    expect(summary).not.toContain("terminal:t2"); // unchanged: not repeated
    expect(summary.at(-1)).toBe("connection:connected");
    expect(s.connection).toMatchObject({ state: "connected", error: null, core: { name: "fake", version: "9.9.9" } });
  });
});
