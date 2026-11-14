// Tester's cases for DEV-22: the main socket. A browser that follows the changes must end up
// where a browser that just connected starts; stalled, noisy and broken browsers must not hurt the others.
import type { Terminal } from "@herdr-web/core-client";
import type { Layout, Machine, ServerMessage, Terminal as WireTerminal } from "@herdr-web/protocol";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { snapshotMessage } from "../src/messages.js";
import { ORIGIN, openSocket, startHarness, types, until, type Client, type Harness } from "./helpers.js";

const term = (address: string, extra: Partial<Terminal> = {}): Terminal => ({
  address, argv: ["sh"], cols: 80, rows: 24, created_ms: 1, cwd: "/", state: "live", screen: "exact", labels: {}, title: "", turn: 0, ...extra,
});
const machine = (name: string, state = "connected") => ({ name, target: "x", id: `id-${name}`, host: "h", version: "1", state });
const doc = (...terminals: string[]) => ({
  spaces: [{ id: "s", name: "space", folder: "/", tabs: [{ id: "t", name: "tab", root: { id: "r", type: "row", children: terminals.map((t, i) => ({ id: `p${i}`, type: "block", content: { terminal: t } })) } }] }],
});

let h: Harness | undefined;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await h?.stop();
  h = undefined;
});
async function connect(): Promise<Client> {
  const c = await openSocket(h!, { Origin: ORIGIN, Cookie: await h!.cookie() });
  clients.push(c);
  return c;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What a browser would hold: it starts from the snapshot and applies each change, nothing else. */
interface View {
  terminals: Map<string, WireTerminal>;
  machines: Machine[];
  layouts: Map<string, Layout>;
  connection: unknown;
}
const key = (machine: string | null) => machine ?? "";
function reduce(messages: readonly ServerMessage[]): View {
  const v: View = { terminals: new Map(), machines: [], layouts: new Map(), connection: null };
  let seenSnapshot = false;
  for (const m of messages) {
    switch (m.type) {
      case "snapshot":
        seenSnapshot = true;
        v.terminals = new Map(m.terminals.map((t) => [t.address, t]));
        v.machines = m.machines;
        v.layouts = new Map(m.layouts.map((l) => [key(l.machine), l]));
        v.connection = m.connection;
        break;
      case "terminal":
        v.terminals.set(m.terminal.address, m.terminal);
        break;
      case "terminal.removed":
        v.terminals.delete(m.address);
        break;
      case "machines":
        v.machines = m.machines;
        break;
      case "layout":
        v.layouts.set(key(m.layout.machine), m.layout);
        break;
      case "layout.removed":
        v.layouts.delete(key(m.machine));
        break;
      case "connection":
        v.connection = m.connection;
        break;
    }
  }
  expect(seenSnapshot).toBe(true);
  return v;
}
const plain = (v: View) => JSON.parse(JSON.stringify({ t: [...v.terminals.entries()].sort(), m: v.machines, l: [...v.layouts.entries()].sort(), c: v.connection }));
/** The same shape, taken straight from the bridge's own state. */
function truth(): unknown {
  const s = snapshotMessage(h!.session);
  if (s.type !== "snapshot") throw new Error("not a snapshot");
  return plain(reduce([s]));
}

/** A small seeded generator, so a failing run can be repeated. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

describe("following the changes", () => {
  it.each([1, 2, 3, 4, 5, 6])("seed %i: browsers opened at random moments in a storm of events all end up where a new browser starts", async (seed) => {
    h = await startHarness({ connectCore: false });
    const r = rng(seed);
    const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
    h.core.terminals = [term("t1"), term("t2"), term("cachyos/t1")];
    h.core.machines = [machine("cachyos")];
    h.core.docs.set("", { value: doc("t1"), version: 1 });
    h.core.docs.set("cachyos", { value: doc("t1"), version: 1 });
    h.session.start();
    await until(() => h!.session.layouts.list().length === 2);

    const names = ["t1", "t2", "t3", "t4", "cachyos/t1", "cachyos/t5"];
    const browsers: Client[] = [];
    for (let i = 0; i < 150; i++) {
      const a = pick(names);
      const roll = r();
      if (roll < 0.15) h.core.event("created", a, term(a, { title: `n${i}` }));
      else if (roll < 0.25) h.core.event("removed", a, {});
      else if (roll < 0.4) h.core.event("title", a, { title: `title ${i}` });
      else if (roll < 0.5) h.core.event("labels", a, { labels: { k: String(i) } });
      else if (roll < 0.58) h.core.event("labels", a, { labels: { k: "r" }, record: term(a, { labels: { k: "r" }, title: `rec${i}` }) });
      else if (roll < 0.66) h.core.event("status", a, { status: { state: "working", app: "x", title: String(i) }, records: [], reported: [] });
      else if (roll < 0.72) h.core.event("finished", a, { reason: "exit", exit_code: 0, signal: null, finished_ms: i });
      else if (roll < 0.76) h.core.event("lost", a, { reason: "lost", exit_code: null, signal: null, finished_ms: i });
      else if (roll < 0.82) h.core.event("size", a, { cols: 100 + i, rows: 30 });
      else if (roll < 0.86) h.core.event("foreground", a, { pid: i, name: "vim", argv: ["vim"], cwd: "/" });
      else if (roll < 0.92) h.core.setDoc(doc(...names.filter(() => r() < 0.4)), pick(["", "cachyos"]));
      else if (roll < 0.96) h.core.machines = [machine("cachyos", pick(["connected", "unreachable", "connecting"]))];
      else h.core.event("keep", a, { keep: r() < 0.5 });
      if (r() < 0.06 && browsers.length < 6) browsers.push(await connect());
      if (r() < 0.3) await sleep(Math.floor(r() * 4));
    }
    await sleep(500); // the machine poll runs every 100 ms
    const fresh = await connect();
    await until(() => fresh.messages.length >= 2);
    const expected = truth();
    expect(plain(reduce(fresh.messages))).toEqual(expected);
    for (const b of browsers) expect(plain(reduce(b.messages))).toEqual(expected);
  }, 30_000);

  it("an event that arrives while the browser is connecting is in the snapshot or after it, never lost and never doubled out of order", async () => {
    h = await startHarness();
    h.core.event("created", "t1", term("t1"));
    await until(() => h!.session.store.get("t1") !== undefined);
    const results: string[] = [];
    for (let i = 0; i < 25; i++) {
      const cookie = await h.cookie();
      const opening = openSocket(h, { Origin: ORIGIN, Cookie: cookie });
      h.core.event("title", "t1", { title: `round ${i}` });
      const c = await opening;
      clients.push(c);
      await sleep(30);
      results.push(`${reduce(c.messages).terminals.get("t1")?.title} vs ${h.session.store.get("t1")?.title}`);
      expect(reduce(c.messages).terminals.get("t1")?.title).toBe(`round ${i}`);
      c.ws.terminate();
    }
  }, 30_000);

  it("after core restarts with other terminals the browser is told what went away and what appeared", async () => {
    h = await startHarness();
    h.core.terminals = [term("t1"), term("t2"), term("t3")];
    h.core.seq = 10;
    await h.core.stop();
    await until(() => h!.session.state !== "connected");
    h.core.terminals = [term("t2", { title: "changed" }), term("t4")];
    h.core.seq = 3; // a new core process counts again from a lower number
    h.core.machines = [machine("cachyos")];
    h.core.docs.set("", { value: doc("t2"), version: 1 });
    const before = await (async () => {
      await h!.core.listen();
      await until(() => h!.session.state === "connected");
      return null;
    })();
    void before;
    await sleep(300);
    const c = await connect();
    await until(() => c.messages.length >= 2);
    expect([...reduce(c.messages).terminals.keys()].sort()).toEqual(["t2", "t4"]);
  }, 15_000);

  it("a browser connected through a core restart follows it: removed ones gone, new ones present, connection back to connected", async () => {
    h = await startHarness({ connectCore: false });
    h.core.terminals = [term("t1"), term("t2"), term("t3")];
    h.core.docs.set("", { value: doc("t1", "t2"), version: 1 });
    h.session.start();
    await until(() => h!.session.layouts.list().length === 1);
    const c = await connect();
    await until(() => c.messages.length >= 2);
    await h.core.stop();
    await until(() => h!.session.state === "reconnecting");
    h.core.terminals = [term("t2", { title: "changed" }), term("t4")];
    h.core.seq = 2;
    h.core.docs.set("", { value: doc("t4"), version: 7 });
    await h.core.listen();
    await until(() => h!.session.state === "connected");
    await sleep(300);
    expect(plain(reduce(c.messages))).toEqual(truth());
    expect([...reduce(c.messages).terminals.keys()].sort()).toEqual(["t2", "t4"]);
    expect(types(c).filter((t) => t === "connection").length).toBeGreaterThanOrEqual(2);
  }, 15_000);
});

describe("several browsers", () => {
  const big = "x".repeat(40_000);

  it("a stalled browser is dropped and the one beside it still gets every change, in order, without a gap", async () => {
    h = await startHarness({ maxBufferedBytes: 256 * 1024 });
    h.core.event("created", "t1", term("t1"));
    await until(() => h!.session.store.get("t1") !== undefined);
    const stalled = await connect();
    const healthy = await connect();
    await until(() => stalled.messages.length >= 2 && healthy.messages.length >= 2);
    (stalled.ws as unknown as { _socket: { pause(): void } })._socket.pause();
    const N = 300;
    for (let i = 0; i < N; i++) {
      h.core.event("title", "t1", { title: `${String(i).padStart(4, "0")}${big}` });
      await sleep(2);
    }
    await until(() => healthy.messages.filter((m) => m.type === "terminal").length >= N, 10_000);
    const seen = healthy.messages.filter((m): m is Extract<ServerMessage, { type: "terminal" }> => m.type === "terminal").map((m) => m.terminal.title.slice(0, 4));
    expect(seen).toEqual(Array.from({ length: N }, (_, i) => String(i).padStart(4, "0")));
    await until(() => h!.bridge.clientCount() === 1, 5000);
    expect(healthy.closed).toBeUndefined();
  }, 30_000);

  it("a dropped browser is closed with 1013 once it reads again, and a new one connecting right after gets the full picture", async () => {
    h = await startHarness({ maxBufferedBytes: 128 * 1024 });
    h.core.event("created", "t1", term("t1"));
    await until(() => h!.session.store.get("t1") !== undefined);
    const slow = await connect();
    await until(() => slow.messages.length >= 2);
    const sock = (slow.ws as unknown as { _socket: { pause(): void; resume(): void } })._socket;
    sock.pause();
    for (let i = 0; i < 100; i++) {
      h.core.event("title", "t1", { title: `${i}${big}` });
      await sleep(2);
    }
    sock.resume(); // it reads again: the close it was sent is waiting for it
    await until(() => slow.closed !== undefined, 5000);
    expect(slow.closed!.code).toBe(1013);
    await until(() => h!.bridge.clientCount() === 0, 3000);
    const again = await connect();
    await until(() => again.messages.length >= 2);
    expect(plain(reduce(again.messages))).toEqual(truth());
  }, 20_000);

  it("thirty browsers at once all start from the same picture and all see the same change", async () => {
    h = await startHarness();
    h.core.event("created", "t1", term("t1"));
    await until(() => h!.session.store.get("t1") !== undefined);
    const cookie = await h.cookie();
    const all = await Promise.all(Array.from({ length: 30 }, () => openSocket(h!, { Origin: ORIGIN, Cookie: cookie })));
    clients.push(...all);
    await until(() => all.every((c) => c.messages.length >= 2));
    h.core.event("title", "t1", { title: "for everyone" });
    await until(() => all.every((c) => c.messages.length >= 3));
    for (const c of all) expect(plain(reduce(c.messages))).toEqual(truth());
    expect(h.bridge.clientCount()).toBe(30);
  }, 20_000);

  it("a browser that goes away mid-storm does not stop the others or leave a listener behind", async () => {
    h = await startHarness();
    h.core.event("created", "t1", term("t1"));
    await until(() => h!.session.store.get("t1") !== undefined);
    const a = await connect();
    const b = await connect();
    await until(() => a.messages.length >= 2 && b.messages.length >= 2);
    for (let i = 0; i < 40; i++) {
      h.core.event("title", "t1", { title: `${i}` });
      if (i === 10) a.ws.terminate();
      if (i === 20) b.ws.close();
      await sleep(1);
    }
    const c = await connect();
    await until(() => c.messages.length >= 2);
    h.core.event("title", "t1", { title: "last" });
    await until(() => reduce(c.messages).terminals.get("t1")?.title === "last");
    await until(() => h!.bridge.clientCount() === 1);
    expect(h.bridge.clientCount()).toBe(1);
  }, 15_000);
});

describe("what a browser may send", () => {
  async function sendAndWatch(payload: string | Buffer, opts: { binary?: boolean } = {}) {
    const c = await connect();
    await until(() => c.messages.length >= 2);
    c.ws.send(payload, { binary: opts.binary ?? false });
    return c;
  }
  const bad: Array<[string, string]> = [
    ["empty text", ""],
    ["null", "null"],
    ["a number", "1"],
    ["a list", "[]"],
    ["a list holding a ping", '[{"type":"ping"}]'],
    ["a string that says ping", '"ping"'],
    ["ping as plain text", "ping"],
    ["object without a type", "{}"],
    ["a type that is not a string", '{"type":1}'],
    ["an unknown type", '{"type":"subscribe"}'],
    ["upper case type", '{"type":"PING"}'],
    ["type with a trailing space", '{"type":"ping "}'],
    ["broken JSON", '{"type":"ping"'],
    ["two messages in one", '{"type":"ping"}{"type":"ping"}'],
    ["a message that asks for something the bridge does not do", '{"type":"input","terminal":"t1","data":"rm -rf ~\\n"}'],
  ];
  it.each(bad)("%s closes the socket with 1008 and nothing else is sent", async (_name, payload) => {
    h = await startHarness();
    const c = await sendAndWatch(payload);
    await until(() => c.closed !== undefined);
    expect(c.closed!.code).toBe(1008);
    expect(types(c)).toEqual(["hello", "snapshot"]);
  });

  it("a bad message closes only that browser", async () => {
    h = await startHarness();
    const good = await connect();
    const evil = await sendAndWatch("{");
    await until(() => evil.closed !== undefined);
    h.core.event("created", "t9", term("t9"));
    await until(() => good.messages.some((m) => m.type === "terminal"));
    expect(good.closed).toBeUndefined();
    good.send('{"type":"ping"}');
    await until(() => types(good).includes("pong"));
  });

  it("a ping with extra fields is answered with a pong", async () => {
    h = await startHarness();
    const c = await sendAndWatch('{"type":"ping","id":7,"x":{"y":[1,2]}}');
    await until(() => types(c).includes("pong"));
    expect(c.closed).toBeUndefined();
  });

  it("two hundred pings in a row get two hundred pongs and the socket stays open", async () => {
    h = await startHarness();
    const c = await connect();
    await until(() => c.messages.length >= 2);
    for (let i = 0; i < 200; i++) c.send('{"type":"ping"}');
    await until(() => types(c).filter((t) => t === "pong").length === 200);
    expect(c.closed).toBeUndefined();
  });

  it("a binary message closes with 1003, even if its bytes look like a ping", async () => {
    h = await startHarness();
    const c = await sendAndWatch(Buffer.from('{"type":"ping"}'), { binary: true });
    await until(() => c.closed !== undefined);
    expect(c.closed!.code).toBe(1003);
  });

  it("a message over 16 KiB closes with 1009, even if it is a valid ping padded with spaces", async () => {
    h = await startHarness();
    const c = await sendAndWatch('{"type":"ping"}' + " ".repeat(20_000));
    await until(() => c.closed !== undefined);
    expect(c.closed!.code).toBe(1009);
    expect(h.bridge.clientCount()).toBe(0);
  });

  it("text that is not valid UTF-8 closes with 1007", async () => {
    h = await startHarness();
    const c = await connect();
    await until(() => c.messages.length >= 2);
    // a text frame by hand: the client library refuses to send bad UTF-8 as text, so send the raw frame
    const sock = (c.ws as unknown as { _socket: import("node:net").Socket })._socket;
    const payload = Buffer.from([0x7b, 0xff, 0xfe, 0x7d]);
    const mask = Buffer.from([1, 2, 3, 4]);
    const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!));
    sock.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]));
    await until(() => c.closed !== undefined);
    expect(c.closed!.code).toBe(1007);
  });

  it("a ping sent in two fragments is one ping", async () => {
    h = await startHarness();
    const c = await connect();
    await until(() => c.messages.length >= 2);
    c.ws.send('{"type":', { fin: false });
    c.ws.send('"ping"}', { fin: true });
    await until(() => types(c).includes("pong") || c.closed !== undefined);
    expect(types(c)).toContain("pong");
  });

  it("WebSocket-level pings from the browser get WebSocket pongs (the library answers) and are not messages", async () => {
    h = await startHarness();
    const c = await connect();
    await until(() => c.messages.length >= 2);
    const pong = new Promise<void>((resolve) => c.ws.once("pong", () => resolve()));
    c.ws.ping();
    await pong;
    expect(c.closed).toBeUndefined();
    expect(types(c)).toEqual(["hello", "snapshot"]);
  });

  it("a client that sends nothing and never closes is left alone", async () => {
    h = await startHarness();
    const c = await connect();
    await sleep(300);
    expect(c.closed).toBeUndefined();
    expect(h.bridge.clientCount()).toBe(1);
  });

  it("a hundred connect-and-leave cycles leave no clients behind", async () => {
    h = await startHarness();
    const cookie = await h.cookie();
    for (let i = 0; i < 100; i++) {
      const c = await openSocket(h, { Origin: ORIGIN, Cookie: cookie });
      if (i % 2) c.ws.terminate();
      else c.close();
    }
    await until(() => h!.bridge.clientCount() === 0, 5000);
    // and a change afterwards has nobody to be sent to and breaks nothing
    h.core.event("created", "t1", term("t1"));
    await until(() => h!.session.store.get("t1") !== undefined);
  }, 30_000);

  it("a frame with the wrong opcode or reserved bits closes that browser and not the bridge", async () => {
    h = await startHarness();
    const c = await connect();
    await until(() => c.messages.length >= 2);
    const sock = (c.ws as unknown as { _socket: import("node:net").Socket })._socket;
    sock.write(Buffer.from([0xf1, 0x80, 1, 2, 3, 4])); // RSV bits set
    await until(() => c.closed !== undefined);
    expect((await h.login()).res.status).toBe(200);
    void WebSocket;
  });
});
