import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppSharedSchema, type AppShared } from "@herdr-web/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { AppSharedFile, sanitizeShared } from "../src/app-shared.js";
import { loadConfig } from "../src/config.js";
import { ORIGIN, openSocket, startHarness, until, type Harness } from "./helpers.js";

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync("/tmp/hw-as-");
  dirs.push(d);
  return d;
}

/** The shape of herdr-app's file: the six keys we use, and others we must not pass on. */
const REAL = {
  layout: "main-gruvbox",
  "sidebar.width": 233,
  "agents.groups": [{ id: "g1", name: "ayra-oauth" }, { id: "g2", name: "herdr-web" }],
  "agents.groupLabel": { "gr-g1": "ayra", "gr-": "freebrawl" },
  "agents.agentGroup": { t20: "g1", t17: "g2" },
  "agents.agentLabel": { t20: "AYR-59", t17: "ui-lead" },
  "agents.spaceGroup": { sp1: "g1" },
  "space.colors": { sp1: "ansi6", "devserver/sp2": "ansi5" },
  "tab-titles.set": { x: "y" },
};

const stopAll: Array<() => void> = [];
afterEach(() => {
  for (const s of stopAll.splice(0)) s();
});

function open(file: string, debounceMs = 20): AppSharedFile {
  const f = new AppSharedFile({ path: file, debounceMs, retryMs: 30, pollMs: 250 });
  f.start();
  stopAll.push(() => f.stop());
  return f;
}
const write = (file: string, value: unknown) => fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
const wait = async (cond: () => boolean) => until(cond, 3000);

describe("sanitizeShared", () => {
  it("keeps exactly the six keys and nothing else of the file", () => {
    const out = sanitizeShared(REAL);
    expect(Object.keys(out).sort()).toEqual(["agents.agentGroup", "agents.agentLabel", "agents.groupLabel", "agents.groups", "agents.spaceGroup", "space.colors"]);
    expect(out["agents.agentLabel"]).toEqual({ t20: "AYR-59", t17: "ui-lead" });
    expect(out["agents.groups"]).toEqual([{ id: "g1", name: "ayra-oauth" }, { id: "g2", name: "herdr-web" }]);
    expect(AppSharedSchema.safeParse(out).success).toBe(true);
  });

  it("drops malformed entries and keeps the good ones", () => {
    const out = sanitizeShared({
      "agents.groups": [{ id: "a", name: "A" }, { id: 3, name: "bad" }, { id: "b" }, "x", null, { id: "c", name: "" }, { id: "a", name: "dup" }],
      "agents.agentLabel": { t1: "ok", t2: 5, t3: null, t4: "", t5: { x: 1 } },
      "agents.agentGroup": ["not", "an", "object"],
      "agents.groupLabel": "nope",
      "space.colors": { sp1: "ansi1", sp2: false },
    });
    expect(out["agents.groups"]).toEqual([{ id: "a", name: "A" }]);
    expect(out["agents.agentLabel"]).toEqual({ t1: "ok" });
    expect(out["agents.agentGroup"]).toEqual({});
    expect(out["agents.groupLabel"]).toEqual({});
    expect(out["agents.spaceGroup"]).toEqual({});
    expect(out["space.colors"]).toEqual({ sp1: "ansi1" });
  });

  it("a key named __proto__ never reaches a prototype", () => {
    const out = sanitizeShared(JSON.parse('{"agents.agentLabel":{"__proto__":"x","t1":"ok"}}') as Record<string, unknown>);
    expect(Object.getPrototypeOf(out["agents.agentLabel"])).toBe(Object.prototype);
    expect(out["agents.agentLabel"]["t1"]).toBe("ok");
    expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
  });
});

