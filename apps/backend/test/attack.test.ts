// Tester's cases for DEV-22: sign-in, CORS and the upgrade checks, pushed from the outside.
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Auth, COOKIE_MAX_AGE_MS, COOKIE_NAME } from "../src/auth.js";
import { ORIGIN, PASSPHRASE, startHarness, type Harness } from "./helpers.js";

const DAY = 24 * 60 * 60 * 1000;

let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

/** A fake clock the bridge reads for cookies and for the login slowdown. */
function clock(start = 1_800_000_000_000) {
  const c = { t: start, now: () => c.t, advance: (ms: number) => (c.t += ms) };
  return c;
}

/** Send an upgrade request by hand, so the headers are exactly as given. Resolves with the status code, or "open". */
function rawUpgrade(port: number, headers: string[], path = "/api/ws"): Promise<string> {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: "127.0.0.1", port });
    let buf = "";
    s.on("connect", () => {
      s.write(
        [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", ...headers, "", ""].join("\r\n"),
      );
    });
    s.on("data", (d) => {
      buf += d.toString("latin1");
      const line = buf.split("\r\n")[0] ?? "";
      const m = /^HTTP\/1\.1 (\d{3})/.exec(line);
      if (m) {
        s.destroy();
        resolve(m[1] === "101" ? "open" : m[1]!);
      }
    });
    s.on("close", () => resolve(buf.startsWith("HTTP/1.1") ? "closed" : "no response"));
    s.on("error", () => {});
    setTimeout(() => (s.destroy(), resolve("timeout")), 3000).unref();
  });
}

