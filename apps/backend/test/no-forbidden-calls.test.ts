import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));
const files = () => [...sources(path.join(here, "../src")), ...sources(path.join(here, "../../../packages/core-client/src"))];

/**
 * Every core method the bridge may name, and why. Anything else (doc.set, machine.exec, file.*,
 * server.*, machine add and remove, ...) fails this test until it is added here on purpose.
 */
const ALLOWED: Record<string, string> = {
  hello: "the handshake",
  "events.subscribe": "read",
  "machine.list": "read",
  "doc.get": "read",
  "terminal.list": "read",
  "terminal.attach": "a terminal view",
  "templates.list": "read",
  "terminal.run": "write: start (DEV-24)",
  "terminal.kill": "write: kill (DEV-24)",
  "terminal.label": "write: seen and pinned (DEV-24)",
  "terminal.send": "write: types a `/command` into pi's terminal (DEV-25)",
};

describe("what the bridge may ask of core", () => {
  it("never names doc.set, machine.exec, file.*, server.* or machine add and remove", () => {
    const forbidden = /["'`](doc\.set|machine\.(exec|add|remove|rm)|file\.[a-z]+|server\.[a-z]+)["'`]/;
    for (const file of files()) {
      expect(readFileSync(file, "utf8").match(forbidden)?.[0], file).toBeUndefined();
    }
  });

  it("names only the core methods on the allowed list", () => {
    const named = /["'`]((?:events|machine|doc|terminal|templates|file|server|session|app)\.[a-z_]+)["'`]/g;
    const seen = new Set<string>();
    for (const file of files()) for (const m of readFileSync(file, "utf8").matchAll(named)) seen.add(m[1]!);
    seen.delete("terminal.removed"); // a message of the browser protocol, not a core method
    seen.delete("app.shared"); // likewise
    expect([...seen].filter((m) => !(m in ALLOWED))).toEqual([]);
  });

  it("types into a terminal in exactly one place: the chat operations", () => {
    const using = files().filter((f) => /["'`]terminal\.send["'`]/.test(readFileSync(f, "utf8")));
    expect(using.map((f) => path.basename(f)).sort()).toEqual(["chat-operations.ts", "types.ts"]);
  });
});

describe("what a test may start", () => {
  it("every test file that starts the backend as a process or builds a ChatHub gives it an explicit /tmp folder to watch", () => {
    const tests = sources(here).filter((f) => !f.endsWith("no-forbidden-calls.test.ts") && !f.endsWith("helpers.ts"));
    for (const file of tests) {
      const text = readFileSync(file, "utf8");
      if (/dist["',/ ]*index\.js|dist\/index\.js/.test(text)) expect(text, `${file} starts the backend`).toMatch(/assertLiveDirUnderTmp|PI_LIVE_DIR/);
      // Left to its default the bridge would read herdr-app's real shared.json under ~/.config.
      if (/dist["',/ ]*index\.js|dist\/index\.js/.test(text)) expect(text, `${file} starts the backend`).toContain("HW_HERDR_APP_SHARED");
      expect(text, `${file} builds a ChatHub on a folder that is not under /tmp`).not.toMatch(/new ChatHub\(\{[^}]*liveDir: (piLiveDir\(|process\.env|os\.homedir)/);
    }
  });
});
