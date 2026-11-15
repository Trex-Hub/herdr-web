import fs from "node:fs";
import path from "node:path";
import type { Terminal } from "@herdr-web/core-client";
import type { ServerMessage } from "@herdr-web/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assistantEntry, sessionHeader, tmpDir, toolResultEntry, userEntry } from "../../../packages/agents/test/helpers.js";
import { ChatHub } from "../src/chat.js";
import { FakeAgent } from "./fake-agent.js";
import { openSocket, ORIGIN, startHarness, until, type Client, type Harness } from "./helpers.js";

const term = (address: string, extra: Partial<Terminal> = {}): Terminal => ({
  address, argv: ["pi"], cols: 80, rows: 24, created_ms: 1, cwd: "/", state: "live", screen: "exact", labels: {}, title: "", turn: 0, ...extra,
});
const machine = { name: "cachyos", target: "x", id: "i", host: "h", version: "1", state: "connected" };

/** A session file: one question, an answer with a tool call whose result is longer than a row keeps. */
function sessionFile(): string {
  const file = path.join(tmpDir(), "session.jsonl");
  const long = "x".repeat(6000);
  const lines = [
    sessionHeader,
    userEntry(null, "first question", "u1"),
    assistantEntry("u1", [{ type: "text", text: "first answer" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "yes" } }], "a1", { stopReason: "toolUse" }),
    toolResultEntry("a1", "c1", long, false, "r1"),
    assistantEntry("r1", [{ type: "text", text: "done" }], "a2"),
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l) + "\n").join(""));
  return file;
}

let h: Harness;
let cookie: string;
const agents: FakeAgent[] = [];
const sockets: Client[] = [];

