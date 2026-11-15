import { PROTOCOL_VERSION, type Layout, type ServerMessage } from "@herdr-web/protocol";
import type { Terminal } from "@herdr-web/core-client";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { ORIGIN, openSocket, startHarness, types, until, type Client, type Harness } from "./helpers.js";

const term = (address: string, extra: Partial<Terminal> = {}): Terminal => ({
  address, argv: ["sh"], cols: 80, rows: 24, created_ms: 1, cwd: "/", state: "live", screen: "exact", labels: {}, title: "", turn: 0, ...extra,
});
const doc = (terminal: string) => ({ spaces: [{ id: "s", name: "space", folder: "/", tabs: [{ id: "t", name: "tab", root: { id: "t", type: "row", children: [{ id: "p", type: "block", content: { terminal } }] } }] }] });
const machine = { name: "cachyos", target: "x", id: "i", host: "h", version: "1", state: "connected" };

let h: Harness | undefined;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await h?.stop();
  h = undefined;
});

async function connect(headers?: Record<string, string>): Promise<Client> {
  const c = await openSocket(h!, headers ?? { Origin: ORIGIN, Cookie: await h!.cookie() });
  clients.push(c);
  return c;
}
const find = <T extends ServerMessage["type"]>(c: Client, type: T) => c.messages.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);

