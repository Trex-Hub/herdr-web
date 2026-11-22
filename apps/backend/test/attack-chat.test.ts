import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { Terminal } from "@herdr-web/core-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assistantEntry, sessionHeader, tmpDir, toolResultEntry, userEntry } from "../../../packages/agents/test/helpers.js";
import { chatPicture } from "../../../packages/agents/test/fake-pi-live.js";
import { LivePi, type LivePiOptions } from "./fake-pi.js";
import { openSocket, ORIGIN, startHarness, until, type Client, type Harness } from "./helpers.js";

// The chat routes, the pi-live folder and the chat part of the main socket attacked from outside: what a browser
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
const pis: LivePi[] = [];
const sockets: Client[] = [];

/** A pi in a terminal: its pi-live socket and its session file in the folder the hub watches. */
async function pi(terminal: string | null = "t1", file: string | null = sessionFile(), extra: Partial<LivePiOptions> = {}): Promise<LivePi> {
  const p = await LivePi.start(h.liveDir!, { terminal, file, config: { chat: chatPicture() }, ...extra });
  pis.push(p);
  return p;
}
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
  h = await startHarness({ connectCore: false, live: { terminalWaitMs: 300, coreWaitMs: 500, followMs: 600, connection: { welcomeTimeoutMs: 400, maxLineBytes: 4 * 1024 * 1024, thread: { actionTimeoutMs: 300, entryWaitMs: 100 } } } });
  h.core.machines = [{ name: "cachyos", target: "x", id: "i", host: "h", version: "1", state: "connected" }];
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
    await pi("t1");
    await until(() => h.chat.has("t1"));
  });
  for (const [name, what, body] of bad) {
    it(`${name}: ${what}`, async () => {
      const r = await post(name, body);
      expect(r.status, r.text).toBe(400);
      expect(typeof r.body?.error).toBe("string");
      expect(pis[0]!.actions).toEqual([]);
      expect(coreSends()).toEqual([]);
    });
  }

  it("a body that is not JSON, or is not sent as JSON, is not read", async () => {
    for (const text of ["", "null", "[]", "{", "7", `"x"`]) expect((await post("send", text)).status, JSON.stringify(text)).toBe(400);
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      const r = await raw("/api/chat/send", { method: "POST", headers: { Origin: ORIGIN, Cookie: cookie, "Content-Type": type }, body: JSON.stringify({ terminal: "t1", text: "hi" }) });
      expect(r.status, type).toBe(400);
    }
    expect(pis[0]!.actions).toEqual([]);
  });

  it("a body over 1 MB is refused", async () => {
    const r = await post("send", { terminal: "t1", text: "x".repeat(1_100_000) });
    expect(r.status).toBe(413);
    expect(pis[0]!.actions).toEqual([]);
  });

  it("only POST does anything on a chat route; an unknown name or a name from Object.prototype is a 404", async () => {
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      expect((await raw("/api/chat/send", { method, headers: headers(), ...(method === "GET" ? {} : { body: JSON.stringify({ terminal: "t1", text: "hi" }) }) })).status, method).toBe(404);
    }
    for (const name of ["format", "__proto__", "constructor", "toString", "SEND", "send%2Fstop"]) {
      expect((await post(name, { terminal: "t1", text: "hi" })).status, name).toBe(404);
    }
    expect(pis[0]!.actions).toEqual([]);
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
    expect(pis[0]!.actions).toEqual([]);
    expect(coreSends()).toEqual([]);
  });
});

