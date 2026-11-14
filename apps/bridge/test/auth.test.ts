import { describe, expect, it } from "vitest";
import { Auth, COOKIE_MAX_AGE_MS, LoginLimiter, readCookie, sessionCookie } from "../src/auth.js";

describe("Auth", () => {
  it("accepts only the passphrase", () => {
    const auth = new Auth("open sesame");
    expect(auth.checkPassphrase("open sesame")).toBe(true);
    expect(auth.checkPassphrase("open sesame ")).toBe(false);
    expect(auth.checkPassphrase("")).toBe(false);
  });

  it("a token is good for 30 days and no longer", () => {
    let now = 1_000_000;
    const auth = new Auth("p", () => now);
    const token = auth.issueToken();
    expect(auth.verifyToken(token)).toBe(true);
    now += COOKIE_MAX_AGE_MS - 1;
    expect(auth.verifyToken(token)).toBe(true);
    now += 2;
    expect(auth.verifyToken(token)).toBe(false);
  });

  it("another passphrase does not accept a token (a changed passphrase signs everyone out)", () => {
    const token = new Auth("old").issueToken();
    expect(new Auth("old").verifyToken(token)).toBe(true); // a restart keeps cookies
    expect(new Auth("new").verifyToken(token)).toBe(false);
  });

  it.each([undefined, "", "x", ".", "1.", ".abc", "999999999999999.bad", "abc.def", "1.2.3"])("rejects the token %j", (token) => {
    expect(new Auth("p").verifyToken(token)).toBe(false);
  });

  it("rejects a token whose expiry was edited", () => {
    const auth = new Auth("p");
    const [exp, sig] = auth.issueToken().split(".");
    expect(auth.verifyToken(`${Number(exp) + 1}.${sig}`)).toBe(false);
  });
});

describe("cookies", () => {
  it("reads one cookie out of several", () => {
    expect(readCookie("a=1; herdr_web_session=tok; b=2", "herdr_web_session")).toBe("tok");
    expect(readCookie("a=1", "herdr_web_session")).toBeUndefined();
    expect(readCookie(undefined, "x")).toBeUndefined();
  });

  it("sets HttpOnly, SameSite=Lax, 30 days; Secure only when asked", () => {
    const plain = sessionCookie("tok", false);
    expect(plain).toContain("herdr_web_session=tok");
    expect(plain).toContain("HttpOnly");
    expect(plain).toContain("SameSite=Lax");
    expect(plain).toContain(`Max-Age=${30 * 24 * 3600}`);
    expect(plain).not.toContain("Secure");
    expect(sessionCookie("tok", true)).toContain("Secure");
  });

  it("clears with Max-Age=0", () => {
    expect(sessionCookie(null, false)).toMatch(/herdr_web_session=;.*Max-Age=0/);
  });
});

describe("LoginLimiter", () => {
  it("lets five wrong passphrases through, then waits 1 s, 2 s, 4 s ...", () => {
    let now = 0;
    const limiter = new LoginLimiter(() => now);
    for (let i = 0; i < 4; i++) {
      limiter.failure();
      expect(limiter.waitMs()).toBe(0);
    }
    limiter.failure(); // the fifth
    expect(limiter.waitMs()).toBe(1000);
    now += 1000;
    expect(limiter.waitMs()).toBe(0);
    limiter.failure();
    expect(limiter.waitMs()).toBe(2000);
    now += 2000;
    limiter.failure();
    expect(limiter.waitMs()).toBe(4000);
  });

  it("caps the wait", () => {
    let now = 0;
    const limiter = new LoginLimiter(() => now, { maxDelayMs: 10_000 });
    for (let i = 0; i < 30; i++) {
      limiter.failure();
      now += limiter.waitMs();
    }
    expect(limiter.waitMs()).toBe(0);
    limiter.failure();
    expect(limiter.waitMs()).toBe(10_000);
  });

  it("a success clears it, and old failures are forgotten", () => {
    let now = 0;
    const limiter = new LoginLimiter(() => now, { forgetAfterMs: 60_000 });
    for (let i = 0; i < 5; i++) limiter.failure();
    expect(limiter.waitMs()).toBeGreaterThan(0);
    limiter.success();
    expect(limiter.waitMs()).toBe(0);
    for (let i = 0; i < 5; i++) limiter.failure();
    now += 61_000;
    expect(limiter.waitMs()).toBe(0);
    limiter.failure(); // counted from zero again
    expect(limiter.waitMs()).toBe(0);
  });
});
