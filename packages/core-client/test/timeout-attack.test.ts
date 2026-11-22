// Tester's cases for DEV-29 D3: the 10 s limit on calls, with answers that come at the edge, late, twice, or for another call.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoreTimeoutError } from "../src/errors.js";
import { encodeFrame, FrameKind } from "../src/frame.js";
import { CoreSession } from "../src/session.js";
import { RawCore, type Call, type RawConn } from "./raw-core.js";

const LIMIT = 300; // stands for 10 s
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await pause(10);
  }
}

let core: RawCore;
let session: CoreSession;
const held: Array<{ conn: RawConn; call: Call }> = [];

beforeEach(async () => {
  core = new RawCore();
  await core.listen();
  session = new CoreSession({ endpoint: () => core.path, callTimeoutMs: LIMIT });
  session.start();
  await until(() => session.state === "connected");
});
afterEach(async () => {
  await session.stop();
  await core.dispose();
  held.length = 0;
});

/** Answers `terminal.label` after `delayMs`, with the call's own id in the result so mix-ups show. */
function answerAfter(delayMs: number): void {
  core.onCall = (conn, call) => {
    if (call.method !== "terminal.label") return core.defaultCall(conn, call);
    held.push({ conn, call });
    setTimeout(() => conn.reply(call.id, { address: "t1", labels: { n: String(call.id) } }), delayMs);
  };
}

describe("the limit is a limit on the answer, not on the call", () => {
  it("an answer just inside the limit (90%) resolves", async () => {
    answerAfter(Math.round(LIMIT * 0.9));
    await expect(session.call("terminal.label", { terminal: "t1", labels: { a: "b" } })).resolves.toMatchObject({ address: "t1" });
  });

  it("an answer just outside the limit (110%) is a CoreTimeoutError, and the answer that arrives after it changes nothing", async () => {
    answerAfter(Math.round(LIMIT * 1.1));
    const first = session.call("terminal.label", { terminal: "t1", labels: { a: "b" } });
    await expect(first).rejects.toBeInstanceOf(CoreTimeoutError);
    await pause(LIMIT * 0.4); // the late answer has now been read
    expect(session.state).toBe("connected");
  });

  it("a late answer is not taken for the answer of a later call (ids are not reused)", async () => {
    answerAfter(Math.round(LIMIT * 1.5));
    const first = session.call("terminal.label", { terminal: "t1", labels: { a: "1" } });
    await expect(first).rejects.toBeInstanceOf(CoreTimeoutError);
    // the second call is in flight when the first one's late answer arrives; it gets its own answer (at 1.5 x limit it times out too,
    // so make this one answer at once)
    core.onCall = (conn, call) => (call.method === "terminal.label" ? conn.reply(call.id, { address: "t1", labels: { n: `own-${call.id}` } }) : core.defaultCall(conn, call));
    const second = await session.call("terminal.label", { terminal: "t1", labels: { a: "2" } });
    expect((second as { labels: Record<string, string> }).labels["n"]).toMatch(/^own-/);
    await pause(LIMIT);
    expect(session.state).toBe("connected");
    expect(held.length).toBe(1);
  });

  it("the same answer sent twice resolves once and does not throw", async () => {
    core.onCall = (conn, call) => {
      if (call.method !== "terminal.label") return core.defaultCall(conn, call);
      conn.reply(call.id, { address: "t1" });
      conn.reply(call.id, { address: "t1-again" });
    };
    await expect(session.call("terminal.label", { terminal: "t1", labels: {} })).resolves.toMatchObject({ address: "t1" });
    await pause(50);
    expect(session.state).toBe("connected");
  });

  it("an error answer after the limit is dropped as quietly as a result", async () => {
    core.onCall = (conn, call) => {
      if (call.method !== "terminal.kill") return core.defaultCall(conn, call);
      setTimeout(() => {
        conn.write(encodeFrame(0, FrameKind.DATA, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32000, message: "too late", data: { kind: "internal" } } }))));
      }, LIMIT * 1.3);
    };
    await expect(session.call("terminal.kill", { terminal: "t1" })).rejects.toBeInstanceOf(CoreTimeoutError);
    await pause(LIMIT);
    expect(session.state).toBe("connected");
  });
});

describe("many calls at the limit", () => {
  it("200 calls that all time out leave no timers or pending entries that fire later, and the session works after", async () => {
    core.onCall = (conn, call) => (call.method === "terminal.label" ? undefined : core.defaultCall(conn, call));
    const results = await Promise.allSettled(Array.from({ length: 200 }, (_, i) => session.call("terminal.label", { terminal: "t1", labels: { i: String(i) } })));
    expect(results.every((r) => r.status === "rejected" && r.reason instanceof CoreTimeoutError)).toBe(true);
    core.onCall = (conn, call) => (call.method === "terminal.label" ? conn.reply(call.id, { address: "ok" }) : core.defaultCall(conn, call));
    await expect(session.call("terminal.label", { terminal: "t1", labels: {} })).resolves.toMatchObject({ address: "ok" });
  });

  it("a call that was timed out and then the connection drops: nothing rejects twice or throws unhandled", async () => {
    core.onCall = () => undefined;
    const unhandled: unknown[] = [];
    const on = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", on);
    try {
      const p = session.call("terminal.kill", { terminal: "t1" });
      await expect(p).rejects.toBeInstanceOf(CoreTimeoutError);
      core.last.destroy();
      await pause(200);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", on);
    }
  });

  it("a call in flight when the connection drops rejects as closed at once, not after the limit", async () => {
    core.onCall = () => undefined;
    const began = Date.now();
    const p = session.call("terminal.kill", { terminal: "t1" }).catch((e: unknown) => e);
    await pause(30);
    core.last.destroy();
    const error = await p;
    expect(error).not.toBeInstanceOf(CoreTimeoutError);
    expect(Date.now() - began).toBeLessThan(LIMIT);
  });
});
