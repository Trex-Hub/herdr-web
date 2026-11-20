// DEV-33, tester's tests: how apps and people really save shared.json, and that the reader leaves the folder as it found it.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppShared } from "@herdr-web/protocol";
import { AppSharedFile } from "../src/app-shared.js";
import { until } from "./helpers.js";

const dirs: string[] = [];
const tmp = (): string => {
  const d = fs.mkdtempSync("/tmp/hw-ast-");
  dirs.push(d);
  return d;
};
const doc = (label: string, extra: Record<string, unknown> = {}) => ({ "agents.agentLabel": { t1: label }, layout: "x", ...extra });
const put = (file: string, v: unknown) => fs.writeFileSync(file, typeof v === "string" ? v : JSON.stringify(v));
const label = (f: AppSharedFile): string | undefined => f.current()?.["agents.agentLabel"]["t1"];

const open: AppSharedFile[] = [];
afterEach(() => {
  for (const f of open.splice(0)) f.stop();
});
function start(file: string, pollMs = 250): AppSharedFile {
  const f = new AppSharedFile({ path: file, debounceMs: 20, retryMs: 30, pollMs });
  f.start();
  open.push(f);
  return f;
}

describe("the way apps save", () => {
  it("replaced by rename: written to a temporary name in the same folder, then moved over it", async () => {
    const file = path.join(tmp(), "shared.json");
    put(file, doc("one"));
    const f = start(file);
    expect(label(f)).toBe("one");
    for (const n of ["two", "three"]) {
      put(file + ".tmp", doc(n));
      fs.renameSync(file + ".tmp", file);
      await until(() => label(f) === n, 3000);
    }
  });

  it("deleted and created again at once: the new contents, and nothing is lost between", async () => {
    const file = path.join(tmp(), "shared.json");
    put(file, doc("one"));
    const f = start(file);
    const seen: Array<AppShared | null> = [];
    f.onChange((s) => seen.push(s));
    fs.rmSync(file);
    put(file, doc("two"));
    await until(() => label(f) === "two", 3000);
    await new Promise((r) => setTimeout(r, 300));
    expect(label(f)).toBe("two");
    expect(seen.at(-1)?.["agents.agentLabel"]["t1"]).toBe("two");
  });

  it("deleted for a while: null, then back with its contents", async () => {
    const file = path.join(tmp(), "shared.json");
    put(file, doc("one"));
    const f = start(file);
    fs.rmSync(file);
    await until(() => f.current() === null, 3000);
    put(file, doc("back"));
    await until(() => label(f) === "back", 3000);
  });

  it("truncated to nothing before the new bytes arrive: the last good copy meanwhile, then the new one", async () => {
    const file = path.join(tmp(), "shared.json");
    put(file, doc("one"));
    const f = start(file);
    const seen: Array<AppShared | null> = [];
    f.onChange((s) => seen.push(s));
    const fd = fs.openSync(file, "w"); // an editor's open(O_TRUNC): the file is empty from here
    await new Promise((r) => setTimeout(r, 120));
    expect(label(f)).toBe("one");
    const text = JSON.stringify(doc("two"));
    fs.writeSync(fd, text.slice(0, 10)); // half a document
    await new Promise((r) => setTimeout(r, 120));
    expect(label(f)).toBe("one");
    fs.writeSync(fd, text.slice(10));
    fs.closeSync(fd);
    await until(() => label(f) === "two", 3000);
    expect(seen.every((s) => s !== null)).toBe(true); // never told "no file" on the way
  });

  it("a flood of rewrites ends on the last one, and listeners see no torn state", async () => {
    const file = path.join(tmp(), "shared.json");
    put(file, doc("0"));
    const f = start(file);
    const seen: string[] = [];
    f.onChange((s) => seen.push(s?.["agents.agentLabel"]["t1"] ?? "null"));
    for (let i = 1; i <= 60; i++) put(file, doc(String(i)));
    await until(() => label(f) === "60", 3000);
    expect(seen.every((s) => /^\d+$/.test(s))).toBe(true);
    expect(seen.length).toBeLessThan(60); // the debounce folds bursts
  });

  it("a file that is a symlink: a change of its target is seen (the folder watch cannot see it, the poll does)", async () => {
    const dir = tmp();
    const target = path.join(dir, "dotfiles-shared.json");
    const file = path.join(dir, "shared.json");
    put(target, doc("one"));
    fs.symlinkSync(target, file);
    const f = start(file, 200);
    expect(label(f)).toBe("one");
    put(target, doc("two"));
    await until(() => label(f) === "two", 3000);
  });

  it("a file that cannot be read for now keeps the last good copy", async () => {
    const file = path.join(tmp(), "shared.json");
    put(file, doc("one"));
    const f = start(file);
    fs.chmodSync(file, 0o000);
    await new Promise((r) => setTimeout(r, 500));
    expect(label(f)).toBe("one");
    fs.chmodSync(file, 0o644);
    put(file, doc("two"));
    await until(() => label(f) === "two", 3000);
  });

  it("a big file with much besides what we use is read and cut down to the six keys", async () => {
    const file = path.join(tmp(), "shared.json");
    const filler = Object.fromEntries(Array.from({ length: 20000 }, (_, i) => [`k${i}`, { a: "x".repeat(50) }]));
    put(file, { ...doc("one"), ...filler, secret: "token" });
    const f = start(file);
    expect(label(f)).toBe("one");
    expect(Object.keys(f.current()!).sort()).toEqual(["agents.agentGroup", "agents.agentLabel", "agents.groupLabel", "agents.groups", "agents.spaceGroup", "space.colors"]);
    expect(JSON.stringify(f.current())).not.toContain("token");
  });
});

describe("it leaves the folder as it found it", () => {
  it("through reads, rewrites by others, deletion and stop: no file of ours appears beside it, and what is there is only what the writer put", async () => {
    const dir = tmp();
    const file = path.join(dir, "shared.json");
    put(file, doc("one"));
    const f = start(file);
    put(file, doc("two"));
    await until(() => label(f) === "two", 3000);
    const before = fs.readFileSync(file);
    const mtime = fs.statSync(file).mtimeMs;
    await new Promise((r) => setTimeout(r, 600)); // a few polls
    f.stop();
    expect(fs.readdirSync(dir)).toEqual(["shared.json"]);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
  });

  it("with no folder at all it does not create one", async () => {
    const dir = path.join(tmp(), "not-there", "deeper");
    const f = start(path.join(dir, "shared.json"));
    await new Promise((r) => setTimeout(r, 300));
    f.stop();
    expect(fs.existsSync(path.dirname(dir))).toBe(false);
  });
});
