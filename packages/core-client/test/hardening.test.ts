// Tester's cases for DEV-21: malformed and awkward input from core, and reconnect timing.
// Tests under "defects" fail on the current product code; see the report on DEV-21.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoreConnection } from "../src/connection.js";
import { ConnectionClosedError } from "../src/errors.js";
import { encodeFrame, FrameKind, HEADER_SIZE, MAX_PAYLOAD } from "../src/frame.js";
import { CoreSession } from "../src/session.js";
import type { MachineView, Terminal } from "../src/types.js";
import { eventLine, RawCore, type RawConn } from "./raw-core.js";

function term(address: string, extra: Partial<Terminal> = {}): Terminal {
  return { address, argv: ["sh"], cols: 80, rows: 24, created_ms: 1, cwd: "/", state: "live", screen: "exact", labels: {}, ...extra };
}

const machine = (name: string, state = "connected"): MachineView => ({ name, target: "x", id: name, host: "h", version: "1", state });

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A frame header that announces more than the 16 MiB limit. */
function oversizedHeader(channel: number): Buffer {
  const h = Buffer.alloc(HEADER_SIZE);
  h.writeUInt32LE(channel, 0);
  h.writeUInt32LE(MAX_PAYLOAD + 1, 5);
  return h;
}

function errorReply(conn: RawConn, id: number, message: string): void {
  conn.write(
    encodeFrame(0, FrameKind.DATA, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message, data: { kind: "internal", hint: "h" } } }))),
  );
}

let core: RawCore;
let session: CoreSession | undefined;
const logs: string[] = [];

beforeEach(async () => {
  core = new RawCore();
  await core.listen();
  logs.length = 0;
});
afterEach(async () => {
  await session?.stop();
  session = undefined;
  await core.dispose();
});

function start(extra: ConstructorParameters<typeof CoreSession>[0] = {}): CoreSession {
  session = new CoreSession({
    endpoint: () => core.path,
    backoff: { initialMs: 20, maxMs: 100 },
    machinePollMs: 10_000,
    log: (level, m) => logs.push(`${level}: ${m}`),
    ...extra,
  });
  session.start();
  return session;
}

async function connected(s: CoreSession): Promise<void> {
  await until(() => s.state === "connected");
}

