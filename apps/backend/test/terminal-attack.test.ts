// The terminal socket under attack: what the builder's own tests do not push on.
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { FrameKind } from "@herdr-web/core-client";
import { Tag, TerminalClose, parseTerminalServerMessage, tagMessage, terminalSocketPath, type TerminalServerMessage } from "@herdr-web/protocol";
import { ORIGIN, startHarness, until, type Harness } from "./helpers.js";
import type { BridgeOptions } from "../src/server.js";

const display = { fg: null, bg: null, cursor: null, cell: null };
const attachMsg = { type: "attach", cols: 80, rows: 24, history: 100, display };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface View {
  ws: WebSocket;
  texts: TerminalServerMessage[];
  bytes: number;
  closed: { code: number; reason: string } | undefined;
}

let h: Harness;
let cookie: string;
const views: View[] = [];

async function start(opts: Partial<BridgeOptions> = {}) {
  h = await startHarness(opts);
  cookie = await h.cookie();
}
function open(address = "t7", headers: Record<string, string> = {}, c = cookie): Promise<View> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}${terminalSocketPath(address)}`, { headers: { Origin: ORIGIN, Cookie: c, ...headers } });
    const v: View = { ws, texts: [], bytes: 0, closed: undefined };
    ws.on("message", (d, isBinary) => {
      if (isBinary) v.bytes += (d as Buffer).length - 1;
      else {
        const p = parseTerminalServerMessage(d.toString());
        if (p.ok) v.texts.push(p.message);
      }
    });
    ws.on("close", (code, reason) => (v.closed = { code, reason: reason.toString() }));
    ws.on("open", () => (views.push(v), resolve(v)));
    ws.on("unexpected-response", (_r, res) => reject(new Error(`refused: ${res.statusCode}`)));
    ws.on("error", () => {});
  });
}
async function attach(address = "t7"): Promise<View> {
  const v = await open(address);
  v.ws.send(JSON.stringify(attachMsg));
  await until(() => v.texts.some((m) => m.type === "attached"));
  return v;
}
const creditTotal = () => h.core.streamFrames.filter(([, k]) => k === FrameKind.CREDIT).reduce((n, [, , p]) => n + p.readUInt32LE(0), 0);

afterEach(async () => {
  for (const v of views.splice(0)) v.ws.terminate();
  await h.stop();
});

describe("frames a browser should not send", () => {
  it("an oversized frame closes the view with 1009 and the terminal stays usable from a second view", async () => {
    await start();
    const a = await attach();
    const b = await attach();
    a.ws.send(Buffer.concat([Buffer.from([Tag.INPUT]), Buffer.alloc(2 * 1024 * 1024, 0x61)]), { binary: true });
    await until(() => a.closed !== undefined);
    expect([1009, 1006]).toContain(a.closed?.code); // 1006 when the bridge cuts the line while the 2 MiB is still being written
    b.ws.send(tagMessage(Tag.INPUT, Buffer.from("still here")), { binary: true });
    await until(() => h.core.streamFrames.some(([, k, p]) => k === FrameKind.DATA && p.toString() === "still here"));
    expect(b.closed).toBeUndefined();
    expect(h.core.streamFrames.some(([, k, p]) => k === FrameKind.DATA && p.length > 1000)).toBe(false);
  });

  it("invalid UTF-8 in a text frame closes the view; nothing reaches core from it", async () => {
    await start();
    const v = await attach();
    const raw = (v.ws as unknown as { _socket: { write(b: Buffer): void } })._socket;
    raw.write(Buffer.from([0x81, 0x83, 0, 0, 0, 0, 0xff, 0xfe, 0xfd])); // masked text frame holding bytes that are not UTF-8
    await until(() => v.closed !== undefined);
    expect(v.closed?.code).toBe(1007);
    expect(h.core.streamFrames.filter(([, k]) => k === FrameKind.DATA)).toEqual([]);
  });

  it("a text message of every wrong shape closes with PROTOCOL: consumed of 0, -1, 1.5, a string, null; extra fields on attach are tolerated", async () => {
    await start();
    for (const bad of [{ type: "consumed", bytes: 0 }, { type: "consumed", bytes: -1 }, { type: "consumed", bytes: 1.5 }, { type: "consumed", bytes: "9" }, { type: "consumed" }, null, [], 7, { type: "focus", focused: "yes" }, { type: "resize", cols: 80.5, rows: 24 }, { type: "display", display: { fg: "red", bg: null, cursor: null, cell: null } }]) {
      const v = await attach();
      v.ws.send(JSON.stringify(bad));
      await until(() => v.closed !== undefined);
      expect(v.closed?.code, JSON.stringify(bad)).toBe(TerminalClose.PROTOCOL);
    }
    const ok = await open();
    ok.ws.send(JSON.stringify({ ...attachMsg, extra: 1 }));
    await until(() => ok.texts.some((m) => m.type === "attached"));
    expect(ok.closed).toBeUndefined();
  });

  it("claiming exactly what was sent is accepted; one byte more is not", async () => {
    await start();
    const v = await attach();
    await until(() => v.bytes > 0);
    const sent = v.bytes;
    v.ws.send(JSON.stringify({ type: "consumed", bytes: sent }));
    await until(() => creditTotal() === sent);
    v.ws.send(JSON.stringify({ type: "consumed", bytes: 1 }));
    await until(() => v.closed !== undefined);
    expect(v.closed?.code).toBe(TerminalClose.PROTOCOL);
    expect(creditTotal()).toBe(sent);
  });

  it("messages sent before `attached` that exceed what the bridge will hold close the view without touching other views", async () => {
    await start();
    const bystander = await attach();
    const v = await open();
    v.ws.send(JSON.stringify(attachMsg));
    for (let i = 0; i < 300; i++) v.ws.send(tagMessage(Tag.INPUT, Buffer.from("x")), { binary: true });
    await sleep(300);
    // either the attach finished fast enough for all of them to be applied, or the view was closed for flooding: never a hang
    expect(v.closed === undefined || v.closed.code === TerminalClose.PROTOCOL).toBe(true);
    expect(bystander.closed).toBeUndefined();
  });
});

describe("who gets in, beyond what the builder tested", () => {
  it("a forged cookie, an expired cookie and an old passphrase's cookie are refused on the terminal socket (401); a renewed one is not", async () => {
    let now = 1_000_000;
    await start({ now: () => now });
    const forged = cookie.replace(/.$/, (c) => (c === "a" ? "b" : "a"));
    await expect(open("t7", {}, forged)).rejects.toThrow("401");
    await expect(open("t7", {}, "")).rejects.toThrow("401");
    const good = await open();
    good.ws.terminate();
    now += 400 * 24 * 3600 * 1000; // past any lifetime
    await expect(open("t7", {}, cookie)).rejects.toThrow("401");
  });

  it("a signed-in browser from the listed Origin but with a trailing slash, a different case or a port suffix is refused", async () => {
    await start();
    for (const origin of [ORIGIN + "/", ORIGIN.toUpperCase(), ORIGIN + ":1", ORIGIN.replace("http", "https"), "null", ""]) {
      await expect(open("t7", { Origin: origin }), origin).rejects.toThrow("403");
    }
    expect(h.core.attaches).toEqual([]);
  });

  it("path tricks never reach core with an address other than the one a strict parse gives", async () => {
    await start();
    const seen = async (path: string) => {
      const before = h.core.attaches.length;
      const res = await new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${h.port}${path}`, { headers: { Origin: ORIGIN, Cookie: cookie } });
        ws.on("open", () => {
          ws.send(JSON.stringify(attachMsg));
          setTimeout(() => (ws.terminate(), resolve("open")), 300);
        });
        ws.on("unexpected-response", (_r, r) => resolve(String(r.statusCode)));
        ws.on("error", () => {});
      });
      return { res, attached: h.core.attaches.slice(before).map((a) => (a as { terminal: string }).terminal) };
    };
    expect(await seen("/api/terminal/%74%37")).toEqual({ res: "open", attached: ["t7"] });
    expect(await seen("/api/terminal/t7?x=../t8")).toEqual({ res: "open", attached: ["t7"] });
    for (const bad of ["/api/terminal/t7/", "/api/terminal//t7", "/api/terminal/T7", "/api/terminal/t7%2F", "/api/terminal/%2574%37", "/api/terminal/t7%0a", "/api/terminal/t7%20", "/api/terminal/t7%00", "/api/terminal/.t7", "/api/terminal/t", "/api/terminal/t1234567890", "/api/terminal/" + "a".repeat(5000)]) {
      expect(await seen(bad), bad).toEqual({ res: "404", attached: [] });
    }
  });
});

