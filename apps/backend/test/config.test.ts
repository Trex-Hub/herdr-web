import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const ok = { HERDR_WEB_PASSPHRASE: "p" };
const problems = (env: NodeJS.ProcessEnv): string[] => {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  return [];
};

describe("loadConfig", () => {
  it("defaults to port 7420 and http://localhost:3000", () => {
    expect(loadConfig(ok)).toMatchObject({ port: 7420, passphrase: "p", origins: ["http://localhost:3000"] });
  });

  it("refuses to start without a passphrase, set or empty", () => {
    expect(problems({})[0]).toContain("HERDR_WEB_PASSPHRASE");
    expect(problems({ HERDR_WEB_PASSPHRASE: "" })[0]).toContain("HERDR_WEB_PASSPHRASE");
  });

  it("reports every problem at once", () => {
    expect(problems({ PORT: "abc" })).toHaveLength(2);
  });

  it("reads a comma-separated origin list, tolerating spaces and trailing slashes", () => {
    expect(loadConfig({ ...ok, HERDR_WEB_ORIGINS: "http://localhost:3000, https://box.tail1234.ts.net/ ,," }).origins).toEqual([
      "http://localhost:3000",
      "https://box.tail1234.ts.net",
    ]);
  });

  it("an empty origin list counts as unset", () => {
    expect(loadConfig({ ...ok, HERDR_WEB_ORIGINS: "" }).origins).toEqual(["http://localhost:3000"]);
  });

  it.each(["localhost:3000", "http://localhost:3000/app", "*", "null", "not a url"])("rejects the origin %j", (o) => {
    expect(problems({ ...ok, HERDR_WEB_ORIGINS: o })[0]).toContain("HERDR_WEB_ORIGINS");
  });

  it.each(["abc", "0", "70000", "-1", "1.5"])("rejects PORT=%s; an empty PORT is unset", (port) => {
    expect(problems({ ...ok, PORT: port })[0]).toContain("invalid PORT");
    expect(loadConfig({ ...ok, PORT: "" }).port).toBe(7420);
    expect(loadConfig({ ...ok, PORT: "8000" }).port).toBe(8000);
  });

  it("takes the build id from HERDR_WEB_BUILD_ID", () => {
    expect(loadConfig({ ...ok, HERDR_WEB_BUILD_ID: "abc" }).buildId).toBe("abc");
    expect(loadConfig(ok).buildId).toMatch(/\S/);
  });
});
