// Tester's cases for DEV-29 D1, for pi-live (DEV-35): which process may hold the chat of a terminal, and what happens to the ones that may not.
import fs from "node:fs";
import path from "node:path";
import type { Terminal } from "@herdr-web/core-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chatPicture } from "../../../packages/agents/test/fake-pi-live.js";
import { openSocket, ORIGIN, startHarness, until, type Client, type Harness } from "./helpers.js";
import { LivePi, type LivePiOptions } from "./fake-pi.js";

const term = (address: string, extra: Partial<Terminal> = {}): Terminal => ({
  address, argv: ["pi"], cols: 80, rows: 24, created_ms: 1, cwd: "/", state: "live", screen: "exact", labels: {}, title: "", turn: 0, ...extra,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let h: Harness;
const pis: LivePi[] = [];
const sockets: Client[] = [];

beforeEach(async () => {
  h = await startHarness({ connectCore: false, live: { terminalWaitMs: 300, coreWaitMs: 500, followMs: 600, connection: { welcomeTimeoutMs: 400, thread: { actionTimeoutMs: 300, entryWaitMs: 100 } } } });
  h.core.terminals = [term("t1"), term("t2")];
  h.session.start();
  await until(() => h.session.state === "connected" && h.session.store.get("t2") !== undefined);
});
afterEach(async () => {
  for (const c of sockets.splice(0)) c.close();
  await h.stop();
  for (const p of pis.splice(0)) await p.stop();
});

/** A pi with the given pid in a terminal. */
async function piWith(terminal: string, pid: number, extra: Partial<LivePiOptions> = {}): Promise<LivePi> {
  const p = await LivePi.start(h.liveDir!, { terminal, pid, config: { chat: chatPicture() }, ...extra });
  pis.push(p);
  return p;
}
const die = (p: LivePi) => {
  p.unpublish();
  p.crash();
};
const refusals = () => h.logs.filter((l) => l.includes("refused a pi in terminal"));

describe("who may hold a terminal", () => {
  it("a holder whose socket is gone without a word frees the terminal at once: the next pi, another process, pairs within a second", async () => {
    const first = await piWith("t1", 100);
    await until(() => h.chat.has("t1"));
    die(first); // no goodbye: a killed process
    const began = Date.now();
    await until(() => !h.chat.has("t1"), 2000);
    const second = await piWith("t1", 200);
    await until(() => h.chat.has("t1") && second.connections === 1, 2000);
    expect(Date.now() - began).toBeLessThan(1500);
  });

  it("a holder that is still there but silent (stopped process) keeps the terminal, and another pi is not connected, with one line that names the holder", async () => {
    const first = await piWith("t1", 100);
    await until(() => h.chat.has("t1"));
    const second = await piWith("t1", 200);
    await until(() => refusals().length === 1, 3000);
    expect(refusals()[0]).toContain("process 100 holds it");
    await sleep(400);
    expect(refusals()).toHaveLength(1);
    expect(second.hellos).toBe(0);
    expect(h.chat.has("t1")).toBe(true);
    expect(first.connections).toBe(1);
  });

  it("a pi that dropped (no goodbye) but is still there is reconnected to, and another process does not slip in between", async () => {
    const first = await piWith("t1", 100);
    await until(() => h.chat.has("t1"));
    first.crash(); // the line drops; the process and its file stay
    const second = await piWith("t1", 200);
    await until(() => first.hellos === 2, 3000);
    expect(h.chat.has("t1")).toBe(true);
    expect(second.hellos).toBe(0);
  });

  it("the same process writing a new file again (/reload: the same path, a new startedAt) replaces its own connection and the subscribers get a reset", async () => {
    const c = await openSocket(h, { Origin: ORIGIN, Cookie: await h.cookie() });
    sockets.push(c);
    await until(() => c.messages.some((m) => m.type === "snapshot"));
    c.send(JSON.stringify({ type: "chat.subscribe", terminal: "t1" }));
    const first = await piWith("t1", 100);
    await until(() => c.messages.some((m) => m.type === "chat.change"));
    const told = c.messages.filter((m) => m.type === "chat.unavailable").length; // the one before the pi was there
    first.goodbye("reload");
    await until(() => first.connections === 0);
    await sleep(300); // the old file is still there and is read again: it is not the new session
    expect(first.hellos).toBe(1);
    first.publish(); // pi-live's new session: same path, new startedAt
    await until(() => first.hellos === 2, 3000);
    await until(() => c.messages.filter((m) => m.type === "chat.change").length === 2, 3000);
    expect(c.messages.filter((m) => m.type === "chat.unavailable")).toHaveLength(told);
    expect(h.chat.has("t1")).toBe(true);
    expect(refusals()).toEqual([]);
  });

  it("after a pi ended and left the terminal, another process pairs although the old one's close is still being processed (a file right after the close)", async () => {
    for (let round = 0; round < 20; round++) {
      const a = await piWith("t1", 1000 + round);
      await until(() => h.chat.has("t1") && a.connections === 1, 2000);
      die(a);
      const b = await piWith("t1", 2000 + round); // written at once: before the backend has seen the close
      await until(() => b.connections === 1, 3000);
      die(b);
      await until(() => !h.chat.has("t1"), 2000);
    }
  }, 60_000);
});

describe("session files with a pid that is not a pid", () => {
  const odd: Array<[string, unknown]> = [
    ["0", 0],
    ["-1", -1],
    ["2^53", 2 ** 53],
    ["1e300", 1e300],
    ["1.5", 1.5],
    ["missing", undefined],
    ["a string", "4242"],
    ["null", null],
  ];
  function oddFile(name: string, pid: unknown, terminal = "t1"): void {
    const body: Record<string, unknown> = { protocol: 1, sessionId: name, cwd: "/", startedAt: "2026-01-01T00:00:00.000Z", socketPath: "/tmp/hw-nowhere.sock", mode: "tui", terminal };
    if (pid !== undefined) body["pid"] = pid;
    fs.writeFileSync(path.join(h.liveDir!, `${name}.json`), JSON.stringify(body));
  }
  for (const [name, pid] of odd) {
    it(`pid ${name}: no crash; the holder keeps the terminal; an odd file never takes it over`, async () => {
      const holder = await piWith("t1", 100);
      await until(() => h.chat.has("t1"));
      oddFile(`odd-${name.replace(/\W/g, "_")}`, pid);
      await sleep(400);
      expect(holder.connections).toBe(1);
      expect(h.chat.has("t1")).toBe(true);
      expect((await fetch(`${h.base}/health`)).status).toBe(200);
    });
  }

  it("on a free terminal an odd file makes no chat, and the bridge stays up", async () => {
    odd.forEach(([name, pid]) => oddFile(`free-${name.replace(/\W/g, "_")}`, pid, "t2"));
    await sleep(500);
    expect(h.chat.has("t2")).toBe(false);
    expect((await fetch(`${h.base}/health`)).status).toBe(200);
  });

  it("a file with pid 0 cannot hold the terminal against the real pi: it is not a file at all", async () => {
    oddFile("hostile", 0);
    const real = await piWith("t1", 777);
    await until(() => h.chat.has("t1") && real.connections === 1, 3000);
  });
});

describe("a session file that is still being written", () => {
  it("is read when it is whole: half a file is not a session, and nothing is said about it", async () => {
    const p = await piWith("t1", 100, { publish: false });
    const whole = JSON.stringify({ protocol: 1, sessionId: p.sessionId, cwd: "/", pid: 100, startedAt: "2026-01-01T00:00:00.000Z", socketPath: p.fake.path, mode: "tui", terminal: "t1" });
    fs.writeFileSync(p.jsonPath, whole.slice(0, 40));
    await sleep(400);
    expect(h.chat.has("t1")).toBe(false);
    expect(p.hellos).toBe(0);
    fs.writeFileSync(p.jsonPath, whole);
    await until(() => h.chat.has("t1"), 3000);
    expect(h.logs).toEqual([]);
  });
});

describe("two pis writing files for one terminal at the same instant", () => {
  it("one ends up holding the terminal, the other is not connected; the chat is not left with neither", async () => {
    const [a, b] = await Promise.all([piWith("t1", 100), piWith("t1", 200)]);
    await until(() => h.chat.has("t1"), 2000);
    await sleep(500);
    expect(h.chat.has("t1")).toBe(true);
    expect([a, b].filter((p) => p.connections === 1)).toHaveLength(1);
  });
});