const cookieHeader = (cookie: string) => `Cookie: ${cookie}`;
async function post(path: string, body: unknown, headers: Record<string, string> = {}, raw = false) {
  return fetch(`${h!.base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: raw ? (body as string) : JSON.stringify(body) });
}
const status = async (cookie: string) => (await (await fetch(`${h!.base}/api/session`, { headers: { Cookie: cookie } })).json()) as { signedIn: boolean };

describe("cookie", () => {
  it("a lengthened expiry, a flipped signature and a cut-off signature are all refused, over HTTP and by the socket", async () => {
    h = await startHarness();
    const good = await h.cookie();
    const [name, value] = [good.split("=")[0]!, good.slice(good.indexOf("=") + 1)];
    const [exp, sig] = value.split(".") as [string, string];
    const forged = [
      `${Number(exp) + DAY}.${sig}`, // longer life, old signature
      `${Number(exp) + 1}.${sig}`,
      `${exp}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`, // last character changed
      `${exp}.${sig.slice(0, -2)}`,
      `${exp}.${sig}x`,
      `${exp}.`,
      `0${exp}.${sig}`, // same number, other spelling
      `${exp} .${sig}`,
      `${exp}.${sig}.${sig}`,
    ];
    expect(await status(`${name}=${value}`)).toEqual({ signedIn: true });
    for (const f of forged) {
      expect(await status(`${name}=${f}`), f).toEqual({ signedIn: false });
      expect(await rawUpgrade(h.port, [`Origin: ${ORIGIN}`, cookieHeader(`${name}=${f}`)]), f).toBe("401");
    }
    expect(await rawUpgrade(h.port, [`Origin: ${ORIGIN}`, cookieHeader(`${name}=${value}`)])).toBe("open");
  });

  it("an expired cookie is refused everywhere; one second before its end it still works", async () => {
    const c = clock();
    h = await startHarness({ now: c.now });
    const cookie = await h.cookie();
    c.advance(COOKIE_MAX_AGE_MS - 1000);
    expect(await status(cookie)).toEqual({ signedIn: true });
    c.advance(1000); // exactly at the expiry
    expect(await status(cookie)).toEqual({ signedIn: false });
    expect((await fetch(`${h.base}/terminals`, { headers: { Cookie: cookie } })).status).toBe(401);
    expect(await rawUpgrade(h.port, [`Origin: ${ORIGIN}`, cookieHeader(cookie)])).toBe("401");
  });

  it("renewal on use keeps a device in: used every 20 days it is still good after 100", async () => {
    const c = clock();
    h = await startHarness({ now: c.now });
    let cookie = await h.cookie();
    for (let i = 0; i < 5; i++) {
      c.advance(20 * DAY);
      const res = await fetch(`${h.base}/api/session`, { headers: { Cookie: cookie } });
      expect(await res.json()).toEqual({ signedIn: true });
      const renewed = res.headers.get("set-cookie")!;
      expect(renewed).toContain("Max-Age=2592000");
      cookie = renewed.split(";")[0]!;
    }
    c.advance(29 * DAY);
    expect(await status(cookie)).toEqual({ signedIn: true });
    c.advance(2 * DAY);
    expect(await status(cookie)).toEqual({ signedIn: false });
  });

  it("a socket upgrade renews the cookie too, with a later expiry than the one presented", async () => {
    const c = clock();
    h = await startHarness({ now: c.now });
    const cookie = await h.cookie();
    const before = Number(cookie.split("=")[1]!.split(".")[0]);
    c.advance(10 * DAY);
    const renewed = await new Promise<string>((resolve) => {
      const s = net.createConnection({ host: "127.0.0.1", port: h!.port });
      let buf = "";
      s.on("connect", () =>
        s.write(
          [`GET /api/ws HTTP/1.1`, `Host: x`, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", `Origin: ${ORIGIN}`, cookieHeader(cookie), "", ""].join("\r\n"),
        ),
      );
      s.on("data", (d) => {
        buf += d.toString();
        const m = /Set-Cookie: ([^\r]+)/i.exec(buf);
        if (m) (s.destroy(), resolve(m[1]!));
      });
    });
    const after = Number(/=(\d+)\./.exec(renewed)![1]);
    expect(after).toBe(before + 10 * DAY);
  });

  it("the cookie of one bridge is no good to another with a different passphrase, and vice versa", async () => {
    const a = new Auth("one passphrase");
    const b = new Auth("one passphrase ");
    expect(b.verifyToken(a.issueToken())).toBe(false);
    expect(a.verifyToken(b.issueToken())).toBe(false);
    expect(a.verifyToken(a.issueToken())).toBe(true);
  });

  it("an empty or wrongly named cookie is nothing; the first of two same-named cookies is the one read", async () => {
    h = await startHarness();
    const good = await h.cookie();
    const value = good.slice(good.indexOf("=") + 1);
    expect(await status(`${COOKIE_NAME}=`)).toEqual({ signedIn: false });
    expect(await status(`x${COOKIE_NAME}=${value}`)).toEqual({ signedIn: false });
    expect(await status(`${COOKIE_NAME}x=${value}`)).toEqual({ signedIn: false });
    expect(await status(`other=1; ${COOKIE_NAME}=${value}; more=2`)).toEqual({ signedIn: true });
    expect(await status(`${COOKIE_NAME}=bad; ${COOKIE_NAME}=${value}`)).toEqual({ signedIn: false });
  });
});

describe("passphrase comparison", () => {
  it("is exact: other length, case, spaces, unicode form and empty never match, and nothing throws", () => {
    const auth = new Auth("Correct Horse é");
    expect(auth.checkPassphrase("Correct Horse é")).toBe(true);
    for (const wrong of ["", "C", "correct horse é", "Correct Horse é ", " Correct Horse é", "Correct Horse e\u0301", "Correct Horse", "x".repeat(100_000), "\u0000"]) {
      expect(auth.checkPassphrase(wrong), JSON.stringify(wrong.slice(0, 20))).toBe(false);
    }
  });
});

describe("login slowdown", () => {
  async function fail(n: number, headers: Record<string, string> = {}) {
    const codes: number[] = [];
    for (let i = 0; i < n; i++) codes.push((await h!.login("wrong", headers)).res.status);
    return codes;
  }

  it("five wrong answers are all 401; the sixth attempt is refused, even with the right passphrase", async () => {
    const c = clock();
    h = await startHarness({ now: c.now });
    expect(await fail(5)).toEqual([401, 401, 401, 401, 401]);
    const right = await h.login();
    expect(right.res.status).toBe(429);
    expect(right.cookie).toBeUndefined();
    expect(right.res.headers.get("retry-after")).toBe("1");
    expect(await right.res.json()).toEqual({ error: "too many attempts", retryAfterSeconds: 1 });
  });

  it("a success before the limit resets the count", async () => {
    const c = clock();
    h = await startHarness({ now: c.now });
    expect(await fail(4)).toEqual([401, 401, 401, 401]);
    expect((await h.login()).res.status).toBe(200);
    expect(await fail(4)).toEqual([401, 401, 401, 401]); // would be 429 from the second one if the count had stayed
    expect((await h.login()).res.status).toBe(200);
  });

  it("the wait grows: 1 s, then 2 s, 4 s; a refused attempt does not lengthen it", async () => {
    const c = clock();
    h = await startHarness({ now: c.now });
    await fail(5);
    for (let i = 0; i < 5; i++) expect((await h.login()).res.status).toBe(429); // hammering during the wait
    c.advance(1000);
    expect((await h.login("wrong")).res.status).toBe(401); // sixth failure: wait 2 s
    c.advance(1999);
    expect((await h.login()).res.status).toBe(429);
    c.advance(1);
    expect((await h.login("wrong")).res.status).toBe(401); // seventh: wait 4 s
    const r = await h.login();
    expect(r.res.status).toBe(429);
    expect(r.res.headers.get("retry-after")).toBe("4");
    c.advance(4000);
    expect((await h.login()).res.status).toBe(200);
  });

  it("the wait is capped at 15 minutes and failures are forgotten after an hour of quiet", async () => {
    const c = clock();
    h = await startHarness({ now: c.now });
    await fail(5);
    for (let i = 0; i < 15; i++) {
      c.advance(16 * 60 * 1000);
      expect((await h.login("wrong")).res.status).toBe(401);
    }
    const r = await h.login();
    expect(r.res.status).toBe(429);
    expect(Number(r.res.headers.get("retry-after"))).toBeLessThanOrEqual(900);
    c.advance(61 * 60 * 1000);
    expect((await h.login()).res.status).toBe(200);
    expect(await fail(5)).toEqual([401, 401, 401, 401, 401]); // a clean slate
  });

  it("while it is slowed down, devices already signed in carry on: session, terminals and the socket", async () => {
    const c = clock();
    h = await startHarness({ now: c.now });
    const cookie = await h.cookie();
    await fail(6);
    expect((await h.login()).res.status).toBe(429);
    expect(await status(cookie)).toEqual({ signedIn: true });
    expect((await fetch(`${h.base}/terminals`, { headers: { Cookie: cookie } })).status).toBe(200);
    expect(await rawUpgrade(h.port, [`Origin: ${ORIGIN}`, cookieHeader(cookie)])).toBe("open");
  });

  it("answers that are not guesses (no body, a number, a list) are 400 and do not count as failures", async () => {
    const c = clock();
    h = await startHarness({ now: c.now });
    for (let i = 0; i < 8; i++) {
      expect((await post("/api/login", "", {}, true)).status).toBe(400);
      expect((await post("/api/login", { passphrase: 5 })).status).toBe(400);
      expect((await post("/api/login", { passphrase: [PASSPHRASE] })).status).toBe(400);
      expect((await post("/api/login", { passphrase: null })).status).toBe(400);
    }
    expect((await h.login()).res.status).toBe(200);
  });

  it("a form post (not JSON) cannot guess a passphrase: 400, no cookie, no count", async () => {
    h = await startHarness();
    for (let i = 0; i < 8; i++) {
      const res = await fetch(`${h.base}/api/login`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `passphrase=${encodeURIComponent(PASSPHRASE)}` });
      expect(res.status).toBe(400);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect((await h.login()).res.status).toBe(200);
  });

  it("a body over 2 kB is a 4xx, not a crash or a 500", async () => {
    h = await startHarness();
    const res = await post("/api/login", JSON.stringify({ passphrase: "x".repeat(10_000) }), {}, true);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect((await h.login()).res.status).toBe(200);
  });
});

describe("login and logout from other origins", () => {
  const foreign = ["http://evil.example", "http://localhost:3000.evil.com", "http://localhost:3000/", "HTTP://LOCALHOST:3000", "https://localhost:3000", "http://localhost:30000", "http://localhost", "null", "*", "http://localhost:3000, http://evil.example"];

  it.each(foreign)("login from Origin %j is 403, sets no cookie, and does not count as a failure", async (origin) => {
    h = await startHarness();
    for (let i = 0; i < 7; i++) {
      const { res, cookie } = await h.login(PASSPHRASE, { Origin: origin });
      expect(res.status).toBe(403);
      expect(cookie).toBeUndefined();
    }
    expect((await h.login(PASSPHRASE, { Origin: ORIGIN })).res.status).toBe(200);
  });

  it.each(foreign)("logout from Origin %j is 403 and leaves the cookie alone", async (origin) => {
    h = await startHarness();
    const cookie = await h.cookie();
    const res = await post("/api/logout", {}, { Origin: origin, Cookie: cookie });
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await status(cookie)).toEqual({ signedIn: true });
  });

  it("logout from the allowed origin clears the cookie (the one in the browser), even though renewal ran first", async () => {
    h = await startHarness();
    const cookie = await h.cookie();
    const res = await post("/api/logout", {}, { Origin: ORIGIN, Cookie: cookie });
    expect(res.status).toBe(200);
    const set = res.headers.getSetCookie();
    expect(set).toHaveLength(1);
    expect(set[0]).toMatch(/^herdr_web_session=;.*Max-Age=0/);
    expect(set[0]).toContain("HttpOnly");
    expect(set[0]).toContain("SameSite=Lax");
  });

  it("logout with no cookie is harmless", async () => {
    h = await startHarness();
    const res = await post("/api/logout", {}, { Origin: ORIGIN });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signedIn: false });
  });
});

describe("CORS", () => {
  const allowed = ["http://localhost:3000", "https://box.tail1234.ts.net"];
  const refused = ["http://localhost:3000/", "HTTP://LOCALHOST:3000", "http://LOCALHOST:3000", "http://localhost:3000.evil.com", "http://localhost:30000", "http://evil.example", "null", "*", "https://localhost:3000"];

  it("credentials are allowed for listed origins only, echoing that origin and never `*`", async () => {
    h = await startHarness({ origins: allowed });
    const cookie = await (await h.login(PASSPHRASE, { Origin: allowed[0]! })).cookie!;
    for (const origin of allowed) {
      for (const [path, headers] of [["/health", {}], ["/api/session", {}], ["/terminals", { Cookie: cookie }]] as const) {
        const res = await fetch(`${h.base}${path}`, { headers: { Origin: origin, ...headers } });
        expect(res.headers.get("access-control-allow-origin"), path).toBe(origin);
        expect(res.headers.get("access-control-allow-credentials")).toBe("true");
        expect(res.headers.get("vary")).toMatch(/Origin/i);
      }
    }
    // an error answer must carry the headers too, or the browser cannot read the 401
    const denied = await fetch(`${h.base}/terminals`, { headers: { Origin: allowed[1]! } });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("access-control-allow-origin")).toBe(allowed[1]);
  });

  it.each(refused)("Origin %j gets no CORS headers on a GET, a POST refusal or a preflight", async (origin) => {
    h = await startHarness({ origins: allowed });
    const cors = (res: Response) => [...res.headers.keys()].filter((k) => k.startsWith("access-control-"));
    const probes: Response[] = [
      await fetch(`${h.base}/health`, { headers: { Origin: origin } }),
      await fetch(`${h.base}/api/session`, { headers: { Origin: origin } }),
      await fetch(`${h.base}/api/login`, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" } }),
      await post("/api/login", { passphrase: PASSPHRASE }, { Origin: origin }),
    ];
    for (const res of probes) expect(cors(res)).toEqual([]);
    expect(probes[3]!.status).toBe(403);
  });

  it("with no Origin header at all there are no CORS headers", async () => {
    h = await startHarness({ origins: allowed });
    const res = await fetch(`${h.base}/api/session`);
    expect([...res.headers.keys()].filter((k) => k.startsWith("access-control-"))).toEqual([]);
  });

  it("a preflight from a listed origin allows POST with JSON and credentials", async () => {
    h = await startHarness({ origins: allowed });
    const res = await fetch(`${h.base}/api/login`, { method: "OPTIONS", headers: { Origin: allowed[1]!, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(allowed[1]);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("access-control-allow-methods")).toMatch(/POST/);
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("content-type");
  });

  it("a cross-origin login from a listed origin works end to end with the cookie it sets", async () => {
    h = await startHarness({ origins: allowed });
    const { res, cookie } = await h.login(PASSPHRASE, { Origin: allowed[1]! });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(allowed[1]);
    expect(await status(cookie!)).toEqual({ signedIn: true });
  });
});

describe("upgrade checks", () => {
  const origins = ["http://localhost:3000/", "HTTP://LOCALHOST:3000", "http://LOCALHOST:3000", "http://localhost:3000.evil.com", "http://localhost:30000", "http://localhost:3000@evil.com", "https://localhost:3000", "http://localhost", "null", "*", "", "http://evil.example", "http://localhost:3000, http://evil.example", "http://localhost:3000 x"];

  it.each(origins)("a valid cookie with Origin %j is refused (403)", async (origin) => {
    h = await startHarness();
    const cookie = await h.cookie();
    expect(await rawUpgrade(h.port, [`Origin: ${origin}`, cookieHeader(cookie)])).toBe("403");
    expect(h.bridge.clientCount()).toBe(0);
  });

  it("two Origin headers are refused, however they are ordered", async () => {
    h = await startHarness();
    const cookie = await h.cookie();
    expect(await rawUpgrade(h.port, [`Origin: ${ORIGIN}`, "Origin: http://evil.example", cookieHeader(cookie)])).toBe("403");
    expect(await rawUpgrade(h.port, ["Origin: http://evil.example", `Origin: ${ORIGIN}`, cookieHeader(cookie)])).toBe("403");
  });

  it("no Origin is refused, with or without a cookie", async () => {
    h = await startHarness();
    expect(await rawUpgrade(h.port, [cookieHeader(await h.cookie())])).toBe("403");
    expect(await rawUpgrade(h.port, [])).toBe("403");
  });

  it("the allowed Origin without a cookie, with an empty one or with another name is 401", async () => {
    h = await startHarness();
    const good = await h.cookie();
    const value = good.slice(good.indexOf("=") + 1);
    for (const headers of [[], [cookieHeader("herdr_web_session=")], [cookieHeader(`session=${value}`)], [cookieHeader("a=b")]]) {
      expect(await rawUpgrade(h.port, [`Origin: ${ORIGIN}`, ...headers])).toBe("401");
    }
  });

  it("a foreign Origin with no cookie is refused too, and neither answer lets a script tell a valid cookie from an invalid one", async () => {
    h = await startHarness();
    expect(await rawUpgrade(h.port, ["Origin: http://evil.example"])).toBe("403");
    expect(await rawUpgrade(h.port, ["Origin: http://evil.example", cookieHeader(await h.cookie())])).toBe("403");
  });

  it("the cookie may sit among others and in a second Cookie header", async () => {
    h = await startHarness();
    const cookie = await h.cookie();
    expect(await rawUpgrade(h.port, [`Origin: ${ORIGIN}`, cookieHeader(`a=1; ${cookie}; b=2`)])).toBe("open");
  });

  it("the path must be exactly /api/ws (a query string is fine)", async () => {
    h = await startHarness();
    const headers = [`Origin: ${ORIGIN}`, cookieHeader(await h.cookie())];
    expect(await rawUpgrade(h.port, headers, "/api/ws?x=1")).toBe("open");
    for (const p of ["/api/ws/", "/api/wsx", "/api/ws/extra", "//api/ws", "/API/WS", "/api/%77s", "/", "/api", "/ws"]) {
      expect(await rawUpgrade(h.port, headers, p), p).toBe("404");
    }
  });

  it("refused upgrades leave nothing behind: no clients, and the bridge still answers", async () => {
    h = await startHarness();
    for (let i = 0; i < 20; i++) await rawUpgrade(h.port, ["Origin: http://evil.example"]);
    expect(h.bridge.clientCount()).toBe(0);
    expect((await fetch(`${h.base}/health`)).status).toBe(200);
  });
});

describe("health", () => {
  it("stays open and says nothing about files or passphrases", async () => {
    h = await startHarness();
    const body = JSON.stringify(await (await fetch(`${h.base}/health`)).json());
    expect(body).not.toContain(PASSPHRASE);
    expect(body).not.toContain(h.core.dir);
  });
});

describe("defects", () => {
  it("/health without a cookie should not tell a stranger the path of core's socket", async () => {
    h = await startHarness({ connectCore: false });
    // core is not there: point the session somewhere that does not exist, and start it
    const missing = `${h.core.dir}/missing.sock`;
    await h.stop();
    const { CoreSession } = await import("@herdr-web/core-client");
    const { createBridge } = await import("../src/server.js");
    const session = new CoreSession({ endpoint: () => missing, backoff: { initialMs: 20, maxMs: 50 } });
    session.start();
    const bridge = createBridge({ session, passphrase: PASSPHRASE, origins: [ORIGIN], buildId: "x" });
    const port = await bridge.listen(0);
    try {
      let body = "";
      for (let i = 0; i < 100 && !body.includes("ENOENT"); i++) {
        body = JSON.stringify(await (await fetch(`http://127.0.0.1:${port}/health`)).json());
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(body).not.toContain(missing);
    } finally {
      await bridge.close();
      await session.stop();
    }
    h = undefined;
  });
});

void COOKIE_MAX_AGE_MS;
