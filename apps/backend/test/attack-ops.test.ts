import type { Terminal } from "@herdr-web/core-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ORIGIN, startHarness, until, type Harness } from "./helpers.js";

// The operations (POST /api/ops/<name>, GET /api/starters) attacked from outside: input the schemas must
// refuse, requests that are not the browser's own, methods that are not POST, and what happens when core is
// slow or two windows act at once. A refusal must make no core call that changes anything.

const term = (address: string, extra: Partial<Terminal> = {}): Terminal => ({
  address, argv: ["sh"], cols: 80, rows: 24, created_ms: 1, cwd: "/", state: "live", screen: "exact", labels: {}, title: "", turn: 0, ...extra,
});
const space = (id: string, folder: string) => ({ id, name: id, folder, tabs: [] });
const machine = { name: "cachyos", target: "x", id: "i", host: "h", version: "1", state: "connected" };

let h: Harness;
let cookie: string;

/** What changes core or asks it about templates. Reads the session makes by itself are left out. */
const writes = () => h.core.calls.filter((c) => /^(terminal\.(run|kill|label|send)|templates\.list)$/.test(c.method));
const changes = () => h.core.calls.filter((c) => /^terminal\.(run|kill|label|send)$/.test(c.method));

const headers = (extra: Record<string, string> = {}) => ({ Origin: ORIGIN, Cookie: cookie, "Content-Type": "application/json", ...extra });
async function raw(path: string, init: RequestInit) {
  const res = await fetch(`${h.base}${path}`, init);
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body, text, headers: res.headers };
}
const post = (name: string, body: unknown, extra: Record<string, string> = {}) =>
  raw(`/api/ops/${name}`, { method: "POST", headers: headers(extra), body: typeof body === "string" ? body : JSON.stringify(body) });

beforeEach(async () => {
  h = await startHarness({ connectCore: false });
  h.core.machines = [machine];
  h.core.docs.set("", { value: { spaces: [space("sp-local", "/work/local")] }, version: 1 });
  h.core.docs.set("cachyos", { value: { spaces: [space("sp-remote", "/home/dev/remote")] }, version: 1 });
  h.core.terminals = [
    term("t1", { turn: 3, labels: { "herdr.seen": "1" } }),
    term("t2", { turn: 5, labels: { "herdr.seen": "0" } }),
    term("t3", { turn: 0 }),
    term("t4", { state: "finished", reason: "exited", exit_code: 0 }),
    term("cachyos/t9", { turn: 2 }),
  ];
  h.core.rpc.set("terminal.run", (p: { on?: string }) => term(p.on ? "t11" : "t10"));
  h.core.rpc.set("terminal.kill", () => term("t1", { state: "finished", reason: "killed", signal: 1 }));
  h.core.rpc.set("terminal.label", () => term("t1"));
  h.core.rpc.set("terminal.send", () => ({ turn: 1, started: true, status: "idle" }));
  h.core.rpc.set("templates.list", () => ({ templates: [{ name: "reviewer", description: "Reviews a diff", command: "claude" }] }));
  h.session.start();
  await until(() => h.session.state === "connected" && h.session.layouts.list().length === 2 && h.session.store.get("cachyos/t9") !== undefined);
  cookie = await h.cookie();
});
afterEach(async () => {
  await h.stop();
});

