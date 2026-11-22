import fs from "node:fs";
import path from "node:path";
import { PI_BUILTIN_COMMANDS } from "@herdr-web/agents";
import type { Terminal } from "@herdr-web/core-client";
import type { ServerMessage } from "@herdr-web/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assistantEntry, sessionHeader, tmpDir, toolResultEntry, userEntry } from "../../../packages/agents/test/helpers.js";
import { ChatHub } from "../src/chat.js";
import { chatPicture } from "../../../packages/agents/test/fake-pi-live.js";
import { LivePi, type LivePiOptions } from "./fake-pi.js";
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
const pis: LivePi[] = [];
const sockets: Client[] = [];

/** What pi-live's welcome carries as the first picture: a model that reasons and one that does not. */
const picture = () =>
  chatPicture({
    state: { ...chatPicture().state, model: { provider: "p", id: "m", name: "M", reasoning: true }, effort: "off", efforts: ["off", "low", "high"] },
    models: [
      { provider: "p", id: "m", name: "M", reasoning: true, efforts: ["off", "low", "high"] },
      { provider: "p", id: "n", name: "N", reasoning: false, efforts: ["off"] },
    ],
  });

/** A pi in a terminal: its pi-live socket and its session file in the folder the hub watches. */
async function pi(terminal: string | null = "t1", file: string | null = sessionFile(), extra: Partial<LivePiOptions> = {}): Promise<LivePi> {
  const p = await LivePi.start(h.liveDir!, { terminal, file, config: { chat: picture() }, ...extra });
  pis.push(p);
  return p;
}
/** A pi that is gone: killed, its file removed by nobody but gone with it. */
const die = (p: LivePi) => {
  p.unpublish();
  p.crash();
};
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
  h = await startHarness({ connectCore: false, live: { terminalWaitMs: 300, coreWaitMs: 500, followMs: 600, connection: { thread: { actionTimeoutMs: 300, entryWaitMs: 100 } } } });
  h.core.machines = [machine];
  h.core.terminals = [term("t1"), term("t2"), term("t4", { state: "finished", reason: "exited", exit_code: 0 }), term("cachyos/t9")];
  h.core.rpc.set("terminal.send", () => ({ turn: 1, started: true, status: "idle" }));
  h.session.start();
  await until(() => h.session.state === "connected" && h.session.store.get("cachyos/t9") !== undefined);
  cookie = await h.cookie();
});
afterEach(async () => {
  for (const c of sockets.splice(0)) c.close();
  await h.stop();
  for (const p of pis.splice(0)) await p.stop();
});