describe("frames from core", () => {
  it("ignores a frame of an unknown kind on channel 0 and on the event channel", async () => {
    core.terminals = [term("t1")];
    const s = start();
    await connected(s);
    core.last.write(encodeFrame(0, 99, Buffer.from("whatever")));
    core.last.write(encodeFrame(1, 77, Buffer.from("whatever")));
    core.last.write(encodeFrame(9, FrameKind.FACTS, Buffer.from("{}")));
    core.last.event(1, "title", "t1", { title: "after unknown kinds" });
    await until(() => s.store.get("t1")?.title === "after unknown kinds");
    expect(core.connections).toHaveLength(1);
  });

  it("an empty DATA frame on the event channel is harmless and earns no credit", async () => {
    core.terminals = [term("t1")];
    const s = start();
    await connected(s);
    const conn = core.last;
    conn.stream(1, new Uint8Array());
    conn.event(1, "title", "t1", { title: "after empty" });
    await until(() => s.store.get("t1")?.title === "after empty");
    expect(core.connections).toHaveLength(1);
    expect(conn.frames.filter((f) => f.kind === FrameKind.CREDIT).every((f) => f.payload.readUInt32LE(0) > 0)).toBe(true);
  });

  it("credits every byte it read from the event channel, across frames", async () => {
    core.terminals = [term("t1")];
    const s = start();
    await connected(s);
    const conn = core.last;
    let sent = 0;
    for (let i = 1; i <= 5; i++) {
      const line = eventLine(i, "title", "t1", { title: "x".repeat(i * 50) });
      sent += Buffer.byteLength(line);
      conn.stream(1, line);
    }
    await until(() => s.store.seq === 5);
    await until(() => conn.credited(1) === sent);
  });

  it("reads an event line split across frames, a multi-byte character split across frames, and two events in one frame", async () => {
    core.terminals = [term("t1", { title: "" }), term("t2", { title: "" })];
    const s = start();
    await connected(s);
    const conn = core.last;

    const first = Buffer.from(eventLine(1, "title", "t1", { title: "héllo ✓ wörld" }));
    const cut = first.indexOf(Buffer.from("✓")) + 1; // inside the 3-byte character
    conn.stream(1, first.subarray(0, cut));
    await pause(30);
    expect(s.store.get("t1")?.title).toBe(""); // line not finished yet
    conn.stream(1, first.subarray(cut));
    await until(() => s.store.get("t1")?.title === "héllo ✓ wörld");

    conn.stream(1, eventLine(2, "title", "t2", { title: "a" }) + eventLine(3, "size", "t2", { cols: 10, rows: 5 }));
    await until(() => s.store.seq === 3);
    expect(s.store.get("t2")).toMatchObject({ title: "a", cols: 10, rows: 5 });
  });

  it("an oversized frame header ends the connection; the session reconnects and takes a fresh snapshot", async () => {
    core.terminals = [term("t1")];
    const s = start();
    await connected(s);
    core.terminals = [term("t1"), term("t2")];
    core.last.write(oversizedHeader(1));
    await until(() => s.store.get("t2") !== undefined && s.state === "connected");
    expect(core.connections).toHaveLength(2);
    expect(logs.some((l) => l.includes("exceeds"))).toBe(true);
  });

  it("an oversized frame header rejects the call in flight", async () => {
    core.onCall = (conn) => conn.write(oversizedHeader(0));
    const conn = await CoreConnection.connect({ path: core.path });
    await expect(conn.call("anything", {})).rejects.toThrow(/exceeds/);
    expect(conn.isClosed).toBe(true);
  });

  it("a socket closing in the middle of a frame header rejects the call in flight", async () => {
    core.onCall = (conn) => {
      conn.write(encodeFrame(0, FrameKind.DATA, Buffer.from("{}")).subarray(0, 5));
      setTimeout(() => conn.destroy(), 10);
    };
    const conn = await CoreConnection.connect({ path: core.path });
    await expect(conn.call("anything", {})).rejects.toBeInstanceOf(ConnectionClosedError);
  });

  it("a socket closing in the middle of a frame payload rejects the call in flight", async () => {
    core.onCall = (conn, call) => {
      const whole = encodeFrame(0, FrameKind.DATA, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: { big: "y".repeat(1000) } })));
      conn.write(whole.subarray(0, whole.length - 10));
      setTimeout(() => conn.destroy(), 10);
    };
    const conn = await CoreConnection.connect({ path: core.path });
    await expect(conn.call("anything", {})).rejects.toBeInstanceOf(ConnectionClosedError);
  });

  it("half an event frame and then a closed socket applies nothing; the session reconnects", async () => {
    core.terminals = [term("t1")];
    const s = start();
    await connected(s);
    core.terminals = [term("t1", { title: "from snapshot" })];
    const frame = encodeFrame(1, FrameKind.DATA, Buffer.from(eventLine(1, "title", "t1", { title: "half" })));
    core.last.write(frame.subarray(0, frame.length - 6));
    await pause(30);
    core.last.destroy();
    await until(() => s.store.get("t1")?.title === "from snapshot" && s.state === "connected");
    expect(core.connections).toHaveLength(2);
  });

  it("invalid JSON on the event channel ends the connection; the session reconnects", async () => {
    core.terminals = [term("t1")];
    const s = start();
    await connected(s);
    core.terminals = [term("t1", { title: "recovered" })];
    core.last.stream(1, "{not json\n");
    await until(() => s.store.get("t1")?.title === "recovered" && s.state === "connected");
    expect(core.connections).toHaveLength(2);
  });
});