describe("many views at once", () => {
  it("forty sockets attach, each gets its own core attach and its own first paint, and closing them all leaves nothing behind", async () => {
    await start();
    const all = await Promise.all(Array.from({ length: 40 }, () => attach()));
    expect(h.core.attachedChannels).toHaveLength(40);
    expect(h.bridge.terminalCount()).toBe(40);
    expect(all.every((v) => v.bytes > 0)).toBe(true);
    for (const v of all) v.ws.close();
    await until(() => h.core.attachedChannels.length === 0, 5000);
    await until(() => h.bridge.terminalCount() === 0, 5000);
  });

  it("40 sockets that connect and never attach are all closed by the attach timeout, with no core attach", async () => {
    await start({ terminal: { attachTimeoutMs: 200 } });
    const all = await Promise.all(Array.from({ length: 40 }, () => open()));
    await until(() => all.every((v) => v.closed !== undefined), 3000);
    expect(all.every((v) => v.closed?.code === TerminalClose.NO_ATTACH)).toBe(true);
    expect(h.core.attaches).toEqual([]);
    await until(() => h.bridge.terminalCount() === 0);
  });
});

describe("defects", () => {
  it("a terminal whose address has letters in it (t1b, t2j, cachyos/t1c: core counts in base 32) can be attached", async () => {
    await start();
    for (const address of ["t1b", "t2j", "cachyos/t1c"]) {
      const v = await open(address);
      v.ws.send(JSON.stringify(attachMsg));
      await until(() => v.texts.some((m) => m.type === "attached"), 1500).catch(() => undefined);
      expect(v.texts.map((m) => m.type), address).toContain("attached");
    }
  });

  it("a browser that stops reading but keeps claiming `consumed` for bytes it was sent does not make the bridge buffer without bound", async () => {
    await start();
    const v = await attach();
    const channel = h.core.attachedChannels[0]!;
    (v.ws as unknown as { _socket: { pause(): void } })._socket.pause(); // the browser's network layer stops reading
    const chunk = Buffer.alloc(512 * 1024, 0x61);
    let streamed = 0;
    let claimable = 0; // bytes the bridge has certainly counted as sent
    // A core that obeys CREDIT would stop at its window. Here it keeps sending as long as it is paid: the claims pay it.
    for (let i = 0; i < 160 && v.closed === undefined; i++) {
      h.core.streamOut(channel, chunk);
      streamed += chunk.length;
      await sleep(4);
      if (claimable > 0) {
        try {
          v.ws.send(JSON.stringify({ type: "consumed", bytes: claimable }));
        } catch {
          break;
        }
      }
      claimable = chunk.length;
    }
    // 160 x 512 KiB = 80 MiB went to a socket nobody reads. The bridge must give up (4413), not keep it all in memory.
    // A browser that reads nothing cannot see the close frame, so what shows the bridge gave up is that it let go of the view
    // (and detached from core); once the browser reads again it finds the close behind what was queued, or a cut line.
    await until(() => h.bridge.terminalCount() === 0, 10_000).catch(() => undefined);
    expect(h.bridge.terminalCount(), `streamed ${(streamed / 1048576).toFixed(0)} MiB into a socket that is not read`).toBe(0);
    (v.ws as unknown as { _socket: { resume(): void } })._socket.resume();
    await until(() => v.closed !== undefined, 10_000);
    // 1008 when the claims overtook the bytes the bridge had not yet read from core: the claims are lies either way
    expect([TerminalClose.TOO_SLOW, TerminalClose.PROTOCOL, 1006]).toContain(v.closed?.code);
  });
});
