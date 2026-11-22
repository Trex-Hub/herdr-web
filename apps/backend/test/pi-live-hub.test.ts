// How the backend finds, follows and loses the pis of pi-live (DEV-35 rules 1, 3, 4 and 8), through the hub, with the files and
// sockets a pi-live writes, and the folder the harness gives it under /tmp.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Terminal } from "@herdr-web/core-client";
import { afterEach, describe, expect, it } from "vitest";
import { chatPicture } from "../../../packages/agents/test/fake-pi-live.js";
import { assistantEntry, sessionHeader, tmpDir, userEntry } from "../../../packages/agents/test/helpers.js";
import type { ChatEvent } from "../src/chat.js";
import { RECONNECTING, RELOADING } from "../src/chat.js";
import { piLiveDir } from "../src/pi-live-dir.js";
import { readPiSessions } from "../src/pi-sessions.js";
import { LivePi, type LivePiOptions } from "./fake-pi.js";
import { startHarness, until, type Harness } from "./helpers.js";

const term = (address: string): Terminal => ({ address, argv: ["pi"], cols: 80, rows: 24, created_ms: 1, cwd: "/", state: "live", screen: "exact", labels: {}, title: "", turn: 0 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FOLLOW = 700;

let h: Harness | undefined;
const pis: LivePi[] = [];
const alivePids = new Set<number>();

async function start(live: Record<string, unknown> = {}): Promise<Harness> {
  h = await startHarness({ connectCore: false, live: { terminalWaitMs: 300, coreWaitMs: 500, followMs: FOLLOW, alive: (pid: number) => alivePids.has(pid), connection: { thread: { actionTimeoutMs: 300, entryWaitMs: 100 } }, ...live } });
  h.core.terminals = [term("t1"), term("t2")];
  h.session.start();
  await until(() => h!.session.state === "connected" && h!.session.store.get("t2") !== undefined);
  return h;
}
async function pi(terminal: string, pid = 100, extra: Partial<LivePiOptions> = {}): Promise<LivePi> {
  alivePids.add(pid);
  const p = await LivePi.start(h!.liveDir!, { terminal, pid, config: { chat: chatPicture() }, ...extra });
  pis.push(p);
  return p;
}
/** Subscribe the way a browser's page does; what it is told lands in `events`. */
function listen(terminal = "t1"): { events: ChatEvent[]; off: () => void } {
  const events: ChatEvent[] = [];
  const off = h!.chat.subscribe(terminal, (e) => events.push(e));
  return { events, off };
}
const kinds = (events: ChatEvent[]) => events.map((e) => (e.type === "change" ? `change:${e.change.type}` : e.type));

afterEach(async () => {
  await h?.stop();
  h = undefined;
  for (const p of pis.splice(0)) await p.stop();
  alivePids.clear();
});

describe("which folder (rule 1)", () => {
  const env = (extra: Record<string, string>) => ({ ...extra });
  function agentDir(settings?: unknown): string {
    const dir = fs.mkdtempSync("/tmp/hw-agent-");
    if (settings !== undefined) fs.writeFileSync(path.join(dir, "pi-live.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
    return dir;
  }

  it("$PI_LIVE_DIR first, over the settings file and the agent dir", () => {
    const dir = agentDir({ dir: "/tmp/from-settings" });
    expect(piLiveDir(env({ PI_LIVE_DIR: " /tmp/from-env ", PI_CODING_AGENT_DIR: dir }))).toBe("/tmp/from-env");
  });

  it("then `dir` in <agent dir>/pi-live.json, trimmed", () => {
    expect(piLiveDir(env({ PI_CODING_AGENT_DIR: agentDir({ dir: "  /tmp/from-settings " }) }))).toBe("/tmp/from-settings");
  });

  it("then <agent dir>/live, the agent dir being $PI_CODING_AGENT_DIR or ~/.pi/agent; a settings file with no usable dir changes nothing", () => {
    for (const settings of [undefined, "{broken", "[]", "null", { dir: 5 }, { dir: "  " }, {}]) {
      const dir = agentDir(settings);
      expect(piLiveDir(env({ PI_CODING_AGENT_DIR: dir })), JSON.stringify(settings)).toBe(path.join(dir, "live"));
    }
    expect(piLiveDir({})).toMatch(/\/\.pi\/agent\/live$/);
    expect(piLiveDir({ PI_CODING_AGENT_DIR: "  " })).toMatch(/\/\.pi\/agent\/live$/);
  });

  it("a relative folder is made absolute", () => {
    expect(path.isAbsolute(piLiveDir({ PI_LIVE_DIR: "rel/live" }))).toBe(true);
  });
});

describe("session files (rule 1)", () => {
  it("only a tui pi with a terminal is a candidate, and only one whose file is named by its session id", () => {
    const dir = fs.mkdtempSync("/tmp/hw-sf-");
    const base = { protocol: 1, cwd: "/", pid: 5, socketPath: "/tmp/x.sock", startedAt: "2026-01-01T00:00:00.000Z" };
    const put = (name: string, body: object) => fs.writeFileSync(path.join(dir, name), JSON.stringify(body));
    put("a.json", { ...base, sessionId: "a", mode: "tui", terminal: "t1" });
    put("b.json", { ...base, sessionId: "b", mode: "rpc", terminal: "t1" });
    put("c.json", { ...base, sessionId: "c", mode: "tui" });
    put("d.json", { ...base, sessionId: "other", mode: "tui", terminal: "t1" });
    put("e.json", { ...base, sessionId: "e", mode: "tui", terminal: "t1", protocol: 2 });
    put("f.json.tmp", { ...base, sessionId: "f", mode: "tui", terminal: "t1" });
    put("notes.txt", {});
    const invalid: string[] = [];
    const found = readPiSessions(dir, (file) => invalid.push(path.basename(file)));
    expect(found.map((s) => s.sessionId)).toEqual(["a"]);
    expect(invalid).toEqual(["d.json"]); // another protocol is not ours: left alone without a word
  });

  it("a folder that is not there is an empty one", () => {
    expect(readPiSessions("/tmp/hw-no-such-folder-" + process.pid, () => {})).toEqual([]);
  });
});

describe("finding pis (rule 1)", () => {
  it("one connection per session id however often the folder is read, and a rescan finds a file the watcher missed", async () => {
    await start({ rescanMs: 50 });
    const p = await pi("t1");
    await until(() => h!.chat.has("t1"));
    await sleep(500);
    expect(p.hellos).toBe(1);
    expect(p.lines.find((m) => m.type === "hello")).toMatchObject({ client: { name: "herdr-web" }, chat: true });
  });

  it("a folder that appears after the backend started is picked up", async () => {
    const parent = fs.mkdtempSync("/tmp/hw-late-");
    const late = path.join(parent, "live");
    await start({ liveDir: late, rescanMs: 50 });
    h!.liveDir = late; // LivePi writes into the folder the hub watches
    fs.mkdirSync(late);
    const p = await pi("t1");
    await until(() => h!.chat.has("t1"));
    expect(p.hellos).toBe(1);
    await p.stop();
    pis.length = 0;
    fs.rmdirSync(late);
    fs.rmdirSync(parent);
    h!.liveDir = null;
  });

  it("a file that vanishes before the backend reads it is skipped quietly", async () => {
    await start();
    const p = await pi("t1", 100, { publish: false });
    p.publish();
    p.unpublish();
    await sleep(300);
    expect(h!.logs).toEqual([]);
  });
});

describe("a session that ends (rule 3)", () => {
  async function linked(): Promise<{ p: LivePi; l: ReturnType<typeof listen> }> {
    await start();
    const p = await pi("t1", 100);
    await until(() => h!.chat.has("t1"));
    const l = listen();
    expect(kinds(l.events)).toEqual(["snapshot"]);
    return { p, l };
  }

  it("quit ends the chat at once: unavailable, with no waiting", async () => {
    const { p, l } = await linked();
    p.goodbye("quit");
    await until(() => kinds(l.events).includes("unavailable"), 500);
    expect(h!.chat.has("t1")).toBe(false);
  });

  it("a goodbye that names no reason is a quit", async () => {
    const { p, l } = await linked();
    p.goodbye();
    await until(() => kinds(l.events).includes("unavailable"), 500);
  });

  it("anything but quit keeps the chat: no unavailable, no flag change, and the way to ask says so", async () => {
    const { p, l } = await linked();
    p.goodbye("new");
    await until(() => p.connections === 0);
    await sleep(200);
    expect(kinds(l.events)).toEqual(["snapshot"]);
    expect(h!.chat.has("t1")).toBe(true);
    expect(h!.chat.whyNot("t1")).toBe(RELOADING);
  });

  it("the new file with the same pid and terminal takes the chat over: subscribers get a reset and nothing else", async () => {
    const { p, l } = await linked();
    p.goodbye("new");
    p.unpublish();
    const next = await pi("t1", 100);
    await until(() => kinds(l.events).length === 2);
    expect(kinds(l.events)).toEqual(["snapshot", "change:reset"]);
    expect(next.connections).toBe(1);
    await sleep(FOLLOW + 200);
    expect(kinds(l.events)).toEqual(["snapshot", "change:reset"]);
    expect(h!.chat.whyNot("t1")).not.toBe(RELOADING);
  });

  it("/reload keeps the path: the file read again at once is the old session, and only the new startedAt is the new one", async () => {
    const { p, l } = await linked();
    p.goodbye("reload");
    await until(() => p.connections === 0);
    await sleep(300); // several looks at the unchanged file
    expect(p.hellos).toBe(1);
    expect(kinds(l.events)).toEqual(["snapshot"]);
    p.publish();
    await until(() => p.hellos === 2, 2000);
    await until(() => kinds(l.events).length === 2);
    expect(kinds(l.events)).toEqual(["snapshot", "change:reset"]);
  });

  it("a new file of another pid does not take the chat while the wait lasts; one of another terminal does not either", async () => {
    const { p, l } = await linked();
    p.goodbye("new");
    p.unpublish();
    const other = await pi("t1", 555);
    const elsewhere = await pi("t2", 100);
    await sleep(300);
    expect(other.hellos).toBe(0);
    expect(h!.logs.filter((x) => /refused a pi in terminal "t1" \(process 555\)/.test(x))).toHaveLength(1);
    expect(kinds(l.events)).toEqual(["snapshot"]);
    expect(h!.chat.has("t2")).toBe(true); // its own terminal: a chat of its own, not t1's
    expect(elsewhere.connections).toBe(1);
  });

  it("when no new file comes within the wait the chat ends once: unavailable, then the flag goes", async () => {
    const { p, l } = await linked();
    p.goodbye("resume");
    p.unpublish();
    await sleep(FOLLOW - 200);
    expect(kinds(l.events)).toEqual(["snapshot"]);
    await until(() => kinds(l.events).includes("unavailable"), 1500);
    expect(kinds(l.events)).toEqual(["snapshot", "unavailable"]);
    expect(h!.chat.has("t1")).toBe(false);
    await sleep(300);
    expect(kinds(l.events)).toEqual(["snapshot", "unavailable"]);
  });

  it("a crash with no goodbye ends it at once when the file is gone or the process is", async () => {
    await start();
    const p = await pi("t1", 100);
    await until(() => h!.chat.has("t1"));
    const l = listen();
    p.unpublish();
    p.crash();
    await until(() => kinds(l.events).includes("unavailable"), 500);

    const q = await pi("t1", 200);
    await until(() => h!.chat.has("t1"));
    const m = listen();
    alivePids.delete(200);
    q.crash();
    await until(() => kinds(m.events).includes("unavailable"), 500);
  });

  it("a session that said goodbye and is then removed from the terminal's list of pis never comes back from its old file", async () => {
    const { p } = await linked();
    p.goodbye("quit");
    await until(() => !h!.chat.has("t1"));
    await sleep(400);
    expect(p.hellos).toBe(1);
  });
});

describe("a connection that drops (rule 4)", () => {
  it("with the pi and its file still there it is made again with backoff, and subscribers get a reset, never unavailable", async () => {
    await start();
    const p = await pi("t1", 100);
    await until(() => h!.chat.has("t1"));
    const l = listen();
    p.crash();
    await until(() => p.hellos === 2, 2000);
    await until(() => kinds(l.events).length === 2);
    expect(kinds(l.events)).toEqual(["snapshot", "change:reset"]);
    await sleep(FOLLOW + 200);
    expect(kinds(l.events)).toEqual(["snapshot", "change:reset"]);
  });

  it("with a socket that stays down the chat is `unavailable` only once the wait is over, and the way to ask says why until then", async () => {
    await start();
    const p = await pi("t1", 100);
    await until(() => h!.chat.has("t1"));
    const l = listen();
    await p.fake.stop(); // the server goes: no connection can be made again, the file and the pid stay
    await until(() => h!.chat.whyNot("t1") === RECONNECTING, 1000);
    expect(kinds(l.events)).toEqual(["snapshot"]);
    expect(h!.chat.has("t1")).toBe(true);
    await sleep(FOLLOW - 250);
    expect(kinds(l.events)).toEqual(["snapshot"]);
    await until(() => kinds(l.events).includes("unavailable"), 1500);
    expect(kinds(l.events)).toEqual(["snapshot", "unavailable"]);
    expect(h!.chat.has("t1")).toBe(false);
  });

  it("a pi that comes back after the wait is a new chat for the same terminal: a reset to those who still listen", async () => {
    await start();
    const p = await pi("t1", 100);
    await until(() => h!.chat.has("t1"));
    const l = listen();
    p.goodbye("new");
    p.unpublish();
    await until(() => kinds(l.events).includes("unavailable"), 2000);
    await pi("t1", 100);
    await until(() => kinds(l.events).at(-1) === "change:reset", 2000);
    expect(h!.chat.has("t1")).toBe(true);
  });
});

describe("who is alive (rule 4)", () => {
  it("the default check: this process is, a process that has been reaped is not", async () => {
    await start({ alive: undefined });
    const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
    const gone = await pi("t1", dead);
    await sleep(400);
    expect(gone.hellos).toBe(0); // a file left behind by a pi that is gone
    expect(h!.chat.has("t1")).toBe(false);
    const here = await pi("t1", process.pid);
    await until(() => h!.chat.has("t1"));
    expect(here.hellos).toBe(1);
  });
});

describe("what pi-live says it can do (rule 8)", () => {
  const rowsFile = (): string => {
    const file = path.join(tmpDir(), "session.jsonl");
    fs.writeFileSync(file, [sessionHeader, userEntry(null, "a question", "u1"), assistantEntry("u1", [{ type: "text", text: "an answer" }], "a1")].map((l) => JSON.stringify(l) + "\n").join(""));
    return file;
  };

  it("a pi-live with no `chat` feature has its rows, a composer that is off, and the sentence", async () => {
    await start();
    const p = await pi("t1", 100, { file: rowsFile(), config: { features: ["control"], chat: null } });
    await until(() => h!.chat.has("t1"));
    const { events } = listen();
    const e = events[0]!;
    expect(e.type).toBe("snapshot");
    if (e.type !== "snapshot") return;
    expect(e.snapshot.capabilities).toMatchObject({ send: false, stop: false, disabled: "Update pi-ask-user to chat with this pi." });
    expect(e.snapshot.rows.map((r) => r.kind)).toEqual(["user", "assistant"]);
    expect(p.actions).toEqual([]);
  });

  it("a pi with control off has its rows, a composer that is off, and the sentence", async () => {
    await start();
    await pi("t1", 100, { file: rowsFile(), config: { control: false, chat: chatPicture() } });
    await until(() => h!.chat.has("t1"));
    const e = listen().events[0]!;
    if (e.type !== "snapshot") throw new Error("not a snapshot");
    expect(e.snapshot.capabilities).toMatchObject({ send: false, disabled: "Control is off for this pi." });
    expect(e.snapshot.rows).toHaveLength(2);
  });

  it("with chat and control there is no sentence", async () => {
    await start();
    await pi("t1");
    await until(() => h!.chat.has("t1"));
    const e = listen().events[0]!;
    if (e.type !== "snapshot") throw new Error("not a snapshot");
    expect(e.snapshot.capabilities).not.toHaveProperty("disabled");
  });
});