describe("the `/` rule", () => {
  it("a slash message for a terminal that has no pi connected types nothing: no thread, no core call", async () => {
    expect((await post("send", { terminal: "t2", text: "/model" })).status).toBe(409);
    expect((await post("send", { terminal: "t2", text: "hello" })).status).toBe(409);
    expect(coreSends()).toEqual([]);
  });

  it("a slash message for a finished terminal, an unknown one and another machine's types nothing", async () => {
    expect((await post("send", { terminal: "t4", text: "/model" })).status).toBe(409);
    expect((await post("send", { terminal: "t99", text: "/model" })).status).toBe(404);
    expect((await post("send", { terminal: "cachyos/t9", text: "/model" })).status).toBe(400);
    expect(coreSends()).toEqual([]);
  });

  it("what is typed is the browser's text and only that: one terminal.send with two keys, to the terminal named, never another", async () => {
    await pi("t1");
    await pi("t2");
    await until(() => h.chat.has("t1") && h.chat.has("t2"));
    const text = "/model \u0003\u001b[A rm -rf ~";
    expect((await post("send", { terminal: "t2", text })).body).toEqual({ via: "terminal" });
    expect(coreSends()).toHaveLength(1);
    expect(coreSends()[0]!.params).toEqual({ terminal: "t2", text });
    expect(pis[0]!.actions).toEqual([]); // t1's pi was not asked to do anything
  });

  it("a text that only looks like a built-in is a message, never typed: control characters or letters after the name, another case, a path", async () => {
    await pi("t1");
    await until(() => h.chat.has("t1"));
    for (const text of ["/model\u0003", "/model\u001b[A", "/models", "/MODEL", "/etc/passwd", "//model", "/new\u0000"]) {
      expect((await post("send", { terminal: "t1", text })).body, JSON.stringify(text)).toEqual({ via: "agent" });
    }
    expect(coreSends()).toEqual([]);
    expect(pis[0]!.actions.every((a) => a["op"] === "send")).toBe(true);
  });

  it("a hundred built-in commands at once each clear the input and type once, and the backend stays up", async () => {
    await pi("t1");
    await until(() => h.chat.has("t1"));
    const all = await Promise.all(Array.from({ length: 100 }, (_, i) => post("send", { terminal: "t1", text: `/model ${i}` })));
    expect(all.every((r) => r.status === 200)).toBe(true);
    expect(coreSends()).toHaveLength(100);
    expect(pis[0]!.actions.filter((a) => a["op"] === "clear_input")).toHaveLength(100);
    expect((await raw("/health", {})).status).toBe(200);
  });

  it("a command that pi never answers for is a sentence after pi's time, and nothing is typed", async () => {
    const a = await pi("t1");
    await until(() => h.chat.has("t1"));
    a.fake.config.autoReply = false;
    for (const text of ["/model", "/compact", "/name x"]) {
      const r = await post("send", { terminal: "t1", text });
      expect(r.status, text).toBe(409);
      expect(typeof r.body.error).toBe("string");
    }
    expect(coreSends()).toEqual([]);
  });
});

