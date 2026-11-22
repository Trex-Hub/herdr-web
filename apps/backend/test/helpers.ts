import { CoreSession } from "@herdr-web/core-client";
import { parseServerMessage, type ServerMessage } from "@herdr-web/protocol";
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";
import { ChatHub, type ChatHubOptions } from "../src/chat.js";
import { createBridge, type Bridge, type BridgeOptions } from "../src/server.js";
import { FakeCore } from "../../../packages/core-client/test/fake-core.js";

export const PASSPHRASE = "correct horse";
export const ORIGIN = "http://localhost:3000";

export interface Harness {
  core: FakeCore;
  session: CoreSession;
  bridge: Bridge;
  port: number;
  base: string;
  /** The pi-live folder the hub watches, when the harness was started with `live`. */
  liveDir: string | null;
  chat: ChatHub;
  /** Lines the chat hub logged. */
  logs: string[];
  /** POST /api/login; returns the response and the cookie pair (`name=value`), if one was set. */
  login(passphrase?: string, headers?: Record<string, string>): Promise<{ res: Response; cookie: string | undefined }>;
  /** Sign in and return the cookie header value. */
  cookie(): Promise<string>;
  stop(): Promise<void>;
}

/**
 * A folder for a bridge to watch for pi-live's session files, under /tmp. Every bridge a test starts, in this process or as a child,
 * gets one: left to its default the bridge would watch ~/.pi/agent/live, where Devendra's own pis accept control.
 */
export function liveDirIn(prefix = "hw-bk-"): string {
  return fs.mkdtempSync(`/tmp/${prefix}`);
}

/** Throws unless the folder a bridge would watch is under /tmp: call it with the environment a child bridge gets. */
export function assertLiveDirUnderTmp(env: Record<string, string | undefined>): void {
  const p = env["PI_LIVE_DIR"];
  if (!p || !(p.startsWith("/tmp/") || p.startsWith("/private/tmp/"))) {
    throw new Error(`a test would start a bridge on the default pi-live folder (PI_LIVE_DIR=${String(p)}): that is ~/.pi/agent/live, where real pis accept control. Pass liveDirIn().`);
  }
}

export async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

export async function startHarness(opts: Partial<BridgeOptions> & { connectCore?: boolean; live?: boolean | Partial<ChatHubOptions>; callTimeoutMs?: number } = {}): Promise<Harness> {
  const core = new FakeCore();
  await core.listen();
  const session = new CoreSession({ endpoint: () => core.path, backoff: { initialMs: 20, maxMs: 100 }, machinePollMs: 100, ...(opts.callTimeoutMs !== undefined && { callTimeoutMs: opts.callTimeoutMs }) });
  const { connectCore = true, live = false, callTimeoutMs: _callTimeoutMs, ...rest } = opts;
  const logs: string[] = [];
  const liveDir = live ? liveDirIn() : null;
  // the pids in the session files of a test are made up: only the tests of the pid rule look at who is really there
  const chat = new ChatHub({ session, liveDir, alive: () => true, rescanMs: 100, log: (l) => logs.push(l), ...(typeof live === "object" ? live : {}) });
  await chat.start();
  const bridge = createBridge({ session, passphrase: PASSPHRASE, origins: [ORIGIN], buildId: "test-build", chat, ...rest });
  const port = await bridge.listen(0);
  const base = `http://127.0.0.1:${port}`;
  if (connectCore) {
    session.start();
    await until(() => session.state === "connected");
  }
  const login: Harness["login"] = async (passphrase = PASSPHRASE, headers = {}) => {
    const res = await fetch(`${harness.base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ passphrase }),
    });
    return { res, cookie: res.headers.get("set-cookie")?.split(";")[0] };
  };
  const harness: Harness = {
    core,
    session,
    bridge,
    port,
    base,
    liveDir,
    chat,
    logs,
    login,
    cookie: async () => (await login()).cookie!,
    stop: async () => {
      await bridge.close();
      await session.stop();
      await core.dispose();
      if (liveDir) {
        // only what this harness made: the session files left, then the folder (rmdir fails on a non-empty one)
        for (const name of fs.readdirSync(liveDir)) {
          if (!name.endsWith(".json") && !name.endsWith(".tmp")) continue;
          const file = path.join(liveDir, name);
          if (fs.lstatSync(file).isDirectory()) fs.rmdirSync(file);
          else fs.unlinkSync(file);
        }
        fs.rmdirSync(liveDir);
      }
    },
  };
  return harness;
}

export interface Client {
  ws: WebSocket;
  /** Every message received so far, parsed and validated against the protocol. */
  messages: ServerMessage[];
  /** Raw close info once closed. */
  closed: { code: number; reason: string } | undefined;
  send(text: string | Buffer): void;
  close(): void;
}

/** Open the main socket. Resolves once open; rejects with the HTTP status when the upgrade is refused. */
export function openSocket(h: Pick<Harness, "port">, headers: Record<string, string>, path = "/api/ws"): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}${path}`, { headers });
    const client: Client = { ws, messages: [], closed: undefined, send: (t) => ws.send(t), close: () => ws.close() };
    ws.on("message", (data) => {
      const parsed = parseServerMessage(data.toString());
      if (!parsed.ok) throw new Error(`bridge sent an invalid message: ${parsed.error}: ${data.toString()}`);
      client.messages.push(parsed.message);
    });
    ws.on("close", (code, reason) => (client.closed = { code, reason: reason.toString() }));
    ws.on("open", () => resolve(client));
    ws.on("unexpected-response", (_req, res) => reject(new Error(`refused: ${res.statusCode}`)));
    ws.on("error", () => {});
  });
}

export const types = (c: Client): string[] => c.messages.map((m) => m.type);
