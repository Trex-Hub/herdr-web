// Tester's cases for DEV-29 D1: which process may hold the chat of a terminal, and what happens to the ones that may not.
import net from "node:net";
import type { Terminal } from "@herdr-web/core-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hello, state } from "../../../packages/agents/test/helpers.js";
import { openSocket, ORIGIN, startHarness, until, type Client, type Harness } from "./helpers.js";
import { FakeAgent } from "./fake-agent.js";

const term = (address: string, extra: Partial<Terminal> = {}): Terminal => ({
  address, argv: ["pi"], cols: 80, rows: 24, created_ms: 1, cwd: "/", state: "live", screen: "exact", labels: {}, title: "", turn: 0, ...extra,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let h: Harness;
const agents: FakeAgent[] = [];
const sockets: Client[] = [];

beforeEach(async () => {
  h = await startHarness({ connectCore: false, agents: { terminalWaitMs: 300, coreWaitMs: 500, accept: { helloTimeoutMs: 400, thread: { actionTimeoutMs: 300, entryWaitMs: 100 } } } });
  h.core.terminals = [term("t1"), term("t2")];
  h.session.start();
  await until(() => h.session.state === "connected" && h.session.store.get("t2") !== undefined);
});
afterEach(async () => {
  for (const c of sockets.splice(0)) c.close();
  for (const a of agents.splice(0)) a.close();
  await h.stop();
});

/** An agent that says hello with the given pid (or a raw hello object) for a terminal, then the models and state an extension sends. */
async function agentWith(terminal: string, pid: number | undefined | string, extra: Record<string, unknown> = {}): Promise<FakeAgent> {
  const a = await FakeAgent.connect(h.agentsSocket!);
  agents.push(a);
  const msg: Record<string, unknown> = { ...hello(null, { terminalId: terminal }), ...extra };
  if (pid === undefined) delete msg["pid"];
  else msg["pid"] = pid;
  a.send(msg);
  a.send({ type: "models", list: [] });
  a.send(state());
  return a;
}
const welcomed = (a: FakeAgent) => a.lines.some((l) => l["type"] === "welcome");
const refusedBy = (a: FakeAgent) => a.lines.find((l) => l["type"] === "refused");

describe("who may hold a terminal", () => {
  it("a holder whose socket is gone without a word frees the terminal at once: the next pi, another process, pairs within a second", async () => {
    const first = await agentWith("t1", 100);
    await until(() => h.chat.has("t1"));
    first.socket.destroy(); // no goodbye: a killed process
    const began = Date.now();
    await until(() => !h.chat.has("t1"), 2000);
    const second = await agentWith("t1", 200);
    await until(() => h.chat.has("t1"), 2000);
    expect(welcomed(second)).toBe(true);
    expect(Date.now() - began).toBeLessThan(1500);
  });

  it("a holder that is still there but silent (stopped process) keeps the terminal, and another pi is refused with a sentence that names it", async () => {
    const first = await agentWith("t1", 100);
    await until(() => h.chat.has("t1"));
    const second = await agentWith("t1", 200);
    await until(() => refusedBy(second) !== undefined);
    expect(String(refusedBy(second)!["reason"])).toContain("100");
    expect(h.chat.has("t1")).toBe(true);
    expect(first.closed).toBe(false);
  });

  it("the refused one is told in a way the extension treats as 'ask again much later' (a refused message, then the socket ends)", async () => {
    await agentWith("t1", 100);
    await until(() => h.chat.has("t1"));
    const second = await agentWith("t1", 200);
    await until(() => second.closed, 2000);
    expect(second.lines.map((l) => l["type"])).toContain("refused");
    expect(h.logs.filter((l) => l.includes("refused an agent in terminal")).length).toBe(1);
  });

  it("the same process saying hello again (/new, /reload) replaces its own connection and the subscribers get a reset", async () => {
    const c = await openSocket(h, { Origin: ORIGIN, Cookie: await h.cookie() });
    sockets.push(c);
    await until(() => c.messages.some((m) => m.type === "snapshot"));
    c.send(JSON.stringify({ type: "chat.subscribe", terminal: "t1" }));
    const first = await agentWith("t1", 100);
    await until(() => c.messages.some((m) => (m as { type: string }).type === "chat.snapshot" || (m as { type: string }).type === "chat.change"));
    const second = await agentWith("t1", 100);
    await until(() => first.closed, 2000);
    expect(welcomed(second)).toBe(true);
    expect(h.chat.has("t1")).toBe(true);
  });

  it("after a pi ended and left the terminal, another process pairs although the old one's close is still being processed (hello right after the close)", async () => {
    for (let round = 0; round < 20; round++) {
      const a = await agentWith("t1", 1000 + round);
      await until(() => h.chat.has("t1"), 2000);
      a.socket.destroy();
      const b = await agentWith("t1", 2000 + round); // sent at once: before the backend has seen the close
      await until(() => welcomed(b) || refusedBy(b) !== undefined, 2000);
      if (refusedBy(b)) {
        // the hello beat the close. It is refused: the extension would now wait for its long backoff
        throw new Error(`round ${round}: a new pi right after the old one's socket closed was refused: ${String(refusedBy(b)!["reason"])}`);
      }
      b.socket.destroy();
      await until(() => !h.chat.has("t1"), 2000);
    }
  }, 60_000);
});

describe("hellos with a pid that is not a pid", () => {
  const odd: Array<[string, number | undefined | string]> = [
    ["0", 0],
    ["-1", -1],
    ["2^53", 2 ** 53],
    ["1e300", 1e300],
    ["1.5", 1.5],
    ["missing", undefined],
    ["a string", "4242"],
    ["null", null as unknown as string],
  ];
  for (const [name, pid] of odd) {
    it(`pid ${name}: no crash; the holder keeps the terminal; an odd hello never takes it over`, async () => {
      const holder = await agentWith("t1", 100);
      await until(() => h.chat.has("t1"));
      const odder = await agentWith("t1", pid);
      await until(() => odder.closed, 2000);
      expect(holder.closed).toBe(false);
      expect(h.chat.has("t1")).toBe(true);
      expect((await fetch(`${h.base}/health`)).status).toBe(200);
    });
  }

  it("an odd pid on a free terminal is either refused as a bad hello or paired like any other; the bridge stays up either way", async () => {
    for (const [, pid] of odd) {
      const a = await agentWith("t2", pid);
      await until(() => a.closed || h.chat.has("t2"), 2000);
      a.close();
      await until(() => !h.chat.has("t2"), 2000);
    }
    expect((await fetch(`${h.base}/health`)).status).toBe(200);
  });

  it("a first hello with pid 0 holds the terminal against the real pi (same-user hostile; noted, not a defect of the rule)", async () => {
    const hostile = await agentWith("t1", 0);
    await until(() => h.chat.has("t1"));
    const real = await agentWith("t1", 777);
    await until(() => real.closed, 2000);
    expect(refusedBy(real)).toBeDefined();
    expect(hostile.closed).toBe(false);
  });
});

describe("two pis saying hello at the same instant", () => {
  it("one ends up holding the terminal, the other is closed; the chat is not left with neither", async () => {
    const [a, b] = await Promise.all([agentWith("t1", 100), agentWith("t1", 200)]);
    await until(() => h.chat.has("t1"), 2000);
    await sleep(500);
    expect(h.chat.has("t1")).toBe(true);
    expect([a, b].filter((x) => !x.closed).length).toBe(1);
  });

  it("a raw hello split into single bytes still carries its pid into the check", async () => {
    await agentWith("t1", 100);
    await until(() => h.chat.has("t1"));
    const socket = net.connect(h.agentsSocket!);
    await new Promise<void>((r) => socket.once("connect", r));
    let got = "";
    socket.on("data", (d) => (got += d.toString()));
    socket.on("error", () => {});
    for (const ch of JSON.stringify({ ...hello(null, { terminalId: "t1" }), pid: 300 }) + "\n") {
      socket.write(ch);
      await sleep(0);
    }
    await until(() => got.includes("refused"), 2000);
    socket.destroy();
  });
});

describe("the refused extension asks again rarely", () => {
  it("a real extension that is refused does not ask again for a long time (the log is not filled with refusals)", async () => {
    const { FakePi } = await import("../../../packages/pi-extension/test/harness.js");
    await agentWith("t1", 100);
    await until(() => h.chat.has("t1"));
    const saved = { id: process.env["HC_TERMINAL_ID"], sock: process.env["HERDR_WEB_AGENTS_SOCKET"] };
    process.env["HC_TERMINAL_ID"] = "t1";
    process.env["HERDR_WEB_AGENTS_SOCKET"] = h.agentsSocket!;
    const pi = new FakePi();
    try {
      pi.load();
      pi.emit("session_start", { reason: "startup" });
      await sleep(4000);
      const refusals = h.logs.filter((l) => l.includes("refused an agent in terminal")).length;
      // the first ask is refused; the next is a minute away. More than 2 in 4 s is a retry loop.
      expect(refusals).toBeLessThanOrEqual(2);
    } finally {
      pi.emit("session_shutdown");
      if (saved.id === undefined) delete process.env["HC_TERMINAL_ID"];
      else process.env["HC_TERMINAL_ID"] = saved.id;
      if (saved.sock === undefined) delete process.env["HERDR_WEB_AGENTS_SOCKET"];
      else process.env["HERDR_WEB_AGENTS_SOCKET"] = saved.sock;
    }
  }, 20_000);
});

describe("a refusal and what the extension has already sent", () => {
  // A real extension writes its hello and then its whole model list at once (the list is long: hundreds of models). The backend refuses at the
  // hello and closes; bytes of the model list that are still on their way must not make the refusal vanish, or the extension, which waits a
  // minute only after it has read a refusal, asks again after half a second, over and over.
  async function refusedWithBigModels(models: number): Promise<{ got: boolean; closed: boolean }> {
    await agentWith("t1", 100);
    await until(() => h.chat.has("t1"));
    const socket = net.connect(h.agentsSocket!);
    await new Promise<void>((r) => socket.once("connect", r));
    let got = "";
    let closed = false;
    socket.on("data", (d) => (got += d.toString()));
    socket.on("close", () => (closed = true));
    socket.on("error", () => {});
    const list = Array.from({ length: models }, (_, i) => ({ provider: "p", id: `model-${i}`, name: `Model number ${i} with a long human name`, reasoning: true, efforts: ["off", "low", "medium", "high", "xhigh"] }));
    const lines = [{ ...hello(null, { terminalId: "t1" }), pid: 200 }, { v: 1, type: "models", list }, state()];
    socket.write(lines.map((l) => JSON.stringify(l) + "\n").join(""));
    await until(() => closed, 3000);
    socket.destroy();
    return { got: got.includes('"refused"'), closed };
  }

  it("a refusal reaches an extension that has sent a long model list behind its hello (20 tries, 300 models each, about 70 kB)", async () => {
    let lost = 0;
    for (let i = 0; i < 20; i++) if (!(await refusedWithBigModels(300)).got) lost++;
    expect(lost).toBe(0);
  }, 60_000);
});