describe("a folder and sockets that are not pi-live's", () => {
  /** A session file written by hand, as pi-live writes them. */
  function writeSession(fields: Record<string, unknown> | string, name?: string): string {
    const body = typeof fields === "string" ? fields : JSON.stringify({ protocol: 1, sessionId: "hand", cwd: "/", pid: 4242, startedAt: "2026-01-01T00:00:00.000Z", socketPath: "/tmp/hw-nowhere.sock", mode: "tui", terminal: "t1", ...fields });
    const file = path.join(h.liveDir!, name ?? `${typeof fields === "string" ? "hand" : String(fields["sessionId"] ?? "hand")}.json`);
    fs.writeFileSync(file, body);
    return file;
  }
  const servers: net.Server[] = [];
  const held: net.Socket[] = [];
  /** A unix socket whose behaviour the test gives: what it does with each connection. */
  async function socketThat(onConnection: (s: net.Socket) => void): Promise<string> {
    const p = path.join(fs.mkdtempSync("/tmp/hw-hs-"), "h.sock");
    const server = net.createServer((s) => {
      s.on("error", () => {});
      held.push(s);
      onConnection(s);
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(p, r));
    return p;
  }
  afterEach(async () => {
    for (const s of held.splice(0)) s.destroy();
    for (const server of servers.splice(0)) await new Promise((r) => server.close(r));
  });
  const alive = async () => {
    expect((await raw("/health", {})).status).toBe(200);
    // and a proper pi still gets its chat
    const good = await pi("t2");
    await until(() => h.chat.has("t2"), 3000);
    die(good);
    await until(() => !h.chat.has("t2"), 3000);
  };

  it("files that are not session files: the backend reads none of them, says why once, never connects, and carries on", async () => {
    const dir = h.liveDir!;
    const fifo = path.join(dir, "pipe.json");
    execFileSync("mkfifo", [fifo]);
    fs.mkdirSync(path.join(dir, "dir.json"));
    fs.symlinkSync("/etc/passwd", path.join(dir, "passwd.json"));
    fs.symlinkSync("/dev/zero", path.join(dir, "zero.json"));
    const odd: Array<Record<string, unknown> | string> = [
      "",
      "not json",
      "[]",
      "null",
      "7",
      '{"sessionId":',
      "x".repeat(100_000),
      JSON.stringify({ sessionId: "big", pid: 4242, socketPath: "/tmp/x.sock", mode: "tui", terminal: "t1", pad: "y".repeat(100_000) }),
      { sessionId: "pid0", pid: 0 },
      { sessionId: "pidneg", pid: -1 },
      { sessionId: "pidfloat", pid: 1.5 },
      { sessionId: "pidhuge", pid: 2 ** 53 },
      { sessionId: "pidstr", pid: "4242" },
      { sessionId: "pidnull", pid: null },
      { sessionId: "relsock", socketPath: "pi.sock" },
      { sessionId: "emptysock", socketPath: "" },
      { sessionId: "nulsock", socketPath: "/tmp/a\u0000b.sock" },
      { sessionId: "objsock", socketPath: { path: "/tmp/x" } },
      { sessionId: "", socketPath: "/tmp/x.sock" },
      { sessionId: "x".repeat(300) },
      { sessionId: "someone-else" },
      { sessionId: "proto2", protocol: 2 },
      { sessionId: "../../../etc/passwd" },
    ];
    odd.forEach((fields, i) => {
      if (typeof fields === "string") writeSession(fields, `junk${i}.json`);
      else if (fields["sessionId"] === "someone-else") writeSession(fields, "named-otherwise.json");
      else writeSession(fields, typeof fields["sessionId"] === "string" && /^[\w-]{1,100}$/.test(fields["sessionId"]) ? undefined : `junk${i}.json`);
    });
    await sleep(600); // several looks at the folder
    expect(pis.length).toBe(0);
    expect(h.chat.has("t1")).toBe(false);
    // nothing of what was in those files is in the log, and each is said at most once
    expect(h.logs.join("\n")).not.toMatch(/root:|nobody:/);
    const sorted = [...h.logs].sort();
    expect(new Set(sorted).size).toBe(sorted.length);
    await alive();
  }, 30_000);

  it("a session file whose socket is not there, is a file, a folder or the null device: one line each, no crash, no retry loop", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "plain");
    fs.writeFileSync(file, "x");
    const targets = ["/tmp/hw-no-such.sock", file, dir, "/dev/null"];
    targets.forEach((socketPath, i) => writeSession({ sessionId: `bad${i}`, socketPath, terminal: "t1", pid: 100 + i }));
    await sleep(800);
    expect(h.logs.filter((l) => /could not connect to the pi of .* in terminal "t1"/.test(l)).length).toBeGreaterThanOrEqual(1);
    for (const l of h.logs) expect(h.logs.filter((x) => x === l), l).toHaveLength(1);
    expect(h.chat.has("t1")).toBe(false);
    await alive();
  }, 30_000);

  it("a socket that never answers, one that sends garbage, and one with the wrong protocol are closed with one line each; the terminal stays free for a real pi", async () => {
    const silent = await socketThat(() => {});
    const garbage = await socketThat((s) => s.write("\n\nnot json\n[]\nnull\n{\"type\":\"welcome\"}\n"));
    const wrong = await socketThat((s) => s.write(JSON.stringify({ type: "welcome", protocol: 7, features: ["chat"], session: { id: "x", pid: 1 } }) + "\n"));
    [silent, garbage, wrong].forEach((socketPath, i) => writeSession({ sessionId: `odd${i}`, socketPath, pid: 100 + i, terminal: "t1" }));
    await sleep(900); // longer than the welcome wait, shorter than the first retry
    expect(h.chat.has("t1")).toBe(false);
    expect(h.logs.filter((l) => /did not send its welcome in time/.test(l))).toHaveLength(1);
    expect(h.logs.filter((l) => /speaks protocol 1|speaks protocol|protocol 7/.test(l))).toHaveLength(1);
    // a real pi in that terminal still gets the chat
    const real = await pi("t1", sessionFile(), { pid: 7000 });
    await until(() => h.chat.has("t1"), 3000);
    expect(real.connections).toBe(1);
    await alive();
  }, 30_000);

  it("a line of more than the limit closes the connection with one line, and a line of 3 MiB of whitespace does not hurt anything", async () => {
    const live = await pi("t1");
    await until(() => h.chat.has("t1"));
    live.send({ type: "notice", level: "info", text: "x" });
    live.fake.sendRaw(" ".repeat(3 * 1024 * 1024) + "\n");
    live.fake.sendRaw("x".repeat(5 * 1024 * 1024));
    await until(() => h.logs.some((l) => /longer than/.test(l)), 5000);
    expect(h.logs.filter((l) => /longer than/.test(l))).toHaveLength(1);
    await alive();
  }, 30_000);

  it("three hundred session files for terminals that are not live do not stop a real pi from getting chat", async () => {
    for (let i = 0; i < 300; i++) writeSession({ sessionId: `many${i}`, terminal: `t9${i}`, pid: 1000 + i });
    await sleep(300);
    const t0 = Date.now();
    expect((await raw("/health", {})).status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(1000);
    await alive();
  }, 30_000);

  it("a real pi keeps its chat when another process claims the same terminal with a file and a socket that sends garbage (another pid is refused while the holder lives)", async () => {
    const real = await pi("t1");
    await until(() => h.chat.has("t1"));
    const garbage = await socketThat((s) => s.write("garbage\ngarbage\n"));
    writeSession({ sessionId: "claimant", socketPath: garbage, terminal: "t1", pid: 1 });
    await sleep(500);
    expect(real.connections).toBe(1);
    expect(h.chat.has("t1")).toBe(true);
    expect((await raw("/health", {})).status).toBe(200);
  }, 15_000);

  it("a state with a huge pending list and ten thousand tool starts does not make a snapshot bigger than the main socket allows a browser to hold", async () => {
    const a = await pi("t1");
    await until(() => h.chat.has("t1"));
    const big = Array.from({ length: 5000 }, (_, i) => ({ id: `p${i}`, text: "m".repeat(200), mode: "steer" }));
    a.send({ type: "state", leafId: null, model: null, effort: null, efforts: [], working: false, pending: big, usage: null, name: null });
    for (let i = 0; i < 10_000; i++) a.send({ type: "tool", phase: "start", callId: `call-${i}`, name: "bash" });
    await sleep(500);
    const t = h.chat.thread("t1");
    expect(t).toBeDefined();
    const bytes = JSON.stringify(t!.snapshot()).length;
    // the snapshot goes to a browser under a 4 MiB buffer limit: it must fit, or one pi can lock every browser out of its chat
    expect(bytes, `snapshot is ${bytes} bytes`).toBeLessThan(4 * 1024 * 1024);
  }, 30_000);
});

