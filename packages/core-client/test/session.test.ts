import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoreConnection } from "../src/connection.js";
import { ConnectionClosedError, CoreError } from "../src/errors.js";
import { FrameKind } from "../src/frame.js";
import { CoreSession } from "../src/session.js";
import type { Terminal } from "../src/types.js";
import { FakeCore } from "./fake-core.js";

function term(address: string, extra: Partial<Terminal> = {}): Terminal {
  return { address, argv: ["sh"], cols: 80, rows: 24, created_ms: 1, cwd: "/", state: "live", screen: "exact", labels: {}, ...extra };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

let core: FakeCore;
let session: CoreSession | undefined;

beforeEach(async () => {
  core = new FakeCore();
  await core.listen();
});
afterEach(async () => {
  await session?.stop();
  session = undefined;
  await core.dispose();
});

function start(extra: ConstructorParameters<typeof CoreSession>[0] = {}): CoreSession {
  session = new CoreSession({ endpoint: () => core.path, backoff: { initialMs: 20, maxMs: 100 }, machinePollMs: 10_000, ...extra });
  session.start();
  return session;
}

describe("CoreConnection", () => {
  it("says hello framed, matches concurrent calls by id, and surfaces kind and hint", async () => {
    const conn = await CoreConnection.connect({ path: core.path });
    expect(conn.hello.version).toBe("9.9.9");
    const [slow, fast] = await Promise.all([conn.call("slow", {}), conn.call("fast", {})]);
    expect([slow, fast]).toEqual(["slow", "fast"]);
    const err = await conn.call("boom", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoreError);
    expect(err).toMatchObject({ code: -32000, message: "no terminal t9", kind: "not_found", hint: "try ls" });
    conn.close();
  });

  it("rejects pending calls when the connection drops", async () => {
    const conn = await CoreConnection.connect({ path: core.path });
    const pending = conn.call("slow", {});
    core.dropConnections();
    await expect(pending).rejects.toBeInstanceOf(ConnectionClosedError);
    await expect(conn.call("fast", {})).rejects.toBeInstanceOf(ConnectionClosedError);
  });

  it("fails to connect to a missing socket", async () => {
    await expect(CoreConnection.connect({ path: core.path + ".nope" })).rejects.toBeInstanceOf(ConnectionClosedError);
  });

  it("credits the bytes it consumed on the event channel", async () => {
    const s = start();
    core.terminals = [term("t1")];
    await until(() => s.state === "connected");
    core.event("title", "t1", { title: "a" });
    await until(() => s.store.get("t1")?.title === "a");
    await until(() => core.clientFrames.some(([ch, kind]) => ch === 1 && kind === FrameKind.CREDIT));
  });
});

describe("CoreSession", () => {
  it("takes the snapshot, then applies events", async () => {
    core.terminals = [term("t1"), term("cachyos/t2")];
    core.seq = 5;
    core.machines = [{ name: "cachyos", target: "c", id: "i", host: "h", version: "1", state: "connected" }];
    const s = start();
    await until(() => s.state === "connected" && s.store.machines.length === 1);
    expect(s.store.list().map((t) => t.address)).toEqual(["t1", "cachyos/t2"]);
    expect(s.store.seq).toBe(5);
    expect(s.core).toMatchObject({ version: "9.9.9", info: { name: "fake" } });

    core.event("created", "t3", term("t3"));
    core.event("labels", "t3", { labels: { a: "b" } });
    core.event("finished", "t1", { reason: "killed", exit_code: null, signal: 1, finished_ms: 9 });
    await until(() => s.store.seq === 8);
    expect(s.store.get("t3")?.labels).toEqual({ a: "b" });
    expect(s.store.get("t1")?.state).toBe("finished");
  });

  it("applies an event that arrives in the same read as the subscribe reply", async () => {
    core.terminals = [term("t1")];
    core.glueNextEventToReply = "t1";
    const s = start();
    await until(() => s.store.get("t1")?.title === "glued");
    expect(s.store.seq).toBe(1);
  });

  it("copes with frames dribbled one byte at a time", async () => {
    core.terminals = [term("t1")];
    core.byteAtATime = true;
    const s = start();
    await until(() => s.state === "connected");
    core.event("title", "t1", { title: "slow bytes" });
    await until(() => s.store.get("t1")?.title === "slow bytes");
  });

  it("replaces its contents on `missed` and drops stale events after it", async () => {
    core.terminals = [term("t1")];
    const s = start();
    await until(() => s.state === "connected");
    core.raw("missed", { seq: 57, terminals: [term("t5")] });
    await until(() => s.store.seq === 57);
    expect(s.store.list().map((t) => t.address)).toEqual(["t5"]);
    core.raw("heartbeat", { seq: 57 });
    core.seq = 50;
    core.event("title", "t5", { title: "stale" }); // seq 51
    core.seq = 57;
    core.event("title", "t5", { title: "fresh" }); // seq 58
    await until(() => s.store.seq === 58);
    expect(s.store.get("t5")?.title).toBe("fresh");
  });

  it("reconnects after the connection drops and takes a fresh snapshot", async () => {
    core.terminals = [term("t1")];
    core.seq = 100;
    const s = start();
    await until(() => s.state === "connected");
    core.terminals = [term("t1"), term("t2")];
    core.seq = 3; // seq restarts with a new core process
    core.dropConnections();
    await until(() => s.store.get("t2") !== undefined && s.state === "connected");
    expect(s.store.seq).toBe(3);
    core.event("title", "t2", { title: "after" });
    await until(() => s.store.get("t2")?.title === "after");
  });

  it("keeps retrying while core is down, then recovers when it comes back", async () => {
    core.terminals = [term("t1")];
    const s = start();
    await until(() => s.state === "connected");
    await core.stop();
    await until(() => s.state === "reconnecting" && s.lastError !== null);
    await new Promise((r) => setTimeout(r, 150)); // several failed attempts
    expect(s.state).toBe("reconnecting");
    core.terminals = [term("t9")];
    core.seq = 1;
    await core.listen();
    await until(() => s.state === "connected" && s.store.get("t9") !== undefined);
    expect(s.store.get("t1")).toBeUndefined();
    expect(s.lastError).toBeNull();
  });

  it("reconnects when the event stream is closed by core", async () => {
    core.terminals = [term("t1")];
    const s = start();
    await until(() => s.state === "connected");
    core.terminals = [term("t1"), term("t2")];
    core.closeEventChannels();
    await until(() => s.store.get("t2") !== undefined);
  });

  it("reconnects when core goes silent past the idle timeout", async () => {
    core.terminals = [term("t1")];
    const s = start({ idleTimeoutMs: 300 });
    await until(() => s.state === "connected");
    core.terminals = [term("t1"), term("t3")];
    core.muted = true; // stop answering and pushing; keep the socket open
    await until(() => s.state === "reconnecting");
    core.muted = false;
    await until(() => s.store.get("t3") !== undefined, 3000);
  });

  it("stop() ends the loop", async () => {
    const s = start();
    await until(() => s.state === "connected");
    await s.stop();
    expect(s.state).toBe("stopped");
  });
});