describe("which terminals have a chat", () => {
  it("a terminal says so once a pi for it has connected, live, and says so no more when it goes", async () => {
    const c = await socket();
    expect(flag(c, "t1")).toBe(false);
    const p = await pi("t1");
    await until(() => flag(c, "t1") === true);
    expect(flag(c, "t2")).toBe(false);
    die(p);
    await until(() => flag(c, "t1") === false);
    // a browser that connects now hears the same in its snapshot
    const later = await socket();
    expect(of(later, "snapshot")[0]!.terminals.find((t) => t.address === "t1")!.chat).toBe(false);
  });

  it("a browser that connects while a pi is there has it in its snapshot", async () => {
    await pi("t1");
    await until(() => h.chat.has("t1"));
    const c = await socket();
    expect(of(c, "snapshot")[0]!.terminals.map((t) => [t.address, t.chat])).toEqual([["t1", true], ["t2", false], ["t4", false], ["cachyos/t9", false]]);
  });

  it("a pi whose file names a terminal that is not live here is never connected to, with one log line: unknown, finished, another machine's, or not an id at all", async () => {
    const ps: LivePi[] = [];
    for (const id of ["t99", "t4", "cachyos/t9", "../../etc", "t1; rm"]) ps.push(await pi(id));
    await until(() => h.logs.filter((l) => /not a live terminal of this computer|not a terminal of this computer/.test(l)).length === 5, 4000);
    await sleep(400); // rescans of the same files say nothing more
    expect(h.logs.filter((l) => /not a live terminal of this computer/.test(l))).toHaveLength(2);
    expect(h.logs.filter((l) => /which is not a terminal of this computer/.test(l))).toHaveLength(3);
    expect(ps.map((p) => p.hellos)).toEqual([0, 0, 0, 0, 0]);
    expect(h.chat.has("t99")).toBe(false);
  });

  it("only a pi in a terminal user interface is linked: another mode, or no terminal, is left alone without a word", async () => {
    const rpc = await pi("t1", null, { mode: "rpc" });
    const bare = await pi(null);
    await sleep(500);
    expect([rpc.hellos, bare.hellos]).toEqual([0, 0]);
    expect(h.chat.has("t1")).toBe(false);
    expect(h.logs).toEqual([]);
  });

  it("a file that appears before core's list has the terminal waits for it", async () => {
    h.core.terminals = [];
    h.core.dropConnections();
    await until(() => h.session.store.get("t1") === undefined);
    const p = await pi("t7");
    await sleep(60);
    h.core.terminals = [term("t7")];
    h.core.dropConnections();
    await until(() => h.chat.has("t7"), 3000);
    expect(p.connections).toBe(1);
  });

  it("the terminal ending ends the chat: subscribers are told, the flag goes, the pi's connection is closed and not made again", async () => {
    const p = await pi("t1");
    await until(() => h.chat.has("t1"));
    const c = await socket();
    c.send(JSON.stringify({ type: "chat.subscribe", terminal: "t1" }));
    await until(() => chatOf(c).length === 1);
    h.core.event("finished", "t1", { reason: "exited", exit_code: 0, signal: null, finished_ms: 5 });
    await until(() => p.connections === 0);
    await until(() => chatOf(c).some((m) => m.type === "chat.unavailable"));
    expect(chatOf(c).at(-1)).toMatchObject({ type: "chat.unavailable", reason: "This terminal has ended." });
    expect(flag(c, "t1")).toBe(false);
    await sleep(400);
    expect(p.hellos).toBe(1);
  });
});

describe("two pis for one terminal", () => {
  it("a new session of the same pi (/new): the old one's goodbye keeps the chat, the new file takes over with a reset, and nobody is told `unavailable`", async () => {
    const first = await pi("t1");
    await until(() => h.chat.has("t1"));
    const c = await socket();
    c.send(JSON.stringify({ type: "chat.subscribe", terminal: "t1" }));
    await until(() => chatOf(c).length === 1);
    const before = of(c, "terminal").length;
    first.goodbye("new");
    first.unpublish();
    await until(() => first.connections === 0);
    expect(h.chat.has("t1")).toBe(true); // kept while the next session is awaited
    const second = await pi("t1");
    await until(() => chatOf(c).length === 2);
    expect(chatOf(c)[1]).toMatchObject({ type: "chat.change", change: { type: "reset" } });
    expect(second.connections).toBe(1);
    expect(h.chat.has("t1")).toBe(true);
    await sleep(800); // longer than the wait: nothing more is said
    expect(chatOf(c)).toHaveLength(2);
    expect(of(c, "terminal").slice(before).filter((m) => m.terminal.address === "t1" && !m.terminal.chat)).toEqual([]);
  });

  it("a new file of the same pid while the old connection is still up replaces it", async () => {
    const first = await pi("t1");
    await until(() => h.chat.has("t1"));
    const c = await socket();
    c.send(JSON.stringify({ type: "chat.subscribe", terminal: "t1" }));
    await until(() => chatOf(c).length === 1);
    const second = await pi("t1");
    await until(() => first.connections === 0);
    await until(() => chatOf(c).length === 2);
    expect(chatOf(c)[1]).toMatchObject({ type: "chat.change", change: { type: "reset" } });
    expect(second.connections).toBe(1);
  });

  it("a pi of another process is not connected while the holder lives, and one line says so; once the holder is gone it pairs", async () => {
    const holder = await pi("t1"); // pid 4242
    await until(() => h.chat.has("t1"));
    const c = await socket();
    c.send(JSON.stringify({ type: "chat.subscribe", terminal: "t1" }));
    await until(() => chatOf(c).length === 1);
    const seen = chatOf(c).length;
    const other = await pi("t1", sessionFile(), { pid: 5151 });
    await until(() => h.logs.some((l) => /refused a pi in terminal "t1" \(process 5151\): process 4242 holds it/.test(l)), 3000);
    await sleep(400);
    expect(other.hellos).toBe(0);
    // the holder was not disturbed and the subscriber heard nothing
    expect(holder.connections).toBe(1);
    expect(chatOf(c)).toHaveLength(seen);
    expect(h.logs.filter((l) => /refused a pi in terminal "t1"/.test(l))).toHaveLength(1);
    // the holder leaves; the other is found by the next look at the folder and pairs
    holder.goodbye("quit");
    holder.unpublish();
    await until(() => chatOf(c).some((m) => m.type === "chat.unavailable"));
    await until(() => h.chat.has("t1"), 3000);
    await until(() => chatOf(c).at(-1)?.type === "chat.change", 3000);
    expect(chatOf(c).at(-1)).toMatchObject({ type: "chat.change", change: { type: "reset" } });
    expect(other.connections).toBe(1);
  });

  it("two pis of two processes for one terminal at the same instant: one holds it, the other is not connected, and the chat is not left with neither", async () => {
    const [a, b] = await Promise.all([pi("t1", sessionFile(), { pid: 100 }), pi("t1", sessionFile(), { pid: 200 })]);
    await until(() => h.chat.has("t1"), 2000);
    await sleep(500);
    expect(h.chat.has("t1")).toBe(true);
    expect([a, b].filter((p) => p.connections === 1)).toHaveLength(1);
    expect(h.logs.filter((l) => /refused a pi in terminal "t1"/.test(l))).toHaveLength(1);
  });

  it("two backends can watch one folder: a second hub with its own subscribers sees the same pi", async () => {
    const other = new ChatHub({ session: h.session, liveDir: h.liveDir, alive: () => true, rescanMs: 100, terminalWaitMs: 300 });
    await other.start();
    try {
      await pi("t1");
      await until(() => h.chat.has("t1") && other.has("t1"), 3000);
    } finally {
      await other.stop();
    }
  });
});