describe("the chat part of the main socket", () => {
  it("five hundred subscribe messages for a thread with large rows never leave the bridge holding more than a browser may be sent", async () => {
    await pi("t1", sessionFile(4000));
    await until(() => h.chat.has("t1"));
    const c = await socket();
    for (let i = 0; i < 500; i++) c.send(JSON.stringify({ type: "chat.subscribe", terminal: "t1" }));
    await until(() => c.closed !== undefined || c.messages.filter((m) => m.type === "chat.snapshot").length >= 100, 5000).catch(() => {});
    // either it served every one (small) or it let go of the browser with 1013; it must not still be queuing
    expect(h.chat.subscriberCount("t1")).toBeLessThanOrEqual(1);
    expect((await raw("/health", {})).status).toBe(200);
  }, 20_000);

  it("subscribe, unsubscribe and subscribe again, many times, ends with one listener, and closing the page ends it", async () => {
    await pi("t1");
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
    await pi("t1");
    await until(() => h.chat.has("t1"));
    for (let i = 0; i < 50; i++) {
      const c = await openSocket(h, { Origin: ORIGIN, Cookie: cookie });
      c.send(JSON.stringify({ type: "chat.subscribe", terminal: "t1" }));
      c.close();
    }
    await until(() => h.chat.subscriberCount("t1") === 0, 3000);
  }, 20_000);

  it("a subscriber whose terminal is killed hears that it ended and then nothing, and a late pi for it is never connected to", async () => {
    const a = await pi("t1");
    await until(() => h.chat.has("t1"));
    const c = await socket();
    c.send(JSON.stringify({ type: "chat.subscribe", terminal: "t1" }));
    await until(() => c.messages.some((m) => m.type === "chat.snapshot"));
    h.core.event("finished", "t1", { reason: "killed", exit_code: null, signal: 9, finished_ms: 5 });
    await until(() => a.connections === 0);
    await until(() => c.messages.some((m) => m.type === "chat.unavailable"));
    const n = c.messages.length;
    const late = await pi("t1");
    await sleep(500);
    expect(late.hellos).toBe(0);
    expect(c.messages.slice(n).filter((m) => m.type.startsWith("chat."))).toEqual([]);
    expect(h.chat.has("t1")).toBe(false);
  });
});

