import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { FrameKind } from "@herdr-web/core-client";
import { Tag, TerminalClose, parseTerminalServerMessage, tagMessage, terminalSocketPath, type TerminalServerMessage } from "@herdr-web/protocol";
import { ORIGIN, startHarness, until, type Harness } from "./helpers.js";
import type { BridgeOptions } from "../src/server.js";

const display = { fg: "#d4d4d4", bg: "#1e1e1e", cursor: null, cell: [9, 18] as [number, number] };
const attachMsg = { type: "attach", cols: 100, rows: 30, history: 2000, display };

interface View {
  ws: WebSocket;
  texts: TerminalServerMessage[];
  /** Binary messages received, tag stripped. */
  output: Buffer[];
  closed: { code: number; reason: string } | undefined;
  send(m: unknown): void;
  sendBinary(tag: number, bytes: string | Uint8Array): void;
}

function openView(h: Harness, cookie: string, address = "t7", headers: Record<string, string> = {}): Promise<View> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}${terminalSocketPath(address)}`, { headers: { Origin: ORIGIN, Cookie: cookie, ...headers } });
    const view: View = {
      ws,
      texts: [],
      output: [],
      closed: undefined,
      send: (m) => ws.send(typeof m === "string" ? m : JSON.stringify(m)),
      sendBinary: (tag, bytes) => ws.send(tagMessage(tag as 0 | 1 | 2, typeof bytes === "string" ? Buffer.from(bytes) : bytes)),
    };
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const buf = data as Buffer;
        expect(buf[0]).toBe(Tag.OUTPUT);
        view.output.push(buf.subarray(1));
      } else {
        const p = parseTerminalServerMessage(data.toString());
        if (!p.ok) throw new Error(`invalid server message: ${data.toString()}`);
        view.texts.push(p.message);
      }
    });
    ws.on("close", (code, reason) => (view.closed = { code, reason: reason.toString() }));
    ws.on("open", () => resolve(view));
    ws.on("unexpected-response", (_r, res) => reject(new Error(`refused: ${res.statusCode}`)));
    ws.on("error", () => {});
  });
}

const text = (v: View) => Buffer.concat(v.output).toString();
const total = (v: View) => v.output.reduce((n, b) => n + b.length, 0);

let h: Harness;
let cookie: string;
const views: View[] = [];

async function start(opts: Partial<BridgeOptions> = {}) {
  h = await startHarness(opts);
  cookie = await h.cookie();
}
async function attach(address = "t7"): Promise<View> {
  const v = await openView(h, cookie, address);
  views.push(v);
  v.send(attachMsg);
  await until(() => v.texts.some((m) => m.type === "attached"));
  return v;
}
const creditFrames = (core = h.core) => core.streamFrames.filter(([, k]) => k === FrameKind.CREDIT);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  for (const v of views.splice(0)) v.ws.terminate();
  await h.stop();
});

describe("who may open a terminal socket", () => {
  beforeEach(() => start());

  it("refuses without a cookie (401), from a foreign or missing Origin (403), and on a path that is no address (404)", async () => {
    await expect(openView(h, "", "t7")).rejects.toThrow("401");
    await expect(openView(h, cookie, "t7", { Origin: "http://evil.example" })).rejects.toThrow("403");
    await expect(
      new Promise((_, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${h.port}${terminalSocketPath("t7")}`, { headers: { Cookie: cookie } });
        ws.on("unexpected-response", (_r, res) => reject(new Error(String(res.statusCode))));
        ws.on("open", () => reject(new Error("opened")));
        ws.on("error", () => {});
      }),
    ).rejects.toThrow("403");
    for (const bad of ["/api/terminal/", "/api/terminal/name", "/api/terminal/a/b/t7", "/api/terminal/%2e%2e%2fws", "/api/terminal/t7%00"]) {
      await expect(
        new Promise((_, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${h.port}${bad}`, { headers: { Origin: ORIGIN, Cookie: cookie } });
          ws.on("unexpected-response", (_r, res) => reject(new Error(String(res.statusCode))));
          ws.on("open", () => reject(new Error("opened")));
          ws.on("error", () => {});
        }),
        bad,
      ).rejects.toThrow("404");
    }
    expect(h.core.attaches).toEqual([]);
  });

  it("does not touch core before the first message, and closes a socket that never sends one", async () => {
    await h.stop();
    await start({ terminal: { attachTimeoutMs: 150 } });
    const v = await openView(h, cookie);
    views.push(v);
    await until(() => v.closed !== undefined);
    expect(v.closed?.code).toBe(TerminalClose.NO_ATTACH);
    expect(h.core.attaches).toEqual([]);
  });

  it("closes a socket whose first message is not a valid attach", async () => {
    for (const first of ['{"type":"resize","cols":80,"rows":24}', "nonsense", '{"type":"attach","cols":0,"rows":1,"history":0,"display":{"fg":null,"bg":null,"cursor":null,"cell":null}}']) {
      const v = await openView(h, cookie);
      views.push(v);
      v.send(first);
      await until(() => v.closed !== undefined);
      expect(v.closed?.code, first).toBe(TerminalClose.PROTOCOL);
    }
    const b = await openView(h, cookie);
    views.push(b);
    b.sendBinary(Tag.INPUT, "x");
    await until(() => b.closed !== undefined);
    expect(b.closed?.code).toBe(TerminalClose.PROTOCOL);
    expect(h.core.attaches).toEqual([]);
  });
});

describe("attaching", () => {
  beforeEach(() => start());

  it("attaches on core with what the browser asked for, says so, and relays the first paint verbatim", async () => {
    const v = await attach("t7");
    expect(h.core.attaches).toHaveLength(1);
    expect(h.core.attaches[0]).toMatchObject({ terminal: "t7", cols: 100, rows: 30, history: 2000, display });
    expect(v.texts[0]).toMatchObject({ type: "attached", automaticInput: true });
    await until(() => total(v) > 0);
    expect(text(v)).toBe("\x18first-paint");
  });

  it("passes a remote address to core as it is", async () => {
    await attach("cachyos/t7");
    expect(h.core.attaches[0]).toMatchObject({ terminal: "cachyos/t7" });
  });

  it("reports automaticInput false when core's path does not support it", async () => {
    await h.stop();
    await start();
    h.core.attachAutomatic = false;
    const v = await attach();
    expect(v.texts[0]).toMatchObject({ type: "attached", automaticInput: false });
  });

  it("holds messages that arrive before the attach finished and applies them after, in order", async () => {
    const v = await openView(h, cookie);
    views.push(v);
    v.send(attachMsg);
    v.send({ type: "resize", cols: 120, rows: 40 });
    v.sendBinary(Tag.INPUT, "ls\r");
    await until(() => h.core.streamFrames.length >= 2);
    expect(h.core.streamFrames.map(([, k]) => k)).toEqual([FrameKind.RESIZE, FrameKind.DATA]);
  });

  it("closes 4404 for a terminal core does not know, 4410 with `ended` for one that finished, 4502 when core is down", async () => {
    h.core.attachErrors.set("t9", { kind: "not_found", message: "no terminal t9" });
    const a = await openView(h, cookie, "t9");
    views.push(a);
    a.send(attachMsg);
    await until(() => a.closed !== undefined);
    expect(a.closed?.code).toBe(TerminalClose.NOT_FOUND);

    h.core.attachErrors.set("t8", { kind: "finished", message: "t8 finished" });
    const b = await openView(h, cookie, "t8");
    views.push(b);
    b.send(attachMsg);
    await until(() => b.closed !== undefined);
    expect(b.closed?.code).toBe(TerminalClose.FINISHED);
    expect(b.texts).toEqual([{ type: "ended", reason: "finished", exitCode: null, signal: null }]);

    h.core.attachErrors.set("t6", { kind: "unavailable", message: "machine line down" });
    const u = await openView(h, cookie, "t6");
    views.push(u);
    u.send(attachMsg);
    await until(() => u.closed !== undefined);
    expect(u.closed?.code).toBe(TerminalClose.CORE_UNAVAILABLE);

    await h.core.stop();
    const c = await openView(h, cookie);
    views.push(c);
    c.send(attachMsg);
    await until(() => c.closed !== undefined);
    expect(c.closed?.code).toBe(TerminalClose.CORE_UNAVAILABLE);
  });

  it("does not attach to a terminal core already lists as finished", async () => {
    h.core.terminals = [{ address: "t5", state: "finished", reason: "exited", exit_code: 2, signal: null } as never];
    h.session.store.replaceSnapshot(h.core.seq, h.core.terminals as never);
    const v = await openView(h, cookie, "t5");
    views.push(v);
    v.send(attachMsg);
    await until(() => v.closed !== undefined);
    expect(v.closed?.code).toBe(TerminalClose.FINISHED);
    expect(v.texts).toEqual([{ type: "ended", reason: "exited", exitCode: 2, signal: null }]);
    expect(h.core.attaches).toEqual([]);
  });
});

describe("what goes to core", () => {
  beforeEach(() => start());

  it("human input is DATA, automatic replies are kind 6, byte for byte, in order", async () => {
    const v = await attach();
    const keys = Uint8Array.from([0x1b, 0x5b, 0x31, 0x3b, 0x32, 0x75, 0xff, 0x00]);
    v.sendBinary(Tag.INPUT, "ab");
    v.sendBinary(Tag.AUTOMATIC, "\x1b[?1;2c");
    v.sendBinary(Tag.INPUT, keys);
    v.sendBinary(Tag.AUTOMATIC, "\x1b[?0u");
    await until(() => h.core.streamFrames.length >= 4);
    const [a, b, c, d] = h.core.streamFrames;
    expect([a![1], a![2].toString()]).toEqual([FrameKind.DATA, "ab"]);
    expect([b![1], b![2].toString()]).toEqual([FrameKind.AUTOMATIC_INPUT, "\x1b[?1;2c"]);
    expect([c![1], [...c![2]]]).toEqual([FrameKind.DATA, [...keys]]);
    expect([d![1], d![2].toString()]).toEqual([FrameKind.AUTOMATIC_INPUT, "\x1b[?0u"]);
  });

  it("without automatic support, automatic replies go as DATA", async () => {
    await h.stop();
    await start();
    h.core.attachAutomatic = false;
    const v = await attach();
    v.sendBinary(Tag.AUTOMATIC, "\x1b[c");
    await until(() => h.core.streamFrames.length >= 1);
    expect(h.core.streamFrames[0]![1]).toBe(FrameKind.DATA);
  });

  it("resize, focus and display facts become RESIZE, FOCUS and FACTS", async () => {
    const v = await attach();
    v.send({ type: "resize", cols: 90, rows: 20 });
    v.send({ type: "focus", focused: true });
    v.send({ type: "display", display: { ...display, cell: [10, 20] } });
    await until(() => h.core.streamFrames.length >= 3);
    const [r, f, d] = h.core.streamFrames;
    expect([r![1], r![2].readUInt16LE(0), r![2].readUInt16LE(2)]).toEqual([FrameKind.RESIZE, 90, 20]);
    expect([f![1], [...f![2]]]).toEqual([FrameKind.FOCUS, [1]]);
    expect(d![1]).toBe(FrameKind.FACTS);
    expect(JSON.parse(d![2].toString())).toMatchObject({ cell: [10, 20] });
  });

  it("closes a view that breaks the rules: output tag from the browser, unknown tag, empty binary, second attach, invalid JSON", async () => {
    const cases: Array<(v: View) => void> = [
      (v) => v.sendBinary(Tag.OUTPUT, "x"),
      (v) => v.sendBinary(9, "x"),
      (v) => v.ws.send(Buffer.alloc(0), { binary: true }),
      (v) => v.send(attachMsg),
      (v) => v.send("{"),
      (v) => v.send({ type: "resize", cols: 0, rows: 5 }),
    ];
    for (const [i, bad] of cases.entries()) {
      const v = await attach();
      bad(v);
      await until(() => v.closed !== undefined);
      expect(v.closed?.code, `case ${i}`).toBe(TerminalClose.PROTOCOL);
    }
  });

  it("closing the browser socket detaches on core and drops the connection", async () => {
    const v = await attach();
    v.ws.close();
    await until(() => h.core.streamFrames.some(([, k]) => k === FrameKind.CLOSE) || h.core.attachedChannels.length === 0);
    await until(() => h.core.attachedChannels.length === 0);
    await until(() => h.bridge.terminalCount() === 0);
  });
});

describe("what comes back and flow control", () => {
  beforeEach(() => start({ terminal: { maxOutstandingBytes: 512 * 1024 } }));

  it("gives core CREDIT only for bytes the browser says it consumed", async () => {
    const v = await attach();
    const channel = h.core.attachedChannels[0]!;
    h.core.streamOut(channel, Buffer.alloc(100_000, 0x61));
    await until(() => total(v) >= 100_000 + "\x18first-paint".length);
    await sleep(60);
    expect(creditFrames()).toHaveLength(0);

    v.send({ type: "consumed", bytes: 60_000 });
    await until(() => creditFrames().length === 1);
    expect(creditFrames()[0]![2].readUInt32LE(0)).toBe(60_000);
    v.send({ type: "consumed", bytes: 40_000 + "\x18first-paint".length });
    await until(() => creditFrames().length === 2);
    expect(creditFrames()[1]![2].readUInt32LE(0)).toBe(40_000 + "\x18first-paint".length);
  });

  it("closes a view that claims to have consumed more than it was sent", async () => {
    const v = await attach();
    await until(() => total(v) > 0);
    v.send({ type: "consumed", bytes: 1_000_000 });
    await until(() => v.closed !== undefined);
    expect(v.closed?.code).toBe(TerminalClose.PROTOCOL);
    expect(creditFrames()).toHaveLength(0);
  });

  it("a browser that stops reading: core is given no credit and the bridge closes the view at its bound instead of buffering", async () => {
    const v = await attach();
    const channel = h.core.attachedChannels[0]!;
    // A core obeying the window would stop at 256 KiB; a misbehaving one keeps going. The bridge holds at most its bound.
    for (let i = 0; i < 40 && v.closed === undefined; i++) {
      h.core.streamOut(channel, Buffer.alloc(64 * 1024, 0x62));
      await sleep(5);
    }
    await until(() => v.closed !== undefined);
    expect(v.closed?.code).toBe(TerminalClose.TOO_SLOW);
    expect(creditFrames()).toHaveLength(0);
    expect(total(v)).toBeLessThanOrEqual(512 * 1024 + 64 * 1024);
    await until(() => h.core.attachedChannels.length === 0);
  });

  it("a terminal that ends mid-stream: the rest is delivered, then `ended` and a normal close", async () => {
    const v = await attach();
    const channel = h.core.attachedChannels[0]!;
    h.core.streamOut(channel, Buffer.from("bye\r\n"));
    h.core.streamEnd(channel, "exited", 7, null);
    await until(() => v.closed !== undefined);
    expect(text(v)).toBe("\x18first-paintbye\r\n");
    expect(v.texts.at(-1)).toEqual({ type: "ended", reason: "exited", exitCode: 7, signal: null });
    expect(v.closed?.code).toBe(TerminalClose.ENDED);
  });

  it("a signal death is reported as such", async () => {
    const v = await attach();
    h.core.streamEnd(h.core.attachedChannels[0]!, "killed", null, 9);
    await until(() => v.closed !== undefined);
    expect(v.texts.at(-1)).toEqual({ type: "ended", reason: "killed", exitCode: null, signal: 9 });
  });

  it("core dropping the line closes the view with 4502 and no `ended`", async () => {
    const v = await attach();
    h.core.dropConnections();
    await until(() => v.closed !== undefined);
    expect(v.closed?.code).toBe(TerminalClose.CORE_UNAVAILABLE);
    expect(v.texts.some((m) => m.type === "ended")).toBe(false);
  });

  it("two views on one terminal are independent connections", async () => {
    const a = await attach();
    const b = await attach();
    expect(h.core.attachedChannels).toHaveLength(2);
    a.ws.close();
    await until(() => h.core.attachedChannels.length === 1);
    expect(b.closed).toBeUndefined();
  });
});

describe("a core that stops reading input", () => {
  it("is not fed without bound: past the bridge's limit the view is closed", async () => {
    await start({ terminal: { maxQueuedToCoreBytes: 64 * 1024 } });
    const v = await attach();
    // Freeze the fake core's reading side so the bridge's socket write buffer fills.
    for (const s of (h.core as unknown as { sockets: Set<{ pause(): void }> }).sockets) s.pause();
    const chunk = Buffer.alloc(32 * 1024, 0x63);
    for (let i = 0; i < 400 && v.closed === undefined; i++) {
      v.sendBinary(Tag.INPUT, chunk);
      await sleep(2);
    }
    await until(() => v.closed !== undefined, 5000);
    expect(v.closed?.code).toBe(TerminalClose.TOO_SLOW);
  });
});