describe("a chat subscription", () => {
  it("starts with the thread's snapshot, then follows its changes in order", async () => {
    const a = await pi("t1");
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

  it("a subscription made before the pi exists is told there is no chat, and gets a reset when the pi comes", async () => {
    const c = await socket();
    c.send(JSON.stringify({ type: "chat.subscribe", terminal: "t1" }));
    await until(() => chatOf(c).length === 1);
    expect(chatOf(c)[0]).toMatchObject({ type: "chat.unavailable", terminal: "t1", reason: expect.stringContaining("found no pi-live session") });
    await pi("t1");
    await until(() => chatOf(c).length === 2);
    expect(chatOf(c)[1]).toMatchObject({ type: "chat.change", change: { type: "reset" } });
  });

  it("/new and the like: a new session of the pi is a reset to the new thread; the pi quitting is `unavailable`; another coming is a reset", async () => {
    const one = await pi("t1");
    await until(() => h.chat.has("t1"));
    const c = await socket();
    c.send(JSON.stringify({ type: "chat.subscribe", terminal: "t1" }));
    await until(() => chatOf(c).length === 1);
    const fresh = path.join(tmpDir(), "new.jsonl");
    fs.writeFileSync(fresh, JSON.stringify(sessionHeader) + "\n");
    one.goodbye("new");
    one.unpublish();
    const two = await pi("t1", fresh);
    await until(() => chatOf(c).length === 2);
    const reset = chatOf(c)[1] as Extract<ServerMessage, { type: "chat.change" }>;
    expect(reset.change).toMatchObject({ type: "reset", snapshot: { rows: [] } });
    two.goodbye("quit");
    two.unpublish();
    await until(() => chatOf(c).length === 3);
    expect(chatOf(c)[2]).toMatchObject({ type: "chat.unavailable", reason: expect.stringContaining("disconnected") });
    await pi("t1");
    await until(() => chatOf(c).length === 4);
    expect(chatOf(c)[3]).toMatchObject({ type: "chat.change", change: { type: "reset" } });
  });

  it("several tabs hold the same thread; one leaving does not disturb the other, and a closed tab leaves no subscription", async () => {
    await pi("t1");
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
    const a = await pi("t1");
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
    await pi("t1");
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
    await pi("t1");
    await until(() => h.chat.has("t1"));
  });
  const last = () => pis[0]!;

  it("need the cookie and an allowed Origin, and touch nobody without them", async () => {
    const bodies = { send: { terminal: "t1", text: "hi" }, stop: { terminal: "t1" }, model: { terminal: "t1", model: "p/n" }, effort: { terminal: "t1", effort: "low" }, older: { terminal: "t1", before: "u1" }, result: { terminal: "t1", row: "a1.1" } };
    for (const [name, body] of Object.entries(bodies)) {
      expect((await post(name, body, { Origin: ORIGIN })).status, name).toBe(401);
      expect((await post(name, body, { Origin: "http://evil.example", Cookie: cookie })).status, name).toBe(403);
    }
    expect(last().actions).toEqual([]);
    expect(coreSends()).toEqual([]);
  });

  it("send goes through pi-live", async () => {
    const r = await post("send", { terminal: "t1", text: "hello there" });
    expect(r).toEqual({ status: 200, body: { via: "agent" } });
    expect(last().actions).toMatchObject([{ type: "action", op: "send", text: "hello there" }]);
    expect(coreSends()).toEqual([]);
  });

  it("one of pi's own screens (/model, /tree...) is typed into the terminal after the input box is cleared, in that order", async () => {
    const order: string[] = [];
    h.core.rpc.set("terminal.send", () => (order.push("core:terminal.send"), { turn: 1 }));
    const seen = last().fake;
    const before = seen.received.length;
    const r = await post("send", { terminal: "t1", text: "/model" });
    order.unshift(...seen.received.slice(before).map((m) => `pi:${String(m.op)}`));
    expect(r).toEqual({ status: 200, body: { via: "terminal" } });
    expect(order).toEqual(["pi:clear_input", "core:terminal.send"]);
    expect(coreSends()[0]!.params).toEqual({ terminal: "t1", text: "/model" });
  });

  it("every built-in of pi-live's list except /compact and /name goes the same way", async () => {
    for (const name of PI_BUILTIN_COMMANDS.filter((n) => n !== "compact" && n !== "name")) {
      expect((await post("send", { terminal: "t1", text: `/${name}` })).body, name).toEqual({ via: "terminal" });
    }
    expect(coreSends().map((c) => (c.params as { text: string }).text)).toEqual(PI_BUILTIN_COMMANDS.filter((n) => n !== "compact" && n !== "name").map((n) => `/${n}`));
    expect(last().actions.every((a) => a["op"] === "clear_input")).toBe(true);
  });

  it("/compact is pi-live's compact action, with the rest as instructions when there is some; nothing is typed", async () => {
    expect((await post("send", { terminal: "t1", text: "/compact" })).body).toEqual({ via: "agent" });
    expect((await post("send", { terminal: "t1", text: "/compact  keep the plan  " })).body).toEqual({ via: "agent" });
    expect(last().actions).toMatchObject([{ op: "compact" }, { op: "compact", instructions: "keep the plan" }]);
    expect(last().actions[0]).not.toHaveProperty("instructions");
    expect(coreSends()).toEqual([]);
  });

  it("/name with a name is pi-live's set_name; /name alone is pi's own, typed into the terminal", async () => {
    expect((await post("send", { terminal: "t1", text: "/name the refactor" })).body).toEqual({ via: "agent" });
    expect(last().actions).toMatchObject([{ op: "set_name", name: "the refactor" }]);
    expect((await post("send", { terminal: "t1", text: "/name" })).body).toEqual({ via: "terminal" });
    expect(coreSends()[0]!.params).toEqual({ terminal: "t1", text: "/name" });
  });

  it("any other slash text is sent as it is: a skill, a prompt template, an extension's command, a path", async () => {
    for (const text of ["/skill:review the diff", "/review", "/tmp/x.log is full", "/Compact", "/compactx", "/"]) {
      expect((await post("send", { terminal: "t1", text })).body, text).toEqual({ via: "agent" });
    }
    expect(last().actions.map((a) => [a["op"], a["text"]])).toEqual(["/skill:review the diff", "/review", "/tmp/x.log is full", "/Compact", "/compactx", "/"].map((t) => ["send", t]));
    expect(coreSends()).toEqual([]);
  });

  it("only the first character decides: after a space a slash is not a command of ours, nothing is typed, and pi-live's own refusal of a built-in is the sentence", async () => {
    const r = await post("send", { terminal: "t1", text: " /model" });
    expect(r.status).toBe(409);
    expect(r.body["error"]).toMatch(/pi-live can't run \/model/);
    expect((await post("send", { terminal: "t1", text: " /review" })).body).toEqual({ via: "agent" });
    expect(coreSends()).toEqual([]);
  });

  it("if the input box cannot be cleared nothing is typed", async () => {
    last().fake.config.refusals = { clear_input: "pi has no input box right now." };
    const r = await post("send", { terminal: "t1", text: "/tree" });
    expect(r).toEqual({ status: 409, body: { error: "pi has no input box right now." } });
    expect(coreSends()).toEqual([]);
  });

  it("core refusing the typing (a blocked program) is a 502 with core's words; no connection to core is a 503 with a sentence", async () => {
    h.core.rpc.set("terminal.send", () => ({ error: { message: "blocked", kind: "blocked" } }));
    const r = await post("send", { terminal: "t1", text: "/model" });
    expect(r.status).toBe(502);
    expect(r.body["error"]).toMatch(/blocked/);
    await h.core.stop();
    await until(() => h.session.state !== "connected");
    const down = await post("send", { terminal: "t1", text: "/model" });
    expect(down.status).toBe(503);
    expect(down.body["error"]).toMatch(/not connected to core/);
  });

  it("stop, model and effort go to pi and answer ok", async () => {
    expect(await post("stop", { terminal: "t1" })).toEqual({ status: 200, body: { ok: true } });
    expect(await post("model", { terminal: "t1", model: "p/n" })).toEqual({ status: 200, body: { ok: true } });
    expect(await post("effort", { terminal: "t1", effort: "low" })).toEqual({ status: 200, body: { ok: true } });
    expect(last().actions.map((a) => a["op"])).toEqual(["stop", "set_model", "set_effort"]);
    expect(last().actions[1]).toMatchObject({ model: "p/n" });
  });

  it("a model or effort pi does not offer is refused with its sentence, without asking pi", async () => {
    expect(await post("model", { terminal: "t1", model: "q/none" })).toEqual({ status: 409, body: { error: "pi does not offer the model “q/none”." } });
    const r = await post("effort", { terminal: "t1", effort: "max" });
    expect(r.status).toBe(409);
    expect(r.body["error"]).toBe("This model does not take the effort “max”. It takes: off, low, high.");
    expect(last().actions).toEqual([]);
  });

  it("a sentence pi refuses with is passed on, and an action pi never answers times out with one", async () => {
    last().fake.config.refusals = { stop: "No API key is set up for p." };
    expect(await post("stop", { terminal: "t1" })).toEqual({ status: 409, body: { error: "No API key is set up for p." } });
    last().fake.config.autoReply = false;
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

  it("refuses what is not a chat: bad input 400, no such terminal 404, an ended one 409, one without a pi 409 with the reason, another machine's 400", async () => {
    expect((await post("send", { terminal: "t1" })).status).toBe(400);
    expect((await post("send", { terminal: "t1", text: "" })).status).toBe(400);
    expect((await post("send", { terminal: "t1", text: "x".repeat(100_001) })).status).toBe(400);
    expect((await post("send", { terminal: "t1", text: "x", extra: 1 })).status).toBe(400);
    expect((await post("send", { terminal: "cachyos/t9", text: "x" })).status).toBe(400);
    expect((await post("send", { terminal: "t404", text: "x" })).status).toBe(404);
    expect((await post("send", { terminal: "t4", text: "x" })).status).toBe(409);
    const none = await post("send", { terminal: "t2", text: "x" });
    expect(none.status).toBe(409);
    expect(none.body["error"]).toMatch(/found no pi-live session/);
    expect((await post("format-disk", {})).status).toBe(404);
    expect(last().actions).toEqual([]);
    expect(coreSends()).toEqual([]);
  });

  it("the pi going away between the subscription and the call is a sentence, not a crash", async () => {
    die(last());
    await until(() => !h.chat.has("t1"));
    const r = await post("send", { terminal: "t1", text: "hi" });
    expect(r.status).toBe(409);
    expect(r.body["error"]).toMatch(/found no pi-live session/);
  });
});
