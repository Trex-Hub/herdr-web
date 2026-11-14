import { describe, expect, it } from "vitest";
import { endpointCandidates, resolveEndpoint } from "../src/endpoint.js";

describe("endpoint", () => {
  it("HC_SOCKET wins and is the only candidate", () => {
    expect(endpointCandidates({ env: { HC_SOCKET: "/x/y.sock", XDG_RUNTIME_DIR: "/run/u" } })).toEqual(["/x/y.sock"]);
  });

  it("lists runtime dir, /run/user/<uid>, then state dir, for the session", () => {
    expect(
      endpointCandidates({ env: { HC_SESSION: "s", XDG_RUNTIME_DIR: "/rt" }, uid: 1000, home: "/home/d" }),
    ).toEqual(["/rt/herdr-core/s.sock", "/run/user/1000/herdr-core/s.sock", "/home/d/.local/state/herdr-core/s/s.sock"]);
  });

  it("defaults the session to `default` and skips an unset runtime dir", () => {
    expect(endpointCandidates({ env: {}, uid: 5, home: "/h" })).toEqual([
      "/run/user/5/herdr-core/default.sock",
      "/h/.local/state/herdr-core/default/default.sock",
    ]);
  });

  it("honours XDG_STATE_HOME for the state dir fallback", () => {
    expect(endpointCandidates({ env: { HC_SESSION: "s", XDG_STATE_HOME: "/st" }, uid: 5, home: "/h" }).at(-1)).toBe(
      "/st/herdr-core/s/s.sock",
    );
  });

  it("resolves to the first socket that exists, else the state dir", () => {
    const env = { HC_SESSION: "s", XDG_RUNTIME_DIR: "/rt" };
    const base = { env, uid: 1, home: "/h" };
    expect(resolveEndpoint({ ...base, exists: (p) => p.startsWith("/run/user") })).toBe("/run/user/1/herdr-core/s.sock");
    expect(resolveEndpoint({ ...base, exists: () => false })).toBe("/h/.local/state/herdr-core/s/s.sock");
  });
});