describe("the status codes PROTOCOL.md names", () => {
  it("502 when core refuses the typing of a built-in command, and pi's input box was emptied first", async () => {
    const a = await pi("t1");
    await until(() => h.chat.has("t1"));
    h.core.rpc.set("terminal.send", () => ({ error: { message: "core says no" } }));
    const res = await post("send", { terminal: "t1", text: "/model" });
    expect(res.status).toBe(502);
    expect(String(res.body?.error)).toContain("core says no");
    expect(a.actions.map((x) => x["op"])).toEqual(["clear_input"]);
  });

  it("503 for a built-in command while the backend is not connected to core; an ordinary message, /compact and /name need no core and still reach pi", async () => {
    const a = await pi("t1");
    await until(() => h.chat.has("t1"));
    await h.core.stop();
    await until(() => h.session.state !== "connected", 3000);
    expect((await post("send", { terminal: "t1", text: "/model" })).status).toBe(503);
    expect((await post("send", { terminal: "t1", text: "plain" })).status).toBe(200);
    expect((await post("send", { terminal: "t1", text: "/compact" })).status).toBe(200);
    expect(a.actions.map((x) => [x["op"], x["text"]])).toEqual([["clear_input", undefined], ["send", "plain"], ["compact", undefined]]);
  });
});

describe("two pis carrying one terminal id (a pi started inside a pi's terminal)", () => {
  it("the inner pi, another process with the same terminal id, does not take the chat from the first over and over", async () => {
    const outer = await pi("t1", sessionFile(), { pid: 100 });
    await until(() => h.chat.has("t1"));
    const c = await socket();
    c.send(JSON.stringify({ type: "chat.subscribe", terminal: "t1" }));
    await until(() => c.messages.some((m) => m.type === "chat.snapshot"));
    const inner = await pi("t1", sessionFile(), { pid: 200 });
    const before = c.messages.length;
    await sleep(2000);
    const flips = c.messages.slice(before).filter((m: any) => m.type === "chat.snapshot" || m.type === "chat.unavailable" || (m.type === "chat.change" && m.change?.type === "reset") || (m.type === "terminal" && m.terminal?.address === "t1" && m.terminal?.chat === false)).length;
    expect(flips).toBe(0);
    expect(outer.connections).toBe(1);
    expect(inner.hellos).toBe(0);
  }, 20_000);
});