async function agent(terminal: string | null = "t1", file: string | null = sessionFile()): Promise<FakeAgent> {
  const a = await FakeAgent.connect(h.agentsSocket!);
  agents.push(a);
  if (terminal) a.open(terminal, file);
  return a;
}
async function socket(): Promise<Client> {
  const c = await openSocket(h, { Origin: ORIGIN, Cookie: cookie });
  sockets.push(c);
  await until(() => c.messages.some((m) => m.type === "snapshot"));
  return c;
}
const of = <T extends ServerMessage["type"]>(c: Client, type: T) => c.messages.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
const chatOf = (c: Client, terminal = "t1") => c.messages.filter((m) => m.type.startsWith("chat.") && (m as { terminal: string }).terminal === terminal);
const flag = (c: Client, address: string) => {
  const last = [...of(c, "terminal")].reverse().find((m) => m.terminal.address === address);
  return last?.terminal.chat ?? of(c, "snapshot")[0]!.terminals.find((t) => t.address === address)?.chat;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(name: string, body: unknown, headers: Record<string, string> = { Origin: ORIGIN, Cookie: cookie }) {
  const res = await fetch(`${h.base}/api/chat/${name}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const coreSends = () => h.core.calls.filter((c) => c.method === "terminal.send");

beforeEach(async () => {
  h = await startHarness({ connectCore: false, agents: { terminalWaitMs: 300, coreWaitMs: 500, accept: { thread: { actionTimeoutMs: 300, entryWaitMs: 100 } } } });
  h.core.machines = [machine];
  h.core.terminals = [term("t1"), term("t2"), term("t4", { state: "finished", reason: "exited", exit_code: 0 }), term("cachyos/t9")];
  h.core.rpc.set("terminal.send", () => ({ turn: 1, started: true, status: "idle" }));
  h.session.start();
  await until(() => h.session.state === "connected" && h.session.store.get("cachyos/t9") !== undefined);
  cookie = await h.cookie();
});
afterEach(async () => {
  for (const c of sockets.splice(0)) c.close();
  for (const a of agents.splice(0)) a.close();
  await h.stop();
});

describe("which terminals have a chat", () => {
  it("a terminal says so once an agent for it has connected, live, and says so no more when it goes", async () => {
    const c = await socket();
    expect(flag(c, "t1")).toBe(false);
    const a = await agent("t1");
    await until(() => flag(c, "t1") === true);
    expect(flag(c, "t2")).toBe(false);
    a.close();
    await until(() => flag(c, "t1") === false);
    // a browser that connects now hears the same in its snapshot
    const later = await socket();
    expect(of(later, "snapshot")[0]!.terminals.find((t) => t.address === "t1")!.chat).toBe(false);
  });

  it("a browser that connects while an agent is there has it in its snapshot", async () => {
    await agent("t1");
    await until(() => h.chat.has("t1"));
    const c = await socket();
    expect(of(c, "snapshot")[0]!.terminals.map((t) => [t.address, t.chat])).toEqual([["t1", true], ["t2", false], ["t4", false], ["cachyos/t9", false]]);
  });

  it("an agent that names a terminal that is not live here is closed, with one log line: unknown, finished, another machine's, or not an id at all", async () => {
    for (const id of ["t99", "t4", "cachyos/t9", "../../etc", "t1; rm"]) {
      const a = await agent(id);
      await until(() => a.closed, 3000);
    }
    expect(h.logs.filter((l) => /not a live terminal of this computer/.test(l))).toHaveLength(5);
    expect(h.chat.has("t99")).toBe(false);
  });

  it("a hello that comes before core's list has the terminal waits for it", async () => {
    h.core.terminals = [];
    h.core.dropConnections();
    await until(() => h.session.store.get("t1") === undefined);
    const a = await agent("t7");
    await sleep(60);
    h.core.terminals = [term("t7")];
    h.core.dropConnections();
    await until(() => h.chat.has("t7"), 3000);
    expect(a.closed).toBe(false);
  });

  it("the terminal ending ends the chat: subscribers are told, the flag goes, the agent's connection is closed", async () => {
    const a = await agent("t1");
    await until(() => h.chat.has("t1"));
    const c = await socket();
    c.send(JSON.stringify({ type: "chat.subscribe", terminal: "t1" }));
    await until(() => chatOf(c).length === 1);
    h.core.event("finished", "t1", { reason: "exited", exit_code: 0, signal: null, finished_ms: 5 });
    await until(() => a.closed);
    await until(() => chatOf(c).some((m) => m.type === "chat.unavailable"));
    expect(chatOf(c).at(-1)).toMatchObject({ type: "chat.unavailable", reason: "This terminal has ended." });
    expect(flag(c, "t1")).toBe(false);
  });
});

describe("two connections for one terminal", () => {
  it("a newer one replaces the older, which is closed; chat stays available throughout and a subscriber gets a reset", async () => {
    const first = await agent("t1");
    await until(() => h.chat.has("t1"));
    const c = await socket();
    c.send(JSON.stringify({ type: "chat.subscribe", terminal: "t1" }));
    await until(() => chatOf(c).length === 1);
    const before = of(c, "terminal").length;
    const second = await agent("t1");
    await until(() => first.closed);
    await until(() => chatOf(c).length === 2);
    expect(chatOf(c)[1]).toMatchObject({ type: "chat.change", change: { type: "reset" } });
    expect(second.closed).toBe(false);
    expect(h.chat.has("t1")).toBe(true);
    expect(of(c, "terminal").slice(before).filter((m) => m.terminal.address === "t1" && !m.terminal.chat)).toEqual([]);
  });

  it("a hello from another process is refused while the holder lives, with a sentence, and nothing flips; once the holder is gone it pairs", async () => {
    const holder = await agent("t1"); // pid 4242
    await until(() => h.chat.has("t1"));
    const c = await socket();
    c.send(JSON.stringify({ type: "chat.subscribe", terminal: "t1" }));
    await until(() => chatOf(c).length === 1);
    const seen = chatOf(c).length;
    const inner = await FakeAgent.connect(h.agentsSocket!);
    inner.open("t1", sessionFile(), {}, { pid: 5151 });
    await until(() => inner.lines.some((l) => l["type"] === "refused"), 3000);
    expect(inner.lines.find((l) => l["type"] === "refused")).toMatchObject({ reason: expect.stringContaining("held by another pi (process 4242)") });
    await until(() => inner.closed, 3000);
    await sleep(100);
    // the holder was not disturbed and the subscriber heard nothing
    expect(holder.closed).toBe(false);
    expect(chatOf(c)).toHaveLength(seen);
    expect(h.logs.filter((l) => /refused an agent in terminal "t1" from process 5151/.test(l))).toHaveLength(1);
    // the holder leaves; the other one asks again (its retry) and pairs
    holder.close();
    await until(() => chatOf(c).some((m) => m.type === "chat.unavailable"));
    const retry = await FakeAgent.connect(h.agentsSocket!);
    retry.open("t1", sessionFile(), {}, { pid: 5151 });
    await until(() => h.chat.has("t1"), 3000);
    await until(() => chatOf(c).at(-1)?.type === "chat.change", 3000);
    expect(chatOf(c).at(-1)).toMatchObject({ type: "chat.change", change: { type: "reset" } });
    expect(retry.closed).toBe(false);
  });

  it("a hello from the same process replaces the old connection (/new, /resume, /fork, /reload load the extension again in the same pi)", async () => {
    const first = await agent("t1"); // pid 4242
    await until(() => h.chat.has("t1"));
    const again = await FakeAgent.connect(h.agentsSocket!);
    again.open("t1", sessionFile(), {}, { pid: 4242, reason: "reload" });
    await until(() => first.closed, 3000);
    expect(again.lines.some((l) => l["type"] === "refused")).toBe(false);
    expect(again.closed).toBe(false);
    expect(h.chat.has("t1")).toBe(true);
  });

  it("when two race, the one accepted later wins even if it said hello first", async () => {
    const early = await agent(null);
    const late = await agent(null);
    late.open("t1", sessionFile());
    await until(() => h.chat.has("t1"));
    early.open("t1", sessionFile());
    await until(() => early.closed, 3000);
    expect(late.closed).toBe(false);
    expect(h.chat.has("t1")).toBe(true);
  });

  it("another backend already holding the socket: one clear line, and this backend carries on without chat", async () => {
    const other = new ChatHub({ session: h.session, socketPath: path.join(tmpDir().replace(/^\/var\/folders\/.*/, "/tmp"), "o.sock") });
    await other.start();
    const second = new ChatHub({ session: h.session, socketPath: h.agentsSocket, log: (l) => h.logs.push(l) });
    await second.start();
    expect(h.logs.filter((l) => /another backend is already listening/.test(l))).toHaveLength(1);
    expect(h.logs.join("\n")).toMatch(/runs without chat/);
    await second.stop();
    await other.stop();
    // the first hub, which holds the socket, still works
    await agent("t1");
    await until(() => h.chat.has("t1"));
  });
});

describe("a chat subscription", () => {
  it("starts with the thread's snapshot, then follows its changes in order", async () => {
    const a = await agent("t1");
    await until(() => h.chat.has("t1"));
    const c = await socket();
    c.send(JSON.stringify({ type: "chat.subscribe", terminal: "t1" }));
    await until(() => chatOf(c).length === 1);
    const first = chatOf(c)[0] as Extract<ServerMessage, { type: "chat.snapshot" }>;
    expect(first.type).toBe("chat.snapshot");
    expect(first.snapshot.rows.map((r) => r.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(first.snapshot.identity).toMatchObject({ agent: "pi", terminalId: "t1" });
    expect(first.snapshot.capabilities.models?.list.map((m) => m.id)).toEqual(["p/m", "p/n"]);
    a.send({ type: "reply", blocks: [{ kind: "text", text: "partial" }] });
    a.send({ ...{ type: "state", leafId: null, model: null, effort: null, efforts: [], working: true, pending: [], usage: null, name: null } });
    await until(() => chatOf(c).length >= 2);
    const seqs = chatOf(c).slice(1).map((m) => (m as { change: { seq: number } }).change.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(seqs[0]).toBe(first.snapshot.seq + 1);
    expect(JSON.stringify(chatOf(c).slice(1))).toContain("partial");
  });

  it("a subscription made before the agent exists is told there is no chat, and gets a reset when the agent comes", async () => {
    const c = await socket();
    c.send(JSON.stringify({ type: "chat.subscribe", terminal: "t1" }));
    await until(() => chatOf(c).length === 1);
    expect(chatOf(c)[0]).toMatchObject({ type: "chat.unavailable", terminal: "t1", reason: expect.stringContaining("has not connected") });
    await agent("t1");
    await until(() => chatOf(c).length === 2);
    expect(chatOf(c)[1]).toMatchObject({ type: "chat.change", change: { type: "reset" } });
  });

  it("/new and the like: the same terminal's new connection is a reset to the new thread; the agent going away is `unavailable`; coming back is a reset", async () => {
    const one = await agent("t1");
    await until(() => h.chat.has("t1"));
    const c = await socket();
    c.send(JSON.stringify({ type: "chat.subscribe", terminal: "t1" }));
    await until(() => chatOf(c).length === 1);
    const fresh = path.join(tmpDir(), "new.jsonl");
    fs.writeFileSync(fresh, JSON.stringify(sessionHeader) + "\n");
    const two = await agent("t1", fresh);
    await until(() => one.closed);
    await until(() => chatOf(c).length === 2);
    const reset = chatOf(c)[1] as Extract<ServerMessage, { type: "chat.change" }>;
    expect(reset.change).toMatchObject({ type: "reset", snapshot: { rows: [] } });
    two.close();
    await until(() => chatOf(c).length === 3);
    expect(chatOf(c)[2]).toMatchObject({ type: "chat.unavailable", reason: expect.stringContaining("disconnected") });
    await agent("t1");
    await until(() => chatOf(c).length === 4);
    expect(chatOf(c)[3]).toMatchObject({ type: "chat.change", change: { type: "reset" } });
  });

  it("several tabs hold the same thread; one leaving does not disturb the other, and a closed tab leaves no subscription", async () => {
    await agent("t1");
    await until(() => h.chat.has("t1"));
    const one = await socket();
    const two = await socket();
    for (const c of [one, two]) c.send(JSON.stringify({ type: "chat.subscribe", terminal: "t1" }));
    await until(() => chatOf(one).length === 1 && chatOf(two).length === 1);
    expect(h.chat.subscriberCount("t1")).toBe(2);
    one.send(JSON.stringify({ type: "chat.unsubscribe", terminal: "t1" }));
    await until(() => h.chat.subscriberCount("t1") === 1);
    two.close();
    await until(() => h.chat.subscriberCount("t1") === 0);
  });

  it("after unsubscribe nothing more arrives for that terminal", async () => {
    const a = await agent("t1");
    await until(() => h.chat.has("t1"));
    const c = await socket();
    c.send(JSON.stringify({ type: "chat.subscribe", terminal: "t1" }));
    await until(() => chatOf(c).length === 1);
    c.send(JSON.stringify({ type: "chat.unsubscribe", terminal: "t1" }));
    await until(() => h.chat.subscriberCount("t1") === 0);
    a.send({ type: "reply", blocks: [{ kind: "text", text: "late" }] });
    await sleep(100);
    expect(chatOf(c)).toHaveLength(1);
  });

  it("subscribing twice starts over with a fresh snapshot and still holds one subscription", async () => {
    await agent("t1");
    await until(() => h.chat.has("t1"));
    const c = await socket();
    for (let i = 0; i < 2; i++) c.send(JSON.stringify({ type: "chat.subscribe", terminal: "t1" }));
    await until(() => chatOf(c).length === 2);
    expect(chatOf(c).map((m) => m.type)).toEqual(["chat.snapshot", "chat.snapshot"]);
    expect(h.chat.subscriberCount("t1")).toBe(1);
  });

  it("a terminal that is not running, and a terminal that never existed, are unavailable and hold no subscription", async () => {
    const c = await socket();
    c.send(JSON.stringify({ type: "chat.subscribe", terminal: "t4" }));
    c.send(JSON.stringify({ type: "chat.subscribe", terminal: "t404" }));
    await until(() => c.messages.filter((m) => m.type === "chat.unavailable").length === 2);
    expect(h.chat.subscriberCount("t4") + h.chat.subscriberCount("t404")).toBe(0);
  });

  it("an address on another machine is not a valid subscription: the socket closes", async () => {
    const c = await socket();
    c.send(JSON.stringify({ type: "chat.subscribe", terminal: "cachyos/t9" }));
    await until(() => c.closed !== undefined);
    expect(c.closed!.code).toBe(1008);
  });

  it("at most sixteen at once; a seventeenth is told so", async () => {
    h.core.terminals = Array.from({ length: 18 }, (_, i) => term(`t${i + 1}`));
    h.core.dropConnections();
    await until(() => h.session.store.get("t18") !== undefined);
    const c = await socket();
    for (let i = 1; i <= 17; i++) c.send(JSON.stringify({ type: "chat.subscribe", terminal: `t${i}` }));
    await until(() => c.messages.filter((m) => m.type === "chat.unavailable").length >= 17, 4000);
    expect(c.messages.filter((m) => m.type === "chat.unavailable" && m.reason.includes("Too many"))).toHaveLength(1);
  });
});

describe("chat operations", () => {
  beforeEach(async () => {
    await agent("t1");
    await until(() => h.chat.has("t1"));
  });
  const last = () => agents[0]!;

  it("need the cookie and an allowed Origin, and touch nobody without them", async () => {
    const bodies = { send: { terminal: "t1", text: "hi" }, stop: { terminal: "t1" }, model: { terminal: "t1", model: "p/n" }, effort: { terminal: "t1", effort: "low" }, older: { terminal: "t1", before: "u1" }, result: { terminal: "t1", row: "a1.1" } };
    for (const [name, body] of Object.entries(bodies)) {
      expect((await post(name, body, { Origin: ORIGIN })).status, name).toBe(401);
      expect((await post(name, body, { Origin: "http://evil.example", Cookie: cookie })).status, name).toBe(403);
    }
    expect(last().actions).toEqual([]);
    expect(coreSends()).toEqual([]);
  });

  it("send goes through the agent", async () => {
    const r = await post("send", { terminal: "t1", text: "hello there" });
    expect(r).toEqual({ status: 200, body: { via: "agent" } });
    expect(last().actions).toMatchObject([{ op: "send", text: "hello there" }]);
    expect(coreSends()).toEqual([]);
  });

  it("a message that begins with a slash is typed into the terminal after the input box is cleared, in that order", async () => {
    const order: string[] = [];
    last().answer = (a) => (order.push(`agent:${String(a["op"])}`), { ok: true });
    h.core.rpc.set("terminal.send", () => (order.push("core:terminal.send"), { turn: 1 }));
    const r = await post("send", { terminal: "t1", text: "/compact" });
    expect(r).toEqual({ status: 200, body: { via: "terminal" } });
    expect(order).toEqual(["agent:clear_input", "core:terminal.send"]);
    expect(coreSends()[0]!.params).toEqual({ terminal: "t1", text: "/compact" });
  });

  it("only the first character decides: a space before the slash is a message", async () => {
    expect((await post("send", { terminal: "t1", text: " /compact" })).body).toEqual({ via: "agent" });
    expect(coreSends()).toEqual([]);
  });

  it("if the input box cannot be cleared nothing is typed", async () => {
    last().answer = () => ({ ok: false, error: "pi has no input box right now." });
    const r = await post("send", { terminal: "t1", text: "/tree" });
    expect(r).toEqual({ status: 409, body: { error: "pi has no input box right now." } });
    expect(coreSends()).toEqual([]);
  });

  it("core refusing the typing (a blocked program) is a 502 with core's words; no connection to core is a 503 with a sentence", async () => {
    h.core.rpc.set("terminal.send", () => ({ error: { message: "blocked", kind: "blocked" } }));
    const r = await post("send", { terminal: "t1", text: "/compact" });
    expect(r.status).toBe(502);
    expect(r.body["error"]).toMatch(/blocked/);
    await h.core.stop();
    await until(() => h.session.state !== "connected");
    const down = await post("send", { terminal: "t1", text: "/compact" });
    expect(down.status).toBe(503);
    expect(down.body["error"]).toMatch(/not connected to core/);
  });

  it("stop, model and effort go to the agent and answer ok", async () => {
    expect(await post("stop", { terminal: "t1" })).toEqual({ status: 200, body: { ok: true } });
    expect(await post("model", { terminal: "t1", model: "p/n" })).toEqual({ status: 200, body: { ok: true } });
    expect(await post("effort", { terminal: "t1", effort: "low" })).toEqual({ status: 200, body: { ok: true } });
    expect(last().actions.map((a) => a["op"])).toEqual(["stop", "set_model", "set_effort"]);
    expect(last().actions[1]).toMatchObject({ model: "p/n" });
  });

  it("a model or effort the agent does not offer is refused with its sentence, without asking the agent", async () => {
    expect(await post("model", { terminal: "t1", model: "q/none" })).toEqual({ status: 409, body: { error: "pi does not offer the model “q/none”." } });
    const r = await post("effort", { terminal: "t1", effort: "max" });
    expect(r.status).toBe(409);
    expect(r.body["error"]).toBe("This model does not take the effort “max”. It takes: off, low, high.");
    expect(last().actions).toEqual([]);
  });

  it("an error the agent answers with is passed on as the sentence, and one that never answers times out with one", async () => {
    last().answer = () => ({ ok: false, error: "No API key is set up for p." });
    expect(await post("stop", { terminal: "t1" })).toEqual({ status: 409, body: { error: "No API key is set up for p." } });
    last().answer = () => null;
    const r = await post("stop", { terminal: "t1" });
    expect(r.status).toBe(409);
    expect(r.body["error"]).toMatch(/did not answer in time/);
  });

  it("older asks the thread for the page before a row; a row that is not there is a sentence", async () => {
    const r = await post("older", { terminal: "t1", before: "a1.1" });
    expect(r.status).toBe(200);
    expect(r.body["rows"].map((x: { id: string }) => x.id)).toEqual(["u1", "a1.0"]);
    expect(r.body["hasMore"]).toBe(false);
    const gone = await post("older", { terminal: "t1", before: "nope" });
    expect(gone.status).toBe(409);
    expect(gone.body["error"]).toMatch(/no longer there/);
  });

  it("result gives a tool row's whole result, which its row cut", async () => {
    const snapshot = h.chat.thread("t1")!.snapshot();
    const tool = snapshot.rows.find((r) => r.kind === "tool")!;
    expect(tool.kind === "tool" && tool.result?.truncated).toBe(true);
    const r = await post("result", { terminal: "t1", row: tool.id });
    expect(r.status).toBe(200);
    expect(r.body["text"]).toHaveLength(6000);
    expect((await post("result", { terminal: "t1", row: "u1" })).status).toBe(409);
  });

  it("refuses what is not a chat: bad input 400, no such terminal 404, an ended one 409, one without an agent 409 with the reason, another machine's 400", async () => {
    expect((await post("send", { terminal: "t1" })).status).toBe(400);
    expect((await post("send", { terminal: "t1", text: "" })).status).toBe(400);
    expect((await post("send", { terminal: "t1", text: "x".repeat(100_001) })).status).toBe(400);
    expect((await post("send", { terminal: "t1", text: "x", extra: 1 })).status).toBe(400);
    expect((await post("send", { terminal: "cachyos/t9", text: "x" })).status).toBe(400);
    expect((await post("send", { terminal: "t404", text: "x" })).status).toBe(404);
    expect((await post("send", { terminal: "t4", text: "x" })).status).toBe(409);
    const none = await post("send", { terminal: "t2", text: "x" });
    expect(none.status).toBe(409);
    expect(none.body["error"]).toMatch(/has not connected/);
    expect((await post("format-disk", {})).status).toBe(404);
    expect(last().actions).toEqual([]);
    expect(coreSends()).toEqual([]);
  });

  it("the agent going away between the subscription and the call is a sentence, not a crash", async () => {
    last().close();
    await until(() => !h.chat.has("t1"));
    const r = await post("send", { terminal: "t1", text: "hi" });
    expect(r.status).toBe(409);
    expect(r.body["error"]).toMatch(/has not connected/);
  });
});