describe("reconnect", () => {
  it("core going away while events.subscribe is in flight: the session retries and gets its snapshot", async () => {
    core.terminals = [term("t1")];
    let first = true;
    core.onCall = (conn, call) => {
      if (call.method === "events.subscribe" && first) {
        first = false;
        setTimeout(() => conn.destroy(), 30); // never answered
        return;
      }
      core.defaultCall(conn, call);
    };
    const s = start();
    await until(() => s.state === "connected" && s.store.get("t1") !== undefined);
    expect(core.connections.length).toBeGreaterThanOrEqual(2);
    expect(s.lastError).toBeNull();
  });

  it("core stopping while machine.list is in flight: the session reconnects and has machines again", async () => {
    core.terminals = [term("t1")];
    core.machines = [machine("cachyos")];
    let first = true;
    core.onCall = (conn, call) => {
      if (call.method === "machine.list" && first) {
        first = false;
        setTimeout(() => conn.destroy(), 30);
        return;
      }
      core.defaultCall(conn, call);
    };
    const s = start();
    await until(() => s.store.machines.length === 1);
    expect(core.connections.length).toBeGreaterThanOrEqual(2);
  });

  it("an event between the snapshot and the machine.list reply is applied, and the machines still arrive", async () => {
    core.onCall = (conn, call) => {
      if (call.method === "events.subscribe") {
        conn.reply(call.id, { seq: 5, terminals: [term("t1")], channel: 1 });
        conn.event(6, "title", "t1", { title: "between" });
      } else if (call.method === "machine.list") {
        setTimeout(() => conn.reply(call.id, { machines: [machine("cachyos")] }), 100);
      }
    };
    const s = start();
    await until(() => s.store.get("t1")?.title === "between");
    expect(s.store.machines).toEqual([]);
    expect(s.store.seq).toBe(6);
    await until(() => s.store.machines.length === 1);
    expect(s.store.get("t1")?.title).toBe("between");
  });

  it("events already in the snapshot, replayed right after the subscribe reply, are dropped", async () => {
    core.onCall = (conn, call) => {
      if (call.method === "events.subscribe") {
        conn.reply(call.id, { seq: 5, terminals: [term("t1", { title: "snapshot" })], channel: 1 });
        conn.event(4, "title", "t1", { title: "older" });
        conn.event(5, "title", "t1", { title: "same seq" });
        conn.event(6, "title", "t1", { title: "next" });
      } else core.defaultCall(conn, call);
    };
    const s = start();
    await until(() => s.store.seq === 6);
    expect(s.store.get("t1")?.title).toBe("next");
  });

  it("after a restart the old seq does not mask new events", async () => {
    core.terminals = [term("t1")];
    core.seq = 900;
    const s = start();
    await connected(s);
    core.seq = 2;
    core.last.destroy();
    await until(() => core.connections.length === 2 && s.state === "connected" && s.store.seq === 2);
    core.last.event(3, "title", "t1", { title: "new life" });
    await until(() => s.store.get("t1")?.title === "new life");
  });

  it("the machine list follows core: replaced after a reconnect, even with none left", async () => {
    core.terminals = [term("t1")];
    core.machines = [machine("cachyos")];
    const s = start();
    await until(() => s.store.machines.length === 1);
    core.machines = [];
    core.last.destroy();
    await until(() => core.connections.length === 2 && s.state === "connected");
    await until(() => s.store.machines.length === 0);
  });

  it("polls machine.list, since core sends no event when a machine changes", async () => {
    core.machines = [machine("cachyos", "connected")];
    const s = start({ machinePollMs: 40 });
    await until(() => s.store.machines[0]?.state === "connected");
    core.machines = [machine("cachyos", "unreachable")];
    await until(() => s.store.machines[0]?.state === "unreachable");
  });

  it("a failing machine.list is logged; the session stays connected with its terminals", async () => {
    core.terminals = [term("t1")];
    core.onCall = (conn, call) => (call.method === "machine.list" ? errorReply(conn, call.id, "no machines today") : core.defaultCall(conn, call));
    const s = start();
    await connected(s);
    await until(() => logs.some((l) => l.includes("no machines today")));
    expect(s.state).toBe("connected");
    expect(s.store.list()).toHaveLength(1);
    expect(core.connections).toHaveLength(1);
  });

  it("a subscribe refused by core is reported in lastError and retried", async () => {
    let refuse = true;
    core.onCall = (conn, call) => {
      if (call.method === "events.subscribe" && refuse) errorReply(conn, call.id, "not now");
      else core.defaultCall(conn, call);
    };
    core.terminals = [term("t1")];
    const s = start();
    await until(() => s.lastError === "not now");
    refuse = false;
    await until(() => s.state === "connected" && s.store.get("t1") !== undefined);
    expect(s.lastError).toBeNull();
  });

  it("backs off between attempts while core is absent, up to its maximum", async () => {
    await core.stop();
    const s = start({ backoff: { initialMs: 40, maxMs: 80 } });
    const start0 = Date.now();
    await until(() => logs.length >= 5, 5000);
    // delays 40, 80, 80, 80: five failures take at least ~200 ms and are not a busy loop
    expect(Date.now() - start0).toBeGreaterThanOrEqual(180);
    expect(s.state).toBe("reconnecting");
  });
});

describe("defects", () => {
  it("an empty DATA frame on channel 0 should be ignored, not end the connection", async () => {
    core.terminals = [term("t1")];
    const s = start();
    await connected(s);
    core.last.write(encodeFrame(0, FrameKind.DATA, new Uint8Array()));
    await pause(150);
    expect(core.connections).toHaveLength(1);
    core.last.event(1, "title", "t1", { title: "still here" });
    await until(() => s.store.get("t1")?.title === "still here");
  });

  it("stop() should return promptly when core accepts the connection but never answers hello", async () => {
    core.silentHello = true;
    const s = start();
    await until(() => core.connections.length === 1);
    const t0 = Date.now();
    await s.stop();
    expect(Date.now() - t0).toBeLessThan(1000);
  }, 10_000);
});
