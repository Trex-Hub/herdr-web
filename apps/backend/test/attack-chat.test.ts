import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { Terminal } from "@herdr-web/core-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assistantEntry, sessionHeader, tmpDir, toolResultEntry, userEntry } from "../../../packages/agents/test/helpers.js";
import { FakeAgent } from "./fake-agent.js";
import { openSocket, ORIGIN, startHarness, until, type Client, type Harness } from "./helpers.js";

// The chat routes, the agents socket and the chat part of the main socket attacked from outside: what a browser
// that is not the page, and a process that is not pi, can make the backend do.

const term = (address: string, extra: Partial<Terminal> = {}): Terminal => ({
  address, argv: ["pi"], cols: 80, rows: 24, created_ms: 1, cwd: "/", state: "live", screen: "exact", labels: {}, title: "", turn: 0, ...extra,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sessionFile(toolChars = 6000): string {
  const file = path.join(tmpDir(), "session.jsonl");
  const lines = [
    sessionHeader,
    userEntry(null, "first question", "u1"),
    assistantEntry("u1", [{ type: "text", text: "first answer" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "yes" } }], "a1", { stopReason: "toolUse" }),
    toolResultEntry("a1", "c1", "x".repeat(toolChars), false, "r1"),
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
const coreSends = () => h.core.calls.filter((c) => c.method === "terminal.send");
const raw = async (p: string, init: RequestInit) => {
  const res = await fetch(`${h.base}${p}`, init);
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body, text, headers: res.headers };
};
const headers = (extra: Record<string, string> = {}) => ({ Origin: ORIGIN, Cookie: cookie, "Content-Type": "application/json", ...extra });
const post = (name: string, body: unknown, extra: Record<string, string> = {}) =>
  raw(`/api/chat/${name}`, { method: "POST", headers: headers(extra), body: typeof body === "string" ? body : JSON.stringify(body) });

beforeEach(async () => {
  h = await startHarness({ connectCore: false, agents: { terminalWaitMs: 300, coreWaitMs: 500, accept: { helloTimeoutMs: 400, thread: { actionTimeoutMs: 300, entryWaitMs: 100 } } } });
  h.core.machines = [{ name: "cachyos", target: "x", id: "i", host: "h", version: "1", state: "connected" }];
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

describe("chat operations: input that must be refused before the agent is asked anything", () => {
  const bad: Array<[string, string, unknown]> = [
    ["send", "an empty text", { terminal: "t1", text: "" }],
    ["send", "a text of 100,001 characters", { terminal: "t1", text: "x".repeat(100_001) }],
    ["send", "a text that is not a string", { terminal: "t1", text: ["hi"] }],
    ["send", "a terminal on another machine", { terminal: "cachyos/t9", text: "hi" }],
    ["send", "a terminal in other case", { terminal: "T1", text: "hi" }],
    ["send", "a terminal with a newline", { terminal: "t1\n", text: "hi" }],
    ["send", "an extra key (a way to pass a mode)", { terminal: "t1", text: "hi", mode: "steer" }],
    ["send", "a terminal that is a number", { terminal: 1, text: "hi" }],
    ["stop", "an extra key", { terminal: "t1", force: true }],
    ["stop", "no terminal", {}],
    ["model", "an empty model", { terminal: "t1", model: "" }],
    ["model", "a model of 301 characters", { terminal: "t1", model: "m".repeat(301) }],
    ["model", "a model that is a number", { terminal: "t1", model: 5 }],
    ["effort", "an empty effort", { terminal: "t1", effort: "" }],
    ["effort", "an effort of 33 characters", { terminal: "t1", effort: "e".repeat(33) }],
    ["older", "a limit of 0", { terminal: "t1", before: "u1", limit: 0 }],
    ["older", "a limit of 201", { terminal: "t1", before: "u1", limit: 201 }],
    ["older", "a limit of 1.5", { terminal: "t1", before: "u1", limit: 1.5 }],
    ["older", "a limit of -1", { terminal: "t1", before: "u1", limit: -1 }],
    ["older", "an empty before", { terminal: "t1", before: "" }],
    ["older", "a before of 301 characters", { terminal: "t1", before: "b".repeat(301) }],
    ["result", "an empty row", { terminal: "t1", row: "" }],
    ["result", "a row of 301 characters", { terminal: "t1", row: "r".repeat(301) }],
    ["result", "a row that is an object", { terminal: "t1", row: { id: "r1" } }],
  ];
  beforeEach(async () => {
    await agent("t1");
    await until(() => h.chat.has("t1"));
  });
  for (const [name, what, body] of bad) {
    it(`${name}: ${what}`, async () => {
      const r = await post(name, body);
      expect(r.status, r.text).toBe(400);
      expect(typeof r.body?.error).toBe("string");
      expect(agents[0]!.actions).toEqual([]);
      expect(coreSends()).toEqual([]);
    });
  }

  it("a body that is not JSON, or is not sent as JSON, is not read", async () => {
    for (const text of ["", "null", "[]", "{", "7", `"x"`]) expect((await post("send", text)).status, JSON.stringify(text)).toBe(400);
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      const r = await raw("/api/chat/send", { method: "POST", headers: { Origin: ORIGIN, Cookie: cookie, "Content-Type": type }, body: JSON.stringify({ terminal: "t1", text: "hi" }) });
      expect(r.status, type).toBe(400);
    }
    expect(agents[0]!.actions).toEqual([]);
  });

  it("a body over 1 MB is refused", async () => {
    const r = await post("send", { terminal: "t1", text: "x".repeat(1_100_000) });
    expect(r.status).toBe(413);
    expect(agents[0]!.actions).toEqual([]);
  });

  it("only POST does anything on a chat route; an unknown name or a name from Object.prototype is a 404", async () => {
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      expect((await raw("/api/chat/send", { method, headers: headers(), ...(method === "GET" ? {} : { body: JSON.stringify({ terminal: "t1", text: "hi" }) }) })).status, method).toBe(404);
    }
    for (const name of ["format", "__proto__", "constructor", "toString", "SEND", "send%2Fstop"]) {
      expect((await post(name, { terminal: "t1", text: "hi" })).status, name).toBe(404);
    }
    expect(agents[0]!.actions).toEqual([]);
    expect(coreSends()).toEqual([]);
  });

  it("every origin that is not listed and every cookie that is not ours is refused, and nothing reaches the agent or the terminal", async () => {
    const body = { terminal: "t1", text: "/new" };
    for (const origin of ["null", "http://localhost:3000.evil.com", "http://localhost:3000/", "HTTP://LOCALHOST:3000", "http://127.0.0.1:3000", "*"]) {
      expect((await post("send", body, { Origin: origin })).status, origin).toBe(403);
    }
    for (const c of ["", "herdr_web_session=", "herdr_web_session=abc", cookie.replace(/.$/, (ch) => (ch === "A" ? "B" : "A"))]) {
      expect((await post("send", body, { Cookie: c })).status, c.slice(0, 30)).toBe(401);
    }
    expect(agents[0]!.actions).toEqual([]);
    expect(coreSends()).toEqual([]);
  });
});

describe("the `/` rule", () => {
  it("a slash message for a terminal that has no agent connected types nothing: no thread, no core call", async () => {
    expect((await post("send", { terminal: "t2", text: "/compact" })).status).toBe(409);
    expect((await post("send", { terminal: "t2", text: "hello" })).status).toBe(409);
    expect(coreSends()).toEqual([]);
  });

  it("a slash message for a finished terminal, an unknown one and another machine's types nothing", async () => {
    expect((await post("send", { terminal: "t4", text: "/compact" })).status).toBe(409);
    expect((await post("send", { terminal: "t99", text: "/compact" })).status).toBe(404);
    expect((await post("send", { terminal: "cachyos/t9", text: "/compact" })).status).toBe(400);
    expect(coreSends()).toEqual([]);
  });

  it("what is typed is the browser's text and only that: one terminal.send with two keys, to the terminal named, never another", async () => {
    await agent("t1");
    await agent("t2");
    await until(() => h.chat.has("t1") && h.chat.has("t2"));
    const text = "/model\u0003\u001b[A rm -rf ~";
    expect((await post("send", { terminal: "t2", text })).body).toEqual({ via: "terminal" });
    expect(coreSends()).toHaveLength(1);
    expect(coreSends()[0]!.params).toEqual({ terminal: "t2", text });
    expect(agents[0]!.actions).toEqual([]); // t1's agent was not asked to do anything
  });

  it("a hundred slash messages at once each clear the input and type once, and the backend stays up", async () => {
    await agent("t1");
    await until(() => h.chat.has("t1"));
    const all = await Promise.all(Array.from({ length: 100 }, (_, i) => post("send", { terminal: "t1", text: `/x${i}` })));
    expect(all.every((r) => r.status === 200)).toBe(true);
    expect(coreSends()).toHaveLength(100);
    expect(agents[0]!.actions.filter((a) => a["op"] === "clear_input")).toHaveLength(100);
    expect((await raw("/health", {})).status).toBe(200);
  });

  it("a slash message that the agent never answers for is a sentence after the agent's time, and nothing is typed", async () => {
    const a = await agent("t1");
    await until(() => h.chat.has("t1"));
    a.answer = () => null;
    const r = await post("send", { terminal: "t1", text: "/compact" });
    expect(r.status).toBe(409);
    expect(typeof r.body.error).toBe("string");
    expect(coreSends()).toEqual([]);
  });
});

describe("a process that is not pi on the agents socket", () => {
  const hello = (file: string | null, terminalId = "t1") => ({ v: 1, type: "hello", agent: "pi", terminalId, pid: 1, extension: "x", reason: "startup", session: { id: "s", file, name: null, cwd: "/" } });
  const state = { v: 1, type: "state", leafId: null, model: null, effort: null, efforts: [], working: false, pending: [], usage: null, name: null };

  async function hostile(lines: Array<unknown | string>, closeAfterMs = 300): Promise<{ closed: boolean }> {
    const a = await FakeAgent.connect(h.agentsSocket!);
    agents.push(a);
    for (const l of lines) a.socket.write(typeof l === "string" ? l : JSON.stringify(l) + "\n");
    await sleep(closeAfterMs);
    return { closed: a.closed };
  }
  const alive = async () => {
    expect((await raw("/health", {})).status).toBe(200);
    // and a proper agent still gets its chat
    const good = await agent("t2");
    await until(() => h.chat.has("t2"), 3000);
    good.close();
  };

  it("session files that are not session files: the backend reads none of them, says why once, and carries on", async () => {
    const dir = tmpDir();
    const fifo = path.join(dir, "pipe.jsonl");
    execFileSync("mkfifo", [fifo]);
    const isDir = path.join(dir, "dir.jsonl");
    fs.mkdirSync(isDir);
    const link = path.join(dir, "passwd.jsonl");
    fs.symlinkSync("/etc/passwd", link);
    const files = ["/etc/passwd", "/dev/zero", "/dev/null", "relative.jsonl", "../../etc/passwd.jsonl", "", "a\u0000b.jsonl", fifo, isDir, link, "/" + "d/".repeat(2000) + "x.jsonl", "x".repeat(100_000)];
    const secret = path.join(dir, "secret.jsonl");
    fs.writeFileSync(secret, "SECRET-LINE-123 token=abc\n");
    for (const file of [...files, secret]) {
      await hostile([hello(file), state], 250);
      // whatever came of it, a thread built from a file that is not a session shows none of the file's words
      const t = h.chat.thread("t1");
      if (t) expect(JSON.stringify(t.snapshot()), `file ${file.slice(0, 60)}`).not.toMatch(/root:|nobody:|SECRET-LINE|token=abc/);
      expect((await raw("/health", {})).status).toBe(200);
    }
    await alive();
  }, 30_000);

  it("garbage before a hello, a hello for a terminal that is not live, and a hello that never comes are all closed", async () => {
    const cases: Array<Array<unknown | string>> = [
      ["\n\n\n"],
      ["not json\n"],
      ["[]\n"],
      ["null\n"],
      [{ v: 1, type: "state" }],
      [hello(null, "t99"), state],
      [hello(null, "t4"), state],
      [hello(null, "cachyos/t9"), state],
      [hello(null, "t1"), "{broken"],
      [hello(null, "t1")], // hello but never a state
      [],
    ];
    for (const lines of cases) {
      const r = await hostile(lines, 700);
      expect(r.closed, JSON.stringify(lines).slice(0, 80)).toBe(true);
    }
    expect(h.chat.has("t1")).toBe(false);
    await alive();
  }, 30_000);

  it("a line of more than 4 MiB closes the connection; a line of 3 MiB of whitespace does not hurt anything", async () => {
    expect((await hostile([hello(null), state, "x".repeat(5 * 1024 * 1024)], 600)).closed).toBe(true);
    expect(h.logs.some((l) => /longer than/.test(l))).toBe(true);
    await hostile([hello(null, "t2"), state, " ".repeat(3 * 1024 * 1024) + "\n"], 300);
    await alive();
  }, 30_000);

  it("three hundred connections that say hello for terminals that are not live do not stop a real one from getting chat", async () => {
    const many: net.Socket[] = [];
    for (let i = 0; i < 300; i++) {
      const s = net.connect(h.agentsSocket!);
      s.on("error", () => {});
      s.write(JSON.stringify(hello(null, `t9${i}`)) + "\n" + JSON.stringify(state) + "\n");
      many.push(s);
    }
    await sleep(300);
    const t0 = Date.now();
    expect((await raw("/health", {})).status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(1000);
    for (const s of many) s.destroy();
    await sleep(100);
    await alive();
  }, 30_000);

  it("a real agent keeps its chat when a hostile process claims the same terminal and sends garbage (another process id is refused while the holder lives)", async () => {
    const real = await agent("t1");
    await until(() => h.chat.has("t1"));
    await hostile([hello(null, "t1"), state, "garbage\n", "garbage\n"], 200);
    // DEV-29: the hostile one has another process id (1, the real one's is 4242), so its hello is refused: the real agent keeps the
    // chat, nothing flips, and the bridge is fine.
    await sleep(300);
    expect(real.closed).toBe(false);
    expect(h.chat.has("t1")).toBe(true);
    expect((await raw("/health", {})).status).toBe(200);
  }, 15_000);

  it("a state with a huge pending list and ten thousand tool starts does not make a snapshot bigger than the main socket allows a browser to hold", async () => {
    const a = await agent("t1");
    await until(() => h.chat.has("t1"));
    const big = Array.from({ length: 5000 }, (_, i) => ({ id: `p${i}`, text: "m".repeat(200), mode: "steer" }));
    a.send({ ...state, pending: big });
    for (let i = 0; i < 10_000; i++) a.send({ type: "tool", phase: "start", callId: `call-${i}`, name: "bash" });
    await sleep(500);
    const t = h.chat.thread("t1");
    expect(t).toBeDefined();
    const bytes = JSON.stringify(t!.snapshot()).length;
    // the snapshot goes to a browser under a 4 MiB buffer limit: it must fit, or one agent can lock every browser out of its chat
    expect(bytes, `snapshot is ${bytes} bytes`).toBeLessThan(4 * 1024 * 1024);
  }, 30_000);
});

describe("the chat part of the main socket", () => {
  it("five hundred subscribe messages for a thread with large rows never leave the bridge holding more than a browser may be sent", async () => {
    await agent("t1", sessionFile(4000));
    await until(() => h.chat.has("t1"));
    const c = await socket();
    for (let i = 0; i < 500; i++) c.send(JSON.stringify({ type: "chat.subscribe", terminal: "t1" }));
    await until(() => c.closed !== undefined || c.messages.filter((m) => m.type === "chat.snapshot").length >= 100, 5000).catch(() => {});
    // either it served every one (small) or it let go of the browser with 1013; it must not still be queuing
    expect(h.chat.subscriberCount("t1")).toBeLessThanOrEqual(1);
    expect((await raw("/health", {})).status).toBe(200);
  }, 20_000);

  it("subscribe, unsubscribe and subscribe again, many times, ends with one listener, and closing the page ends it", async () => {
    await agent("t1");
    await until(() => h.chat.has("t1"));
    const c = await socket();
    for (let i = 0; i < 50; i++) {
      c.send(JSON.stringify({ type: "chat.subscribe", terminal: "t1" }));
      if (i % 3 === 0) c.send(JSON.stringify({ type: "chat.unsubscribe", terminal: "t1" }));
    }
    c.send(JSON.stringify({ type: "chat.unsubscribe", terminal: "t2" })); // never subscribed: nothing
    await until(() => h.chat.subscriberCount("t1") === 1, 2000);
    c.close();
    await until(() => h.chat.subscriberCount("t1") === 0, 2000);
  });

  it("fifty pages opened and closed leave no listener for the terminal and no chat on the one that is gone", async () => {
    await agent("t1");
    await until(() => h.chat.has("t1"));
    for (let i = 0; i < 50; i++) {
      const c = await openSocket(h, { Origin: ORIGIN, Cookie: cookie });
      c.send(JSON.stringify({ type: "chat.subscribe", terminal: "t1" }));
      c.close();
    }
    await until(() => h.chat.subscriberCount("t1") === 0, 3000);
  }, 20_000);

  it("a subscriber whose terminal is killed hears that it ended and then nothing, and a late agent for it is closed", async () => {
    const a = await agent("t1");
    await until(() => h.chat.has("t1"));
    const c = await socket();
    c.send(JSON.stringify({ type: "chat.subscribe", terminal: "t1" }));
    await until(() => c.messages.some((m) => m.type === "chat.snapshot"));
    h.core.event("finished", "t1", { reason: "killed", exit_code: null, signal: 9, finished_ms: 5 });
    await until(() => a.closed);
    await until(() => c.messages.some((m) => m.type === "chat.unavailable"));
    const n = c.messages.length;
    const late = await agent("t1");
    await until(() => late.closed, 3000);
    await sleep(100);
    expect(c.messages.slice(n).filter((m) => m.type.startsWith("chat."))).toEqual([]);
    expect(h.chat.has("t1")).toBe(false);
  });
});

describe("the status codes PROTOCOL.md names", () => {
  it("502 when core refuses the typing of a / command, and the agent's input box was emptied first", async () => {
    const a = await agent("t1");
    await until(() => h.chat.has("t1"));
    h.core.rpc.set("terminal.send", () => ({ error: { message: "core says no" } }));
    const res = await post("send", { terminal: "t1", text: "/compact" });
    expect(res.status).toBe(502);
    expect(String(res.body?.error)).toContain("core says no");
    expect(a.actions.map((x) => x["op"])).toEqual(["clear_input"]);
  });

  it("503 for a / command while the backend is not connected to core; an ordinary message needs no core and still reaches the agent", async () => {
    const a = await agent("t1");
    await until(() => h.chat.has("t1"));
    await h.core.stop();
    await until(() => h.session.state !== "connected", 3000);
    expect((await post("send", { terminal: "t1", text: "/compact" })).status).toBe(503);
    expect((await post("send", { terminal: "t1", text: "plain" })).status).toBe(200);
    expect(a.actions.map((x) => [x["op"], x["text"]])).toEqual([["clear_input", undefined], ["send", "plain"]]);
  });
});

describe("two pis carrying one terminal id (a pi started inside a pi's terminal)", () => {
  it("two pis that both carry the id of terminal t1 (a pi started inside the pi in t1) do not take the chat from each other over and over", async () => {
    const { default: herdrWeb } = await import("../../../packages/pi-extension/src/index.js");
    const { FakePi } = await import("../../../packages/pi-extension/test/harness.js");
    const saved = { id: process.env["HC_TERMINAL_ID"], sock: process.env["HERDR_WEB_AGENTS_SOCKET"] };
    process.env["HC_TERMINAL_ID"] = "t1";
    process.env["HERDR_WEB_AGENTS_SOCKET"] = h.agentsSocket!;
    const pis = [new FakePi(), new FakePi()];
    try {
      for (const pi of pis) pi.load();
      const c = await socket();
      c.send(JSON.stringify({ type: "chat.subscribe", terminal: "t1" }));
      pis[0]!.emit("session_start", { reason: "startup" });
      await sleep(200);
      pis[1]!.emit("session_start", { reason: "startup" });
      const before = c.messages.length;
      await sleep(4000);
      const flips = c.messages.slice(before).filter((m: any) => m.type === "chat.snapshot" || (m.type === "chat.change" && m.change?.type === "reset") || (m.type === "terminal" && m.terminal?.address === "t1" && m.terminal?.chat === false)).length;
      // one takeover and then quiet; the real thing flips every half second while the inner pi lives
      expect(flips).toBeLessThanOrEqual(2);
    } finally {
      for (const pi of pis) pi.emit("session_shutdown");
      if (saved.id === undefined) delete process.env["HC_TERMINAL_ID"];
      else process.env["HC_TERMINAL_ID"] = saved.id;
      if (saved.sock === undefined) delete process.env["HERDR_WEB_AGENTS_SOCKET"];
      else process.env["HERDR_WEB_AGENTS_SOCKET"] = saved.sock;
    }
  }, 20_000);
});
