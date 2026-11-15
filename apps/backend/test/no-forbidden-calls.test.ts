import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));

describe("what the bridge may ask of core", () => {
  it("never names doc.set, machine.exec, file.*, server.* or machine add and remove", () => {
    const forbidden = /["'`](doc\.set|machine\.(exec|add|remove|rm)|file\.[a-z]+|server\.[a-z]+)["'`]/;
    for (const file of [...sources(path.join(here, "../src")), ...sources(path.join(here, "../../../packages/core-client/src"))]) {
      expect(readFileSync(file, "utf8").match(forbidden)?.[0], file).toBeUndefined();
    }
  });
});
