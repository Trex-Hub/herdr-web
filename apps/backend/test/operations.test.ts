import type { Terminal } from "@herdr-web/core-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ORIGIN, startHarness, until, type Harness } from "./helpers.js";

const term = (address: string, extra: Partial<Terminal> = {}): Terminal => ({
  address, argv: ["sh"], cols: 80, rows: 24, created_ms: 1, cwd: "/", state: "live", screen: "exact", labels: {}, title: "", turn: 0, ...extra,
});
const space = (id: string, folder: string) => ({ id, name: id, folder, tabs: [] });
const machine = { name: "cachyos", target: "x", id: "i", host: "h", version: "1", state: "connected" };

let h: Harness;
let cookie: string;

/** The calls that change or ask core, from the bridge's operations (the session's own reads are left out). */
const operationCalls = () => h.core.calls.filter((c) => /^(terminal\.(run|kill|label)|templates\.list)$/.test(c.method));

async function post(name: string, body: unknown, headers: Record<string, string> = { Origin: ORIGIN, Cookie: cookie }) {
  const res = await fetch(`${h.base}/api/ops/${name}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  h = await startHarness({ connectCore: false });
  h.core.machines = [machine];
  h.core.docs.set("", { value: { spaces: [space("sp-local", "/work/local")] }, version: 1 });
  h.core.docs.set("cachyos", { value: { spaces: [space("sp-remote", "/home/dev/remote")] }, version: 1 });
  h.core.terminals = [
    term("t1", { turn: 3, labels: { "herdr.seen": "1" } }),
    term("t2", { turn: 3, labels: { "herdr.seen": "3" } }),
    term("t3", { turn: 0 }),
    term("t4", { state: "finished", reason: "exited", exit_code: 0 }),
    term("cachyos/t9", { turn: 2 }),
    term("t1b", { turn: 3, labels: { "herdr.seen": "1" } }),
    term("cachyos/t1b", { turn: 2 }),
  ];
  h.core.rpc.set("terminal.run", (p: { on?: string }) => term(p.on ? "t11" : "t10"));
  h.core.rpc.set("terminal.kill", () => term("t1", { state: "finished", reason: "killed", signal: 1 }));
  h.core.rpc.set("terminal.label", () => term("t1"));
  h.core.rpc.set("templates.list", () => ({ templates: [{ name: "reviewer", description: "Reviews a diff", command: "claude" }, { name: "broken", description: "x", command: "y", error: "no such file" }] }));
  h.session.start();
  await until(() => h.session.state === "connected" && h.session.layouts.list().length === 2 && h.session.store.get("cachyos/t9") !== undefined);
  cookie = await h.cookie();
});
afterEach(async () => {
  await h.stop();
});

describe("access", () => {
  it("needs the cookie and an allowed Origin, and makes no core call without them", async () => {
    const bodies = { start: { machine: null, space: "sp-local", what: { kind: "shell" } }, kill: { terminal: "t1" }, seen: { terminal: "t1", turn: 2 }, unread: { terminal: "t1" }, pin: { terminal: "t1", pinned: true } };
    for (const [name, body] of Object.entries(bodies)) {
      expect((await post(name, body, { Origin: ORIGIN })).status, name).toBe(401);
      expect((await post(name, body, { Origin: "http://evil.example", Cookie: cookie })).status, name).toBe(403);
    }
    expect((await fetch(`${h.base}/api/starters`)).status).toBe(401);
    expect(operationCalls()).toEqual([]);
  });

  it("an unknown operation is a 404, and input that does not fit is a 400 with the reason", async () => {
    expect((await post("format-disk", {})).status).toBe(404);
    const folder = await post("start", { machine: null, space: "sp-local", what: { kind: "shell" }, folder: "/etc" });
    expect(folder.status).toBe(400);
    expect(String(folder.body["error"])).toMatch(/^Bad request: /);
    expect((await post("kill", { terminal: "t1; rm" })).status).toBe(400);
    expect((await post("seen", { terminal: "t1", turn: -1 })).status).toBe(400);
    expect((await post("seen", { terminal: "t1", turn: 1.5 })).status).toBe(400);
    expect((await post("pin", { terminal: "t1", pinned: "yes" })).status).toBe(400);
    expect((await post("start", { machine: null, space: "sp-local", what: { kind: "template" } })).status).toBe(400);
    expect(operationCalls()).toEqual([]);
  });
});

describe("start", () => {
  it("runs a shell in the space's folder with exactly the ticket's call", async () => {
    const r = await post("start", { machine: null, space: "sp-local", what: { kind: "shell" } });
    expect(r).toEqual({ status: 200, body: { address: "t10" } });
    const calls = operationCalls();
    expect(calls).toHaveLength(1);
    const p = calls[0]!.params as { labels: Record<string, string> } & Record<string, unknown>;
    expect(calls[0]!.method).toBe("terminal.run");
    expect(Object.keys(p).sort()).toEqual(["cwd", "keep", "labels", "no_parent"]);
    expect(p).toMatchObject({ cwd: "/work/local", keep: true, no_parent: true });
    expect(Object.keys(p.labels).sort()).toEqual(["herdr.seen", "herdr.space", "herdr.tab"]);
    expect(p.labels["herdr.space"]).toBe("sp-local");
    expect(p.labels["herdr.seen"]).toBe("0");
    expect(p.labels["herdr.tab"]).toMatch(/^tb[0-9a-f]{32}$/);
  });

  it("gives every terminal its own tab id", async () => {
    await post("start", { machine: null, space: "sp-local", what: { kind: "shell" } });
    await post("start", { machine: null, space: "sp-local", what: { kind: "shell" } });
    const tabs = operationCalls().map((c) => (c.params as { labels: Record<string, string> }).labels["herdr.tab"]);
    expect(new Set(tabs).size).toBe(2);
  });

  it("starts pi as argv [pi], and a template by name after checking core has it", async () => {
    await post("start", { machine: null, space: "sp-local", what: { kind: "pi" } });
    expect(operationCalls()[0]!.params).toMatchObject({ argv: ["pi"] });
    await post("start", { machine: null, space: "sp-local", what: { kind: "template", name: "reviewer" } });
    expect(operationCalls().map((c) => c.method)).toEqual(["terminal.run", "templates.list", "terminal.run"]);
    expect(operationCalls()[2]!.params).toMatchObject({ argv: ["reviewer"], keep: true, no_parent: true });
  });

  it("on an added machine: `on`, that machine's folder and space id, and the address qualified", async () => {
    const r = await post("start", { machine: "cachyos", space: "sp-remote", what: { kind: "shell" } });
    expect(r).toEqual({ status: 200, body: { address: "cachyos/t11" } });
    expect(operationCalls()[0]!.params).toMatchObject({ on: "cachyos", cwd: "/home/dev/remote", labels: { "herdr.space": "sp-remote" } });
  });

  it("refuses an unknown space, a space of the other machine, an unknown machine, an unreadable layout, an unknown or broken template: no run", async () => {
    expect((await post("start", { machine: null, space: "nope", what: { kind: "shell" } })).status).toBe(404);
    expect((await post("start", { machine: null, space: "sp-remote", what: { kind: "shell" } })).status).toBe(404);
    expect((await post("start", { machine: "ghost", space: "sp-remote", what: { kind: "shell" } })).status).toBe(404);
    h.core.docs.set("cachyos", { value: { spaces: "nonsense" }, version: 2 });
    h.core.event("doc", undefined, { name: "herdr-app", version: 2 }, "cachyos");
    await until(() => h.session.layouts.get("cachyos")?.status === "unavailable");
    const down = await post("start", { machine: "cachyos", space: "sp-remote", what: { kind: "shell" } });
    expect(down.status).toBe(409);
    expect(String(down.body["error"])).toContain("cannot be read");
    expect((await post("start", { machine: null, space: "sp-local", what: { kind: "template", name: "ghost" } })).status).toBe(404);
    const broken = await post("start", { machine: null, space: "sp-local", what: { kind: "template", name: "broken" } });
    expect(broken.status).toBe(409);
    expect(String(broken.body["error"])).toContain("no such file");
    expect(operationCalls().filter((c) => c.method === "terminal.run")).toEqual([]);
  });

  it("passes core's own words on when core refuses", async () => {
    h.core.rpc.set("terminal.run", () => ({ error: { message: "cannot spawn: no such directory /work/local", kind: "invalid" } }));
    const r = await post("start", { machine: null, space: "sp-local", what: { kind: "shell" } });
    expect(r).toEqual({ status: 502, body: { error: "cannot spawn: no such directory /work/local" } });
  });

  it("lists what can be started: shell, pi, then core's usable templates", async () => {
    const res = await fetch(`${h.base}/api/starters`, { headers: { Origin: ORIGIN, Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      starters: [
        { kind: "shell", name: "Shell", description: "The machine's own shell" },
        { kind: "pi", name: "pi", description: "The pi coding agent" },
        { kind: "template", name: "reviewer", description: "Reviews a diff" },
      ],
    });
  });
});

describe("kill", () => {
  it("kills a live terminal and says how it ended", async () => {
    const r = await post("kill", { terminal: "t1" });
    expect(r).toEqual({ status: 200, body: { address: "t1", reason: "killed", exitCode: null, signal: 1 } });
    expect(operationCalls()).toEqual([{ method: "terminal.kill", params: { terminal: "t1" } }]);
  });
  it("refuses a terminal that is unknown or already finished: no call", async () => {
    expect((await post("kill", { terminal: "t99" })).status).toBe(404);
    const done = await post("kill", { terminal: "t4" });
    expect(done.status).toBe(409);
    expect(String(done.body["error"])).toContain("ended");
    expect(operationCalls()).toEqual([]);
  });
});

describe("seen, unread, pinned", () => {
  const label = (labels: Record<string, string>, terminal: string) => ({ method: "terminal.label", params: { terminal, labels } });

  it("raises seen to a turn the terminal has reached", async () => {
    expect(await post("seen", { terminal: "t1", turn: 3 })).toEqual({ status: 200, body: { address: "t1", seen: 3 } });
    expect(operationCalls()).toEqual([label({ "herdr.seen": "3" }, "t1")]);
  });
  it("accepts a first value when the label is missing, even 0", async () => {
    expect((await post("seen", { terminal: "t3", turn: 0 })).status).toBe(200);
    expect(operationCalls()).toEqual([label({ "herdr.seen": "0" }, "t3")]);
  });
  it("refuses a value at or below the current label, and above the terminal's turn: no call", async () => {
    expect((await post("seen", { terminal: "t1", turn: 1 })).status).toBe(409); // equal
    expect((await post("seen", { terminal: "t2", turn: 2 })).status).toBe(409); // below
    const high = await post("seen", { terminal: "t1", turn: 4 });
    expect(high.status).toBe(409);
    expect(String(high.body["error"])).toContain("turn 3");
    expect((await post("seen", { terminal: "t99", turn: 1 })).status).toBe(404);
    expect((await post("seen", { terminal: "t4", turn: 0 })).status).toBe(409);
    expect(operationCalls()).toEqual([]);
  });
  it("marks unread by writing turn − 1, and refuses at turn 0", async () => {
    expect(await post("unread", { terminal: "t2" })).toEqual({ status: 200, body: { address: "t2", seen: 2 } });
    expect(operationCalls()).toEqual([label({ "herdr.seen": "2" }, "t2")]);
    const none = await post("unread", { terminal: "t3" });
    expect(none.status).toBe(409);
    expect(operationCalls()).toHaveLength(1);
  });
  it("pins with 1 and unpins with the empty value, on a remote terminal too", async () => {
    expect(await post("pin", { terminal: "t1", pinned: true })).toEqual({ status: 200, body: { address: "t1", pinned: true } });
    expect(await post("pin", { terminal: "cachyos/t9", pinned: false })).toEqual({ status: 200, body: { address: "cachyos/t9", pinned: false } });
    expect(operationCalls()).toEqual([label({ "herdr.pinned": "1" }, "t1"), label({ "herdr.pinned": "" }, "cachyos/t9")]);
    expect((await post("pin", { terminal: "t4", pinned: true })).status).toBe(409);
  });
});

describe("when core is away", () => {
  it("says so and queues nothing", async () => {
    await h.core.dispose();
    await until(() => h.session.state !== "connected");
    const r = await post("pin", { terminal: "t1", pinned: true });
    expect(r.status).toBe(503);
    expect(String(r.body["error"])).toContain("not connected");
  });
});

describe("addresses core counts in base 32 (t1b, t2n, cachyos/t1b)", () => {
  it("are accepted by every operation that names a terminal", async () => {
    for (const address of ["t1b", "cachyos/t1b"]) {
      expect((await post("pin", { terminal: address, pinned: true })).status, `pin ${address}`).toBe(200);
      expect((await post("kill", { terminal: address })).status, `kill ${address}`).toBe(200);
    }
    expect((await post("seen", { terminal: "t1b", turn: 2 })).status).toBe(200);
    expect((await post("unread", { terminal: "t1b" })).status).toBe(200);
  });
});
