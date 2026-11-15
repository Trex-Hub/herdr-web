import { afterEach, describe, expect, it } from "vitest";
import { CoreSession } from "../src/session.js";
import { FrameKind } from "../src/frame.js";
import type { StreamEnd } from "../src/connection.js";
import { FakeCore } from "./fake-core.js";

const cores: FakeCore[] = [];
const sessions: CoreSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop();
  for (const c of cores.splice(0)) await c.dispose();
});

async function setup() {
  const core = new FakeCore();
  cores.push(core);
  await core.listen();
  const session = new CoreSession({ endpoint: () => core.path });
  sessions.push(session);
  return { core, session };
}

async function until(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function collect() {
  const chunks: Buffer[] = [];
  const ends: StreamEnd[] = [];
  return { chunks, ends, handlers: { onData: (b: Buffer) => chunks.push(b), onEnd: (e: StreamEnd) => ends.push(e) } };
}

describe("terminal.attach", () => {
  it("hands over a first paint that arrives in the same read as the reply", async () => {
    const { core, session } = await setup();
    const conn = await session.openConnection();
    const got = collect();
    const att = await conn.attach({ terminal: "t7", cols: 80, rows: 24, history: 500, display: { fg: "#ffffff", bg: "#000000", cursor: null, cell: [9, 18] } }, got.handlers);
    expect(att.result.automatic_input).toBe(true);
    await until(() => got.chunks.length > 0);
    expect(Buffer.concat(got.chunks).toString()).toBe("\x18first-paint");
    expect(core.attaches[0]).toMatchObject({ terminal: "t7", cols: 80, rows: 24, history: 500, display: { cell: [9, 18] } });
    conn.close();
  });

  it("advertises nothing it was not given: no automatic_input feature means the hello says so", async () => {
    const { core, session } = await setup();
    core.features = ["framed"];
    const conn = await session.openConnection();
    expect(conn.hello.features).not.toContain("automatic_input");
    conn.close();
  });

  it("sends input as DATA, automatic replies as kind 6, and falls back to DATA without support", async () => {
    const { core, session } = await setup();
    const conn = await session.openConnection();
    const att = await conn.attach({ terminal: "t7", cols: 80, rows: 24 }, collect().handlers);
    att.sendInput(Buffer.from("ls\r"));
    att.sendAutomatic(Buffer.from("\x1b[?1;2c"));
    await until(() => core.streamFrames.length >= 2);
    expect(core.streamFrames.map(([c, k, p]) => [c, k, p.toString()])).toEqual([
      [att.result.channel, FrameKind.DATA, "ls\r"],
      [att.result.channel, FrameKind.AUTOMATIC_INPUT, "\x1b[?1;2c"],
    ]);
    conn.close();

    core.attachAutomatic = false;
    core.streamFrames.length = 0;
    const conn2 = await session.openConnection();
    const att2 = await conn2.attach({ terminal: "t7", cols: 80, rows: 24 }, collect().handlers);
    att2.sendAutomatic(Buffer.from("x"));
    await until(() => core.streamFrames.length >= 1);
    expect(core.streamFrames[0]![1]).toBe(FrameKind.DATA);
    conn2.close();
  });

  it("encodes resize, focus, facts and credit", async () => {
    const { core, session } = await setup();
    const conn = await session.openConnection();
    const att = await conn.attach({ terminal: "t7", cols: 80, rows: 24 }, collect().handlers);
    att.resize(132, 43);
    att.focus(true);
    att.focus(false);
    att.facts({ fg: "#111111", bg: "#eeeeee", cursor: null, cell: [10, 20] });
    att.credit(4096);
    att.credit(0); // nothing to say
    await until(() => core.streamFrames.length >= 5);
    const [resize, f1, f0, facts, credit] = core.streamFrames;
    expect(resize![1]).toBe(FrameKind.RESIZE);
    expect([resize![2].readUInt16LE(0), resize![2].readUInt16LE(2)]).toEqual([132, 43]);
    expect([f1![1], [...f1![2]]]).toEqual([FrameKind.FOCUS, [1]]);
    expect([f0![1], [...f0![2]]]).toEqual([FrameKind.FOCUS, [0]]);
    expect(facts![1]).toBe(FrameKind.FACTS);
    expect(JSON.parse(facts![2].toString())).toEqual({ fg: "#111111", bg: "#eeeeee", cursor: null, cell: [10, 20] });
    expect([credit![1], credit![2].readUInt32LE(0)]).toEqual([FrameKind.CREDIT, 4096]);
    expect(core.streamFrames).toHaveLength(5);
    conn.close();
  });

  it("does not credit by itself: output is owed until the viewer says it consumed it", async () => {
    const { core, session } = await setup();
    const conn = await session.openConnection();
    const got = collect();
    const att = await conn.attach({ terminal: "t7", cols: 80, rows: 24 }, got.handlers);
    core.streamOut(att.result.channel, Buffer.alloc(100_000, 0x61));
    await until(() => got.chunks.reduce((n, c) => n + c.length, 0) >= 100_000);
    await new Promise((r) => setTimeout(r, 30));
    expect(core.streamFrames.filter(([, k]) => k === FrameKind.CREDIT)).toHaveLength(0);
    conn.close();
  });

  it("reports how the stream ended, and then ignores the channel", async () => {
    const { core, session } = await setup();
    const conn = await session.openConnection();
    const got = collect();
    const att = await conn.attach({ terminal: "t7", cols: 80, rows: 24 }, got.handlers);
    core.streamEnd(att.result.channel, "exited", 3, null);
    await until(() => got.ends.length === 1);
    expect(got.ends[0]).toEqual({ reason: "exited", exit_code: 3, signal: null, connectionLost: false });
    att.sendInput(Buffer.from("late")); // detached by the end: nothing goes out
    att.detach();
    await new Promise((r) => setTimeout(r, 30));
    expect(core.streamFrames.filter(([, k]) => k === FrameKind.DATA)).toHaveLength(0);
    conn.close();
  });

  it("detach sends CLOSE and delivers nothing more", async () => {
    const { core, session } = await setup();
    const conn = await session.openConnection();
    const got = collect();
    const att = await conn.attach({ terminal: "t7", cols: 80, rows: 24 }, got.handlers);
    await until(() => got.chunks.length > 0);
    att.detach();
    await until(() => core.streamFrames.some(([, k]) => k === FrameKind.CLOSE));
    expect(core.attachedChannels).toEqual([]);
    expect(got.ends).toEqual([]);
    conn.close();
    expect(got.ends).toEqual([]);
  });

  it("ends every stream, marked as a lost connection, when the line drops", async () => {
    const { core, session } = await setup();
    const conn = await session.openConnection();
    const got = collect();
    await conn.attach({ terminal: "t7", cols: 80, rows: 24 }, got.handlers);
    core.dropConnections();
    await until(() => got.ends.length === 1);
    expect(got.ends[0]).toMatchObject({ reason: "connection_lost", connectionLost: true });
  });

  it("rejects with core's error kind", async () => {
    const { core, session } = await setup();
    core.attachErrors.set("t9", { kind: "not_found", message: "no terminal t9" });
    const conn = await session.openConnection();
    await expect(conn.attach({ terminal: "t9", cols: 80, rows: 24 }, collect().handlers)).rejects.toMatchObject({ kind: "not_found" });
    conn.close();
  });

  it("rejects openConnection when core is not there", async () => {
    const { core, session } = await setup();
    await core.stop();
    await expect(session.openConnection()).rejects.toThrow();
  });
});