describe("input the operations must refuse, with no change made in core", () => {
  const shell = { kind: "shell" };
  const start = (over: Record<string, unknown>) => ({ machine: null, space: "sp-local", what: shell, ...over });
  const bad: Array<[string, string, unknown]> = [
    // start
    ["start", "an empty machine name", start({ machine: "" })],
    ["start", "a machine name of 65 characters", start({ machine: "m".repeat(65) })],
    ["start", "a number as the machine", start({ machine: 7 })],
    ["start", "a machine called __proto__", start({ machine: "__proto__" })],
    ["start", "a machine called constructor", start({ machine: "constructor" })],
    ["start", "an empty space id", start({ space: "" })],
    ["start", "a space id of 201 characters", start({ space: "s".repeat(201) })],
    ["start", "a space called __proto__", start({ space: "__proto__" })],
    ["start", "a space called toString", start({ space: "toString" })],
    ["start", "a space id with a trailing space", start({ space: "sp-local " })],
    ["start", "a space id in other case", start({ space: "SP-LOCAL" })],
    ["start", "an array as the space", start({ space: ["sp-local"] })],
    ["start", "what: Shell in other case", start({ what: { kind: "Shell" } })],
    ["start", "what: an unknown kind", start({ what: { kind: "exec", argv: ["rm", "-rf", "/"] } })],
    ["start", "what: a shell with an argv smuggled in", start({ what: { kind: "shell", argv: ["rm"] } })],
    ["start", "what: pi with an argv smuggled in", start({ what: { kind: "pi", argv: ["rm"] } })],
    ["start", "what: a template with an empty name", start({ what: { kind: "template", name: "" } })],
    ["start", "what: a template name of 65 characters", start({ what: { kind: "template", name: "r".repeat(65) } })],
    ["start", "what: a template with an array as its name", start({ what: { kind: "template", name: ["reviewer"] } })],
    ["start", "what: a template named like a flag", start({ what: { kind: "template", name: "--cwd=/" } })],
    ["start", "what: null", start({ what: null })],
    ["start", "a cwd of the browser's own", start({ cwd: "/etc" })],
    ["start", "labels of the browser's own", start({ labels: { "herdr.space": "x" } })],
    ["start", "keep of the browser's own", start({ keep: false })],
    ["start", "no space at all", { machine: null, what: shell }],
    ["start", "no machine key at all", { space: "sp-local", what: shell }],
    // kill
    ["kill", "an address in other case", { terminal: "T1" }],
    ["kill", "an address with a trailing newline", { terminal: "t1\n" }],
    ["kill", "an address with a leading space", { terminal: " t1" }],
    ["kill", "two addresses", { terminal: "t1,t2" }],
    ["kill", "a path in the address", { terminal: "cachyos/../t1" }],
    ["kill", "an address with a slash at the end", { terminal: "cachyos/" }],
    ["kill", "an address with two slashes", { terminal: "a/b/t1" }],
    ["kill", "an address of 10 digits", { terminal: "t1234567890" }],
    ["kill", "an address that is a number", { terminal: 1 }],
    ["kill", "an array of addresses", { terminal: ["t1", "t2"] }],
    ["kill", "a terminal key and another", { terminal: "t1", all: true }],
    ["kill", "nothing", {}],
    // seen
    ["seen", "a turn that is a string", { terminal: "t1", turn: "2" }],
    ["seen", "a turn of -1", { terminal: "t1", turn: -1 }],
    ["seen", "a turn of 1.5", { terminal: "t1", turn: 1.5 }],
    ["seen", "a turn of 1e999 (infinity)", `{"terminal":"t1","turn":1e999}`],
    ["seen", "a turn of 2**53", { terminal: "t1", turn: 2 ** 53 }],
    ["seen", "a turn of true", { terminal: "t1", turn: true }],
    ["seen", "a turn of null", { terminal: "t1", turn: null }],
    ["seen", "no turn", { terminal: "t1" }],
    // unread, pin
    ["unread", "an extra key", { terminal: "t1", turn: 0 }],
    ["pin", "pinned as a string", { terminal: "t1", pinned: "true" }],
    ["pin", "pinned as 1", { terminal: "t1", pinned: 1 }],
    ["pin", "pinned as null", { terminal: "t1", pinned: null }],
    ["pin", "a label of the browser's own", { terminal: "t1", pinned: true, label: "herdr.seen" }],
  ];
  for (const [name, what, body] of bad) {
    it(`${name}: ${what}`, async () => {
      const r = await post(name, body);
      expect(r.status, r.text).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
      expect(typeof r.body?.error, r.text).toBe("string");
      expect(changes()).toEqual([]);
    });
  }

  it("a body that is not an object: null, an array, a number, a string, nothing, broken JSON", async () => {
    for (const text of ["null", "[]", "[1]", "7", `"t1"`, "", "{", `{"terminal":"t1"`, "\u0000"]) {
      for (const name of ["start", "kill", "seen", "unread", "pin"]) {
        const r = await post(name, text);
        expect(r.status, `${name} ${JSON.stringify(text)}: ${r.text}`).toBe(400);
      }
    }
    expect(changes()).toEqual([]);
  });

  it("a body that is not sent as JSON is not read, whatever it says (a form post from another page cannot make one)", async () => {
    const body = JSON.stringify({ terminal: "t1" });
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/json-ish", ""]) {
      const r = await raw("/api/ops/kill", { method: "POST", headers: { Origin: ORIGIN, Cookie: cookie, ...(type ? { "Content-Type": type } : {}) }, body });
      expect(r.status, type).toBe(400);
    }
    expect(changes()).toEqual([]);
  });

  it("a body over 4 kB is refused before it is read into anything", async () => {
    const r = await post("kill", { terminal: "t1", pad: "x".repeat(5000) });
    expect(r.status).toBe(413);
    expect(changes()).toEqual([]);
  });

  it("a duplicate key takes the last value, which is still checked (no way to slip a second terminal past the schema)", async () => {
    const r = await post("kill", `{"terminal":"t1","terminal":"t1; x"}`);
    expect(r.status).toBe(400);
    expect(changes()).toEqual([]);
  });

  it("an __proto__ key in the body does not change what the operation sees", async () => {
    const r = await post("pin", `{"terminal":"t1","pinned":true,"__proto__":{"terminal":"t2"}}`);
    // strict objects refuse the extra key; either way t2 must not be touched
    expect(changes().every((c) => (c.params as { terminal: string }).terminal !== "t2")).toBe(true);
    expect([200, 400]).toContain(r.status);
  });
});

