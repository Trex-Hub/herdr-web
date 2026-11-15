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
  /** The agents socket, when the harness was started with `agents`. */
  agentsSocket: string | null;
  chat: ChatHub;
  /** Lines the chat hub logged. */
  logs: string[];
  /** POST /api/login; returns the response and the cookie pair (`name=value`), if one was set. */
  login(passphrase?: string, headers?: Record<string, string>): Promise<{ res: Response; cookie: string | undefined }>;
  /** Sign in and return the cookie header value. */
  cookie(): Promise<string>;
  stop(): Promise<void>;
}

export async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

export async function startHarness(opts: Partial<BridgeOptions> & { connectCore?: boolean; agents?: boolean | Partial<ChatHubOptions> } = {}): Promise<Harness> {
  const core = new FakeCore();
  await core.listen();
  const session = new CoreSession({ endpoint: () => core.path, backoff: { initialMs: 20, maxMs: 100 }, machinePollMs: 100 });
  const { connectCore = true, agents = false, ...rest } = opts;
  const logs: string[] = [];
  // A unix socket path is limited to about 100 bytes, so not os.tmpdir() on macOS.
  const agentsSocket = agents ? path.join(fs.mkdtempSync("/tmp/hw-bk-"), "agents.sock") : null;
  const chat = new ChatHub({ session, socketPath: agentsSocket, log: (l) => logs.push(l), ...(typeof agents === "object" ? agents : {}) });
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
    agentsSocket,
    chat,
    logs,
    login,
    cookie: async () => (await login()).cookie!,
    stop: async () => {
      await bridge.close();
      await session.stop();
      await core.dispose();
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
