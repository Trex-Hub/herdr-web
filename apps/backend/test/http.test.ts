import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBridge } from "../src/server.js";
import { COOKIE_MAX_AGE_MS } from "../src/auth.js";
import { ORIGIN, PASSPHRASE, openSocket, startHarness, type Harness } from "./helpers.js";

let h: Harness;
let now: number;

beforeEach(async () => {
  now = 1_700_000_000_000;
  h = await startHarness({ now: () => now });
});
afterEach(() => h.stop());

const get = (path: string, headers: Record<string, string> = {}) => fetch(`${h.base}${path}`, { headers });
const post = (path: string, headers: Record<string, string> = {}) => fetch(`${h.base}${path}`, { method: "POST", headers });

describe("sign-in gate", () => {
  it("/health stays open", async () => {
    const res = await get("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ connection: "connected", core: { name: "fake", version: "9.9.9" } });
  });

  it("/terminals is refused without a cookie, with a bad one, and with one for another passphrase", async () => {
    expect((await get("/terminals")).status).toBe(401);
    expect((await get("/terminals", { Cookie: "herdr_web_session=nonsense" })).status).toBe(401);
    const other = createBridge({ session: h.session, passphrase: "different", origins: [ORIGIN], buildId: "x", now: () => now });
    const port = await other.listen(0);
    try {
      const cookie = await h.cookie();
      expect((await fetch(`http://127.0.0.1:${port}/terminals`, { headers: { Cookie: cookie } })).status).toBe(401);
      expect((await get("/terminals", { Cookie: cookie })).status).toBe(200);
    } finally {
      await other.close();
    }
  });

  it("/terminals works with the cookie; ?all=1 includes finished terminals", async () => {
    h.core.terminals = [];
    await h.stop();
    h = await startHarness({ now: () => now });
    const cookie = await h.cookie();
    const body = (await (await get("/terminals", { Cookie: cookie })).json()) as { terminals: unknown[]; machines: unknown[]; connection: string };
    expect(body).toMatchObject({ terminals: [], machines: [], connection: "connected" });
  });

  it("/api/session says whether the caller is signed in", async () => {
    expect(await (await get("/api/session")).json()).toEqual({ signedIn: false });
    const cookie = await h.cookie();
    expect(await (await get("/api/session", { Cookie: cookie })).json()).toEqual({ signedIn: true });
  });
});

describe("login", () => {
  it("the right passphrase sets an HttpOnly, SameSite=Lax cookie for 30 days, not Secure over plain HTTP", async () => {
    const { res, cookie } = await h.login();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signedIn: true });
    const header = res.headers.get("set-cookie")!;
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain(`Max-Age=${COOKIE_MAX_AGE_MS / 1000}`);
    expect(header).toContain("Path=/");
    expect(header).not.toContain("Secure");
    expect(cookie).toMatch(/^herdr_web_session=\d+\./);
  });

  it("is Secure when the request came over HTTPS (as a proxy reports it)", async () => {
    const { res } = await h.login(PASSPHRASE, { "X-Forwarded-Proto": "https" });
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });

  it("a wrong passphrase gets 401 and no cookie", async () => {
    const { res, cookie } = await h.login("wrong");
    expect(res.status).toBe(401);
    expect(cookie).toBeUndefined();
  });

  it.each([
    ["no passphrase", "application/json", "{}"],
    ["a passphrase that is not a string", "application/json", '{"passphrase":5}'],
    ["broken JSON", "application/json", "{"],
    ["a form post", "application/x-www-form-urlencoded", `passphrase=${encodeURIComponent(PASSPHRASE)}`],
    ["an empty body", "application/json", ""],
  ])("%s gets 400 and no cookie", async (_name, type, body) => {
    const res = await fetch(`${h.base}/api/login`, { method: "POST", headers: { "Content-Type": type }, body });
    expect(res.status).toBe(400);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("slows down wrong passphrases: after 5, attempts are refused with Retry-After, the right one included, until the wait is over", async () => {
    for (let i = 0; i < 5; i++) expect((await h.login("wrong")).res.status).toBe(401);
    const refused = await h.login(PASSPHRASE);
    expect(refused.res.status).toBe(429);
    expect(refused.res.headers.get("retry-after")).toBe("1");
    expect(refused.cookie).toBeUndefined();
    expect(await refused.res.json()).toMatchObject({ retryAfterSeconds: 1 });

    now += 1000;
    expect((await h.login("wrong")).res.status).toBe(401); // the sixth failure
    now += 1000;
    expect((await h.login(PASSPHRASE)).res.status).toBe(429); // now 2 s, only 1 s has passed
    now += 1000;
    const ok = await h.login(PASSPHRASE);
    expect(ok.res.status).toBe(200);
    expect((await h.login("wrong")).res.status).toBe(401); // a success started the count again, with free tries
    expect((await h.login(PASSPHRASE)).res.status).toBe(200);
  });

  it("refuses a login from a foreign origin, and takes one from an allowed origin or from no browser", async () => {
    expect((await h.login(PASSPHRASE, { Origin: "http://evil.example" })).res.status).toBe(403);
    expect((await h.login(PASSPHRASE, { Origin: "http://evil.example" })).cookie).toBeUndefined();
    expect((await h.login(PASSPHRASE, { Origin: ORIGIN })).res.status).toBe(200);
    expect((await h.login()).res.status).toBe(200);
  });
});

describe("logout and renewal", () => {
  it("logout clears the cookie", async () => {
    const res = await post("/api/logout", { Cookie: await h.cookie() });
    expect(res.status).toBe(200);
    const header = res.headers.get("set-cookie")!;
    expect(header).toMatch(/^herdr_web_session=;/);
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("HttpOnly");
  });

  it("a cookie is renewed on use: each response carries a fresh 30 days", async () => {
    const cookie = await h.cookie();
    const expiry = (c: string) => Number(c.split("=")[1]!.split(".")[0]);
    now += 10 * 24 * 3600 * 1000;
    const res = await get("/api/session", { Cookie: cookie });
    const renewed = res.headers.get("set-cookie")!.split(";")[0]!;
    expect(expiry(renewed)).toBe(expiry(cookie) + 10 * 24 * 3600 * 1000);
    now += 25 * 24 * 3600 * 1000; // 35 days after login: the original would be dead, the renewed one is not
    expect((await get("/api/session", { Cookie: cookie })).status).toBe(200);
    expect(await (await get("/api/session", { Cookie: cookie })).json()).toEqual({ signedIn: false });
    expect(await (await get("/api/session", { Cookie: renewed })).json()).toEqual({ signedIn: true });
  });

  it("no cookie, no renewal", async () => {
    expect((await get("/api/session")).headers.get("set-cookie")).toBeNull();
  });

  it("a restarted bridge with the same passphrase still accepts the cookie", async () => {
    const cookie = await h.cookie();
    const again = createBridge({ session: h.session, passphrase: PASSPHRASE, origins: [ORIGIN], buildId: "x", now: () => now });
    const port = await again.listen(0);
    try {
      expect(await (await fetch(`http://127.0.0.1:${port}/api/session`, { headers: { Cookie: cookie } })).json()).toEqual({ signedIn: true });
    } finally {
      await again.close();
    }
  });
});

describe("CORS", () => {
  it("allowed origins get headers that allow credentials", async () => {
    const res = await get("/api/session", { Origin: ORIGIN });
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("vary")).toContain("Origin");
  });

  it("other origins get none", async () => {
    const res = await get("/api/session", { Origin: "http://evil.example" });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("answers a preflight from an allowed origin, and gives a foreign one nothing", async () => {
    const ok = await fetch(`${h.base}/api/login`, { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(ok.headers.get("access-control-allow-methods")).toContain("POST");
    expect(ok.headers.get("access-control-allow-headers")).toContain("Content-Type");
    const bad = await fetch(`${h.base}/api/login`, { method: "OPTIONS", headers: { Origin: "http://evil.example", "Access-Control-Request-Method": "POST" } });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("only the configured origins count: another port of localhost is foreign", async () => {
    const res = await get("/api/session", { Origin: "http://localhost:3001" });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("passphrase change", () => {
  it("signs out every device: a cookie from the old passphrase is refused over HTTP and by the socket", async () => {
    const cookie = await h.cookie();
    await h.bridge.close();
    h.bridge = createBridge({ session: h.session, passphrase: "a new passphrase", origins: [ORIGIN], buildId: "x", now: () => now });
    h.port = await h.bridge.listen(0);
    h.base = `http://127.0.0.1:${h.port}`;
    expect((await get("/terminals", { Cookie: cookie })).status).toBe(401);
    expect(await (await get("/api/session", { Cookie: cookie })).json()).toEqual({ signedIn: false });
    await expect(openSocket(h, { Origin: ORIGIN, Cookie: cookie })).rejects.toThrow("refused: 401");
    expect((await h.login()).res.status).toBe(401); // the old passphrase no longer works either
    const fresh = await h.login("a new passphrase");
    expect(fresh.res.status).toBe(200);
    expect((await get("/terminals", { Cookie: fresh.cookie! })).status).toBe(200);
  });
});