describe("upgrade checks", () => {
  it("refuses without a cookie", async () => {
    h = await startHarness();
    await expect(openSocket(h, { Origin: ORIGIN })).rejects.toThrow("refused: 401");
  });

  it("refuses a bad cookie", async () => {
    h = await startHarness();
    await expect(openSocket(h, { Origin: ORIGIN, Cookie: "herdr_web_session=1.nope" })).rejects.toThrow("refused: 401");
  });

  it("refuses a valid cookie from a foreign Origin, and with no Origin", async () => {
    h = await startHarness();
    const cookie = await h.cookie();
    await expect(openSocket(h, { Origin: "http://evil.example", Cookie: cookie })).rejects.toThrow("refused: 403");
    await expect(openSocket(h, { Origin: "http://localhost:3001", Cookie: cookie })).rejects.toThrow("refused: 403");
    await expect(openSocket(h, { Cookie: cookie })).rejects.toThrow("refused: 403");
  });

  it("refuses other paths", async () => {
    h = await startHarness();
    await expect(openSocket(h, { Origin: ORIGIN, Cookie: await h.cookie() }, "/api/other")).rejects.toThrow("refused: 404");
    await expect(openSocket(h, { Origin: ORIGIN, Cookie: await h.cookie() }, "/")).rejects.toThrow("refused: 404");
  });

  it("accepts a valid cookie from an allowed Origin, and renews the cookie", async () => {
    h = await startHarness();
    const cookie = await h.cookie();
    const upgrade = new Promise<string | string[] | undefined>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${h!.port}/api/ws`, { headers: { Origin: ORIGIN, Cookie: cookie } });
      ws.on("upgrade", (res) => resolve(res.headers["set-cookie"]));
      ws.on("open", () => ws.close());
    });
    expect(String(await upgrade)).toMatch(/herdr_web_session=\d+\..*HttpOnly/);
  });
});

describe("snapshot", () => {
  it("is hello then snapshot: version, build, terminals (finished too), machines, layouts, connection", async () => {
    h = await startHarness({ connectCore: false });
    h.core.terminals = [term("t1"), term("t2", { state: "finished", reason: "killed", signal: 1, finished_ms: 9 }), term("cachyos/t7")];
    h.core.machines = [machine];
    h.core.docs.set("", { value: doc("t1"), version: 3 });
    h.core.docs.set("cachyos", { value: doc("t7"), version: 1 });
    h.core.seq = 40;
    h.session.start();
    await until(() => h!.session.layouts.list().length === 2);
    const c = await connect();
    await until(() => c.messages.length >= 2);
    expect(c.messages[0]).toEqual({ type: "hello", protocol: PROTOCOL_VERSION, build: "test-build" });
    const snap = c.messages[1]!;
    if (snap.type !== "snapshot") throw new Error("second message is not a snapshot");
    expect(snap.connection).toEqual({ state: "connected", error: null, core: { id: "abc", name: "fake", version: "9.9.9" } });
    expect(snap.terminals.map((t) => [t.address, t.state])).toEqual([["t1", "live"], ["t2", "finished"], ["cachyos/t7", "live"]]);
    expect(snap.terminals[1]).toMatchObject({ reason: "killed", signal: 1, finished_ms: 9, name: null, status: null, foreground: null, keep: false });
    expect(snap.machines).toEqual([{ name: "cachyos", id: "i", host: "h", target: "x", version: "1", state: "connected", why: null, since_ms: null, temporary: false }]);
    expect(snap.layouts.map((l: Layout) => [l.machine, l.status])).toEqual([[null, "ok"], ["cachyos", "ok"]]);
    expect(snap.layouts[1]!.spaces[0]!.tabs[0]!.panes).toEqual([{ id: "p", kind: "terminal", terminal: "cachyos/t7" }]);
  });

  it("while core is not connected yet, it still sends a snapshot saying so", async () => {
    h = await startHarness({ connectCore: false });
    const c = await connect();
    await until(() => c.messages.length >= 2);
    const snap = c.messages[1]!;
    expect(snap).toMatchObject({ type: "snapshot", terminals: [], machines: [], layouts: [], connection: { state: "connecting", core: null } });
  });

  it("each connection starts with its own snapshot, with no resume", async () => {
    h = await startHarness();
    h.core.terminals = [term("t1")];
    h.core.event("created", "t2", term("t2"));
    await until(() => h!.session.store.get("t2") !== undefined);
    const a = await connect();
    await until(() => a.messages.length >= 2);
    a.close();
    h.core.event("created", "t3", term("t3"));
    await until(() => h!.session.store.get("t3") !== undefined);
    const b = await connect();
    await until(() => b.messages.length >= 2);
    expect(types(b).slice(0, 2)).toEqual(["hello", "snapshot"]);
    expect(find(b, "snapshot")[0]!.terminals.map((t) => t.address)).toEqual(["t2", "t3"]);
  });
});

describe("changes", () => {
  it("a terminal added, labelled, finished and removed arrive one by one, in order", async () => {
    h = await startHarness();
    const c = await connect();
    await until(() => c.messages.length >= 2);
    h.core.event("created", "t1", term("t1"));
    h.core.event("labels", "t1", { labels: { "herdr.seen": "1" } });
    h.core.event("finished", "t1", { reason: "killed", exit_code: null, signal: 1, finished_ms: 5 });
    h.core.event("removed", "t1", {});
    await until(() => c.messages.length >= 6);
    expect(c.messages.slice(2).map((m) => (m.type === "terminal" ? `terminal:${m.terminal.state}:${JSON.stringify(m.terminal.labels)}` : m.type))).toEqual([
      "terminal:live:{}",
      'terminal:live:{"herdr.seen":"1"}',
      'terminal:finished:{"herdr.seen":"1"}',
      "terminal.removed",
    ]);
    expect(find(c, "terminal.removed")[0]).toEqual({ type: "terminal.removed", address: "t1" });
    expect(find(c, "terminal")[2]!.terminal).toMatchObject({ reason: "killed", signal: 1, finished_ms: 5 });
  });

  it("a layout change arrives as one small message for that machine", async () => {
    h = await startHarness();
    h.core.machines = [machine];
    const c = await connect();
    await until(() => c.messages.length >= 2);
    h.core.setDoc(doc("t1"));
    h.core.setDoc(doc("t9"), "cachyos");
    await until(() => find(c, "layout").length >= 2);
    const layouts = find(c, "layout").map((m) => m.layout);
    expect(layouts.map((l) => [l.machine, l.status])).toEqual([[null, "ok"], ["cachyos", "ok"]]);
    expect(layouts[1]!.spaces[0]!.tabs[0]!.panes[0]).toEqual({ id: "p", kind: "terminal", terminal: "cachyos/t9" });
  });

  it("a machine going down arrives as machines and layout changes", async () => {
    h = await startHarness();
    h.core.machines = [machine];
    const c = await connect();
    await until(() => find(c, "machines").length >= 1);
    h.core.machines = [{ ...machine, state: "unreachable" }];
    await until(() => find(c, "machines").some((m) => m.machines[0]?.state === "unreachable"));
    await until(() => find(c, "layout").some((m) => m.layout.machine === "cachyos" && m.layout.status === "unavailable"));
  });

  it("a forgotten machine's layout is removed", async () => {
    h = await startHarness();
    h.core.machines = [machine];
    const c = await connect();
    await until(() => find(c, "snapshot").length === 1)
    await until(() => find(c, "layout").some((m) => m.layout.machine === "cachyos") || find(c, "snapshot")[0]!.layouts.some((l) => l.machine === "cachyos"));
    h.core.machines = [];
    await until(() => find(c, "layout.removed").length === 1);
    expect(find(c, "layout.removed")[0]).toEqual({ type: "layout.removed", machine: "cachyos" });
  });

  it("stays open when core goes away, reports the state, and is correct again afterwards", async () => {
    h = await startHarness({ connectCore: false });
    h.core.terminals = [term("t1"), term("t2")];
    h.session.start();
    await until(() => h!.session.state === "connected");
    const c = await connect();
    await until(() => find(c, "snapshot").length === 1);
    const snapshot0 = find(c, "snapshot")[0]!;
    await h.core.stop();
    await until(() => find(c, "connection").some((m) => m.connection.state === "reconnecting"));
    expect(c.closed).toBeUndefined();
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    h.core.terminals = [term("t2"), term("t3")];
    h.core.seq = 1;
    await h.core.listen();
    await until(() => find(c, "connection").at(-1)?.connection.state === "connected");
    const states = find(c, "connection").map((m) => m.connection.state);
    expect(states[0]).toBe("reconnecting");
    expect(states.at(-1)).toBe("connected");
    expect(find(c, "terminal").map((m) => m.terminal.address)).toContain("t3");
    expect(find(c, "terminal.removed").map((m) => m.address)).toEqual(["t1"]);
    // applying the changes to the snapshot gives core's list
    const held = new Map(snapshot0.terminals.map((t) => [t.address, t]));
    for (const m of c.messages.slice(2)) {
      if (m.type === "terminal") held.set(m.terminal.address, m.terminal);
      if (m.type === "terminal.removed") held.delete(m.address);
    }
    expect([...held.keys()].sort()).toEqual(["t2", "t3"]);
    expect(c.closed).toBeUndefined();
  });

  it("every connected browser gets the changes", async () => {
    h = await startHarness();
    const a = await connect();
    const b = await connect();
    await until(() => a.messages.length >= 2 && b.messages.length >= 2);
    h.core.event("created", "t1", term("t1"));
    await until(() => find(a, "terminal").length === 1 && find(b, "terminal").length === 1);
    expect(h.bridge.clientCount()).toBe(2);
    a.close();
    await until(() => h!.bridge.clientCount() === 1);
  });
});

describe("browser messages", () => {
  it("ping gets pong", async () => {
    h = await startHarness();
    const c = await connect();
    await until(() => c.messages.length >= 2);
    c.send('{"type":"ping"}');
    await until(() => find(c, "pong").length === 1);
  });

  it.each(["{", "{}", '{"type":"login"}', '{"type":"pong"}'])("closes on the invalid message %j", async (text) => {
    h = await startHarness();
    const c = await connect();
    await until(() => c.messages.length >= 2);
    c.send(text);
    await until(() => c.closed !== undefined);
    expect(c.closed!.code).toBe(1008);
  });

  it("closes on a binary message", async () => {
    h = await startHarness();
    const c = await connect();
    await until(() => c.messages.length >= 2);
    c.send(Buffer.from([1, 2, 3]));
    await until(() => c.closed !== undefined);
    expect(c.closed!.code).toBe(1003);
  });
});

describe("slow browsers", () => {
  const big = "x".repeat(40_000);

  it("a browser that stops reading is dropped once its queue passes the limit, and the bridge lets go of it", async () => {
    h = await startHarness({ maxBufferedBytes: 256 * 1024 });
    h.core.terminals = [term("t1")];
    h.core.event("created", "t1", term("t1"));
    const c = await connect();
    await until(() => c.messages.length >= 2);
    (c.ws as unknown as { _socket: { pause(): void } })._socket.pause(); // reads nothing more
    expect(h.bridge.clientCount()).toBe(1);
    for (let i = 0; i < 400 && h.bridge.clientCount() === 1; i++) {
      h.core.event("title", "t1", { title: `${i}${big}` });
      await new Promise((r) => setTimeout(r, 2));
    }
    await until(() => h!.bridge.clientCount() === 0, 5000);
  }, 15_000);

  it("a browser that keeps up is not dropped by the same traffic", async () => {
    h = await startHarness({ maxBufferedBytes: 256 * 1024 });
    h.core.event("created", "t1", term("t1"));
    const c = await connect();
    await until(() => c.messages.length >= 2);
    for (let i = 0; i < 60; i++) {
      h.core.event("title", "t1", { title: `${i}${big}` });
      await new Promise((r) => setTimeout(r, 2));
    }
    await until(() => find(c, "terminal").length >= 60);
    expect(h.bridge.clientCount()).toBe(1);
    expect(c.closed).toBeUndefined();
  }, 15_000);
});
