// Tester's cases for DEV-21: the bridge as a real process (built dist), against a stand-in core.
// HC_SOCKET always points into a temp dir, so no real or scratch core is ever touched.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { RawCore } from "../../../packages/core-client/test/raw-core.js";

const PASSPHRASE = "test passphrase";
const bridgeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(bridgeDir, "dist", "index.js");

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

async function until(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface Running {
  child: ChildProcess;
  out: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

let running: Running[] = [];
let core: RawCore | undefined;

function run(env: Record<string, string>): Running {
  const child = spawn(process.execPath, [entry], {
    env: { PATH: process.env["PATH"] ?? "", HERDR_WEB_PASSPHRASE: PASSPHRASE, HC_SOCKET: path.join(core?.dir ?? "/nonexistent", "none.sock"), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buf = "";
  child.stdout.on("data", (d: Buffer) => (buf += d.toString()));
  child.stderr.on("data", (d: Buffer) => (buf += d.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.on("exit", (code, signal) => r({ code, signal })));
  const r = { child, out: () => buf, exited };
  running.push(r);
  return r;
}

const cookies = new Map<number, string>();

/** Sign in once per port (`/terminals` needs the cookie) and send it with every request. */
async function get(port: number, p: string): Promise<{ status: number; body: any }> {
  if (p !== "/health" && !cookies.has(port)) {
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passphrase: PASSPHRASE }),
    });
    cookies.set(port, (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "");
  }
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { Cookie: cookies.get(port) ?? "" } });
  return { status: res.status, body: await res.json() };
}

beforeAll(() => {
  // `pnpm test` builds dependencies, not this package: build it here so the test runs what `start` runs.
  execFileSync(process.execPath, [path.join(bridgeDir, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"], { cwd: bridgeDir });
}, 60_000);

afterEach(async () => {
  for (const r of running) {
    r.child.kill("SIGKILL");
    await r.exited;
  }
  running = [];
  await core?.dispose();
  core = undefined;
});

describe("bridge process", () => {
  it("listens on 127.0.0.1 only: not on a LAN address, not on ::1", async () => {
    const port = await freePort();
    const b = run({ PORT: String(port) });
    await until(() => b.out().includes("bridge listening"));
    expect(b.out()).toContain(`http://127.0.0.1:${port}`);
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
    const tryConnect = (host: string) =>
      new Promise<string>((resolve) => {
        const s = net.createConnection({ host, port, timeout: 1000 });
        s.on("connect", () => (s.destroy(), resolve("connected")));
        s.on("timeout", () => (s.destroy(), resolve("timeout")));
        s.on("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
      });
    expect(await tryConnect("127.0.0.1")).toBe("connected");
    expect(await tryConnect("::1")).not.toBe("connected");
    if (lan) expect(await tryConnect(lan)).not.toBe("connected");
  });

  it("serves /health and /terminals while core is absent, saying it is reconnecting", async () => {
    const port = await freePort();
    run({ PORT: String(port) });
    await until(async () => (await fetch(`http://127.0.0.1:${port}/health`).catch(() => null))?.ok === true);
    const health = await get(port, "/health");
    expect(health.body).toMatchObject({ core: null, seq: null });
    await until(async () => (await get(port, "/health")).body.connection === "reconnecting");
    const terminals = await get(port, "/terminals");
    expect(terminals.status).toBe(200);
    expect(terminals.body).toMatchObject({ terminals: [], machines: [], seq: null, hidden_finished: 0 });
  });

  it("follows a core: lists its terminals, applies an event, survives core stopping and returning", async () => {
    core = new RawCore();
    core.seq = 7;
    core.terminals = [{ address: "t1", argv: ["sh"], cols: 80, rows: 24, created_ms: 1, cwd: "/", state: "live", screen: "exact", labels: {} }];
    await core.listen();
    const port = await freePort();
    run({ PORT: String(port), HC_SOCKET: core.path });
    await until(async () => (await get(port, "/health").catch(() => ({ body: {} as any }))).body.connection === "connected");
    expect((await get(port, "/health")).body).toMatchObject({ core: { name: "raw", version: "9.9.9" }, seq: 7 });
    expect((await get(port, "/terminals")).body.terminals.map((t: { address: string }) => t.address)).toEqual(["t1"]);

    core.last.event(8, "labels", "t1", { labels: { a: "b" } });
    await until(async () => (await get(port, "/terminals")).body.terminals[0].labels.a === "b");
    expect((await get(port, "/health")).body.seq).toBe(8);

    await core.stop();
    await until(async () => (await get(port, "/health")).body.connection === "reconnecting");
    core.seq = 1;
    core.terminals = [];
    await core.listen();
    await until(async () => (await get(port, "/health")).body.connection === "connected", 8000);
    expect((await get(port, "/terminals")).body).toMatchObject({ terminals: [], seq: 1 });
  });

  it("exits 0 on SIGTERM and on SIGINT", async () => {
    for (const sig of ["SIGTERM", "SIGINT"] as const) {
      const b = run({ PORT: String(await freePort()) });
      await until(() => b.out().includes("bridge listening"));
      b.child.kill(sig);
      const t0 = Date.now();
      expect((await b.exited).code).toBe(0);
      expect(Date.now() - t0).toBeLessThan(2000);
    }
  });

  it.each(["abc", "70000", "-1", "1.5"])("refuses PORT=%s and exits 1", async (value) => {
    const b = run({ PORT: value });
    expect((await b.exited).code).toBe(1);
    expect(b.out()).toContain("invalid PORT");
  });

  it("exits 1 with a message when the port is taken", async () => {
    const busy = net.createServer();
    await new Promise<void>((r) => busy.listen(0, "127.0.0.1", r));
    const port = (busy.address() as net.AddressInfo).port;
    try {
      const b = run({ PORT: String(port) });
      expect((await b.exited).code).toBe(1);
      expect(b.out()).toMatch(/EADDRINUSE/);
    } finally {
      busy.close();
    }
  });
});

describe("defects", () => {
  it("an empty PORT should not bind a random port (:0)", async () => {
    const b = run({ PORT: "" });
    await Promise.race([until(() => b.out().includes("bridge listening")), b.exited]);
    expect(b.out()).not.toContain("127.0.0.1:0");
  });

  it("stop on SIGTERM should be quick even when core never answers hello", async () => {
    core = new RawCore();
    core.silentHello = true;
    await core.listen();
    const b = run({ PORT: String(await freePort()), HC_SOCKET: core.path });
    await until(() => core!.connections.length === 1);
    const t0 = Date.now();
    b.child.kill("SIGTERM");
    await b.exited;
    expect(Date.now() - t0).toBeLessThan(1000);
  }, 15_000);
});