describe("AppSharedFile", () => {
  it("reads the file at start", () => {
    const file = path.join(tmp(), "shared.json");
    write(file, REAL);
    expect(open(file).current()?.["agents.agentLabel"]).toEqual({ t20: "AYR-59", t17: "ui-lead" });
  });

  it("a missing file is null, and a file that appears later is picked up", async () => {
    const file = path.join(tmp(), "shared.json");
    const f = open(file);
    expect(f.current()).toBeNull();
    const seen: Array<AppShared | null> = [];
    f.onChange((s) => seen.push(s));
    write(file, REAL);
    await wait(() => seen.length > 0);
    expect(seen[0]?.["space.colors"]).toEqual({ sp1: "ansi6", "devserver/sp2": "ansi5" });
  });

  it("a folder that does not exist yet counts as no file, and is watched once it appears", async () => {
    const root = tmp();
    const file = path.join(root, "later", "shared.json");
    const f = open(file);
    expect(f.current()).toBeNull();
    fs.mkdirSync(path.dirname(file));
    write(file, REAL);
    await wait(() => f.current() !== null);
  });

  it("reads again on change, whether the file is written in place or replaced", async () => {
    const file = path.join(tmp(), "shared.json");
    write(file, REAL);
    const f = open(file);
    write(file, { ...REAL, "agents.agentLabel": { t20: "renamed" } });
    await wait(() => f.current()?.["agents.agentLabel"]["t20"] === "renamed");
    const tmpFile = `${file}.tmp`;
    write(tmpFile, { ...REAL, "agents.agentLabel": { t20: "replaced" } });
    fs.renameSync(tmpFile, file); // an atomic replace, as an app may save it
    await wait(() => f.current()?.["agents.agentLabel"]["t20"] === "replaced");
  });

  it("keeps the last good copy while the file is invalid JSON, a half-written write, or not an object", async () => {
    const file = path.join(tmp(), "shared.json");
    write(file, REAL);
    const f = open(file);
    const seen: Array<AppShared | null> = [];
    f.onChange((s) => seen.push(s));
    for (const bad of ['{"agents.agentLabel": {"t20": "x"', "", "not json", "[1,2]", "null", "42"]) {
      write(file, bad);
      await new Promise((r) => setTimeout(r, 80));
      expect(f.current()?.["agents.agentLabel"]).toEqual({ t20: "AYR-59", t17: "ui-lead" });
    }
    expect(seen).toEqual([]);
    write(file, { ...REAL, "agents.agentLabel": { t20: "good again" } });
    await wait(() => f.current()?.["agents.agentLabel"]["t20"] === "good again");
  });

  it("a deleted file becomes null", async () => {
    const file = path.join(tmp(), "shared.json");
    write(file, REAL);
    const f = open(file);
    fs.rmSync(file);
    await wait(() => f.current() === null);
  });

  it("does not say anything when a rewrite changes nothing we use", async () => {
    const file = path.join(tmp(), "shared.json");
    write(file, REAL);
    const f = open(file);
    const seen: unknown[] = [];
    f.onChange((s) => seen.push(s));
    write(file, { ...REAL, "sidebar.width": 300, layout: "other" });
    await new Promise((r) => setTimeout(r, 120));
    expect(seen).toEqual([]);
  });

  it("never writes the file: its bytes and modification time are the same after reading, rewatching and stopping", async () => {
    const root = tmp();
    const file = path.join(root, "shared.json");
    write(file, REAL);
    const past = new Date("2026-01-02T03:04:05Z");
    fs.utimesSync(file, past, past);
    const before = { bytes: fs.readFileSync(file), stat: fs.statSync(file) };
    const f = new AppSharedFile({ path: file, debounceMs: 10, retryMs: 20 });
    f.start();
    f.onChange(() => {});
    await new Promise((r) => setTimeout(r, 100));
    f.stop();
    const after = { bytes: fs.readFileSync(file), stat: fs.statSync(file) };
    expect(after.bytes.equals(before.bytes)).toBe(true);
    expect(after.stat.mtimeMs).toBe(before.stat.mtimeMs);
    expect(after.stat.ino).toBe(before.stat.ino);
    expect(fs.readdirSync(root)).toEqual(["shared.json"]); // and it made nothing beside it
  });

  it("the source never opens a file for writing (no write call in app-shared.ts)", () => {
    const text = fs.readFileSync(new URL("../src/app-shared.ts", import.meta.url), "utf8");
    expect(text).not.toMatch(/writeFile|appendFile|createWriteStream|rename|unlink|rm\(|rmSync|mkdir|openSync|utimes|copyFile|truncate/);
  });
});

describe("config", () => {
  const ok = { HERDR_WEB_PASSPHRASE: "p" };
  it("reads HW_HERDR_APP_SHARED, else herdr-app's file in the home folder", () => {
    expect(loadConfig({ ...ok, HW_HERDR_APP_SHARED: "/tmp/x/shared.json" }).appSharedPath).toBe("/tmp/x/shared.json");
    expect(loadConfig(ok).appSharedPath).toBe(path.join(os.homedir(), ".config", "herdr-app", "shared.json"));
    expect(loadConfig({ ...ok, HW_HERDR_APP_SHARED: "" }).appSharedPath).toBe(path.join(os.homedir(), ".config", "herdr-app", "shared.json"));
  });
});

describe("on the main socket", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.stop();
    h = undefined;
  });

  it("sends app.shared after the snapshot when there is a file, and again when it changes", async () => {
    const file = path.join(tmp(), "shared.json");
    write(file, REAL);
    const source = open(file);
    h = await startHarness({ appShared: source });
    const c = await openSocket(h, { Origin: ORIGIN, Cookie: await h.cookie() });
    await until(() => c.messages.some((m) => m.type === "app.shared"));
    expect(c.messages.map((m) => m.type).slice(0, 3)).toEqual(["hello", "snapshot", "app.shared"]);
    const first = c.messages.find((m) => m.type === "app.shared");
    expect(first && first.type === "app.shared" && Object.keys(first.shared ?? {}).sort()).toEqual(["agents.agentGroup", "agents.agentLabel", "agents.groupLabel", "agents.groups", "agents.spaceGroup", "space.colors"]);
    write(file, { ...REAL, "agents.agentLabel": { t20: "again" } });
    await until(() => c.messages.filter((m) => m.type === "app.shared").length === 2);
    fs.rmSync(file);
    await until(() => c.messages.filter((m) => m.type === "app.shared").length === 3);
    const last = c.messages.filter((m) => m.type === "app.shared").at(-1);
    expect(last && last.type === "app.shared" && last.shared).toBeNull();
    c.ws.terminate();
  });

  it("says nothing while there is no file", async () => {
    const source = open(path.join(tmp(), "shared.json"));
    h = await startHarness({ appShared: source });
    const c = await openSocket(h, { Origin: ORIGIN, Cookie: await h.cookie() });
    await until(() => c.messages.some((m) => m.type === "snapshot"));
    await new Promise((r) => setTimeout(r, 100));
    expect(c.messages.some((m) => m.type === "app.shared")).toBe(false);
    c.ws.terminate();
  });
});