describe("a request that is not the page's own", () => {
  const bodies: Record<string, unknown> = {
    start: { machine: null, space: "sp-local", what: { kind: "shell" } },
    kill: { terminal: "t1" },
    seen: { terminal: "t1", turn: 2 },
    unread: { terminal: "t1" },
    pin: { terminal: "t1", pinned: true },
  };

  it("every origin that is not listed is refused, however it is written", async () => {
    const origins = ["null", "http://localhost:3000.evil.com", "http://localhost:3000/", "HTTP://LOCALHOST:3000", "http://localhost:3001", "https://localhost:3000", "http://127.0.0.1:3000", "*", "http://localhost:3000 http://evil.example"];
    for (const origin of origins) {
      for (const [name, body] of Object.entries(bodies)) {
        const r = await post(name, body, { Origin: origin });
        expect(r.status, `${name} from ${JSON.stringify(origin)}`).toBe(403);
      }
    }
    expect(changes()).toEqual([]);
  });

  it("no cookie, a forged cookie, a cookie of another build's key, and an empty cookie are all 401, for every operation and for the starters", async () => {
    const cookies = ["", "herdr_web_session=", "herdr_web_session=abc", "herdr_web_session=" + cookie.split("=")[1]!.split(".")[0] + ".AAAA", cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A"))];
    for (const c of cookies) {
      for (const [name, body] of Object.entries(bodies)) {
        const r = await post(name, body, { Cookie: c });
        expect(r.status, `${name} with cookie ${JSON.stringify(c).slice(0, 40)}`).toBe(401);
      }
      expect((await raw("/api/starters", { headers: { Origin: ORIGIN, Cookie: c } })).status).toBe(401);
    }
    expect(changes()).toEqual([]);
    expect(h.core.calls.some((c) => c.method === "templates.list")).toBe(false);
  });

  it("a cookie with no Origin at all (not a browser) is accepted: the cookie is the proof, and it is not a CSRF hole because browsers always send one", async () => {
    const res = await fetch(`${h.base}/api/ops/pin`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(bodies["pin"]) });
    expect(res.status).toBe(200);
  });

  it("only POST does anything: GET, PUT, DELETE, PATCH and HEAD on an operation change nothing", async () => {
    for (const method of ["GET", "PUT", "DELETE", "PATCH", "HEAD"]) {
      for (const name of Object.keys(bodies)) {
        const res = await fetch(`${h.base}/api/ops/${name}`, { method, headers: headers(), ...(method === "GET" || method === "HEAD" ? {} : { body: JSON.stringify(bodies[name]) }) });
        expect(res.status, `${method} ${name}`).toBe(404);
      }
    }
    expect(changes()).toEqual([]);
  });

  it("an unknown operation, a deeper path, an encoded slash and the names of Object.prototype are 404 and run nothing", async () => {
    for (const path of ["format-disk", "start/x", "start%2Fkill", "__proto__", "constructor", "toString", "hasOwnProperty", "%73tart ", "START", ".."]) {
      const r = await raw(`/api/ops/${path}`, { method: "POST", headers: headers(), body: JSON.stringify(bodies["kill"]) });
      expect([404, 400], `/api/ops/${path} gave ${r.status} ${r.text}`).toContain(r.status);
      expect(r.status === 200).toBe(false);
    }
    expect(changes()).toEqual([]);
  });

  it("a preflight from a foreign origin gets no permission; from the page's own origin it names POST and credentials", async () => {
    const foreign = await fetch(`${h.base}/api/ops/kill`, { method: "OPTIONS", headers: { Origin: "http://evil.example", "Access-Control-Request-Method": "POST" } });
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
    expect(foreign.headers.get("access-control-allow-credentials")).toBeNull();
    const own = await fetch(`${h.base}/api/ops/kill`, { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" } });
    expect(own.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(own.headers.get("access-control-allow-credentials")).toBe("true");
    expect(own.headers.get("access-control-allow-methods") ?? "").toMatch(/POST/);
    expect(own.headers.get("access-control-allow-methods") ?? "").not.toMatch(/DELETE|PUT|PATCH/);
    expect(changes()).toEqual([]);
  });

  it("a refused answer to a foreign origin carries no permission for the page to read it", async () => {
    const r = await post("kill", bodies["kill"], { Origin: "http://evil.example" });
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("what the operations tell the page when things go wrong", () => {
  it("an error from core is passed on with its hint, and a core error never shows as a 500 or a stack", async () => {
    h.core.rpc.set("terminal.kill", () => ({ error: { message: "terminal t1 is busy", kind: "invalid" } }));
    const r = await post("kill", { terminal: "t1" });
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ error: "terminal t1 is busy" });
    expect(r.text).not.toMatch(/\bat \w+.*\.ts|node_modules|Error:/);
  });

  it("a result of core that has no fields the bridge expects does not crash the bridge (kill, run)", async () => {
    h.core.rpc.set("terminal.kill", () => ({}));
    h.core.rpc.set("terminal.run", () => ({}));
    const k = await post("kill", { terminal: "t1" });
    expect(k.status, k.text).toBeLessThan(600);
    const s = await post("start", { machine: null, space: "sp-local", what: { kind: "shell" } });
    expect(s.status, s.text).toBeLessThan(600);
    // the bridge still answers
    expect((await raw("/health", {})).status).toBe(200);
  });

  it("start on a machine that has since become unreachable is refused, and runs nothing", async () => {
    h.core.machines = [{ ...machine, state: "unreachable" }];
    await until(() => h.session.layouts.get("cachyos")?.status !== "ok", 3000);
    const r = await post("start", { machine: "cachyos", space: "sp-remote", what: { kind: "shell" } });
    expect(r.status, r.text).toBeGreaterThanOrEqual(400);
    expect(String(r.body.error)).toMatch(/cannot be read|unreachable|not connected/i);
    expect(changes()).toEqual([]);
  });

  it("a terminal that has finished is refused for seen, unread, pin and kill, whatever turn it ended at", async () => {
    for (const [name, body] of [["seen", { terminal: "t4", turn: 0 }], ["unread", { terminal: "t4" }], ["pin", { terminal: "t4", pinned: true }], ["kill", { terminal: "t4" }]] as const) {
      expect((await post(name, body)).status, name).toBe(409);
    }
    expect(changes()).toEqual([]);
  });

  it("the starters answer with core's own message when core cannot list templates, not a hang or a crash", async () => {
    h.core.rpc.set("templates.list", () => ({ error: { message: "templates are not available", kind: "invalid" } }));
    const res = await raw("/api/starters", { headers: headers() });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "templates are not available" });
  });

  it("a template that core lists with an error is not offered, and one with a name that looks like a flag is passed as a name, never as an option", async () => {
    h.core.rpc.set("templates.list", () => ({ templates: [{ name: "--help", description: "x", command: "y" }, { name: "ok", description: "x", command: "y", error: "broken" }] }));
    const list = await raw("/api/starters", { headers: headers() });
    expect(list.body.starters.map((s: { name: string }) => s.name)).toEqual(["Shell", "pi", "--help"]);
    const r = await post("start", { machine: null, space: "sp-local", what: { kind: "template", name: "--help" } });
    expect(r.status).toBe(200);
    const run = h.core.calls.find((c) => c.method === "terminal.run")!.params as { argv: string[] };
    // argv is a list handed to core as it is: the name is its first element, which core reads as a template or a program, not as hc's own option
    expect(run.argv).toEqual(["--help"]);
  });

  it("an operation does not wait for ever on a core that has stopped answering (it ends with a sentence the page can show)", async () => {
    h.core.muted = true;
    const answered = await Promise.race([
      post("pin", { terminal: "t1", pinned: true }).then((r) => r.status),
      new Promise<string>((resolve) => setTimeout(() => resolve("still waiting after 12 s"), 12_000)),
    ]);
    expect(answered).not.toBe("still waiting after 12 s");
  }, 20_000);
});

describe("two windows acting at once", () => {
  it("two starts at once make two terminals with two tab ids", async () => {
    const [a, b] = await Promise.all([post("start", { machine: null, space: "sp-local", what: { kind: "shell" } }), post("start", { machine: null, space: "sp-local", what: { kind: "shell" } })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const tabs = h.core.calls.filter((c) => c.method === "terminal.run").map((c) => (c.params as { labels: Record<string, string> }).labels["herdr.tab"]);
    expect(new Set(tabs).size).toBe(2);
  });

  it("a hundred kills of one terminal at once: the bridge answers every one and stays up", async () => {
    const all = await Promise.all(Array.from({ length: 100 }, () => post("kill", { terminal: "t3" })));
    for (const r of all) expect([200, 409, 502]).toContain(r.status);
    expect((await raw("/health", {})).status).toBe(200);
  });

  it("mark seen from two windows: the later request never lowers a label that the earlier one raised, even before core's event has come back", async () => {
    // t2 is at turn 5, seen 0. Window A is up to date and marks 5; window B's page is a moment behind and marks 3. Both reach
    // the bridge before core has said anything, so the bridge's own copy still shows 0 for both.
    const [a, b] = await Promise.all([post("seen", { terminal: "t2", turn: 5 }), post("seen", { terminal: "t2", turn: 3 })]);
    expect([a.status, b.status]).toContain(200);
    const written = h.core.calls.filter((c) => c.method === "terminal.label").map((c) => Number((c.params as { labels: Record<string, string> }).labels["herdr.seen"]));
    // what core holds at the end is the last value written: it must be the highest
    expect(written[written.length - 1], `written in order: ${written.join(", ")}`).toBe(Math.max(...written));
  });
});

