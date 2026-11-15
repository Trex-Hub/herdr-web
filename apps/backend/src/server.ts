import http from "node:http";
import type { AddressInfo } from "node:net";
import type { CoreSession } from "@herdr-web/core-client";
import { Auth, LoginLimiter, type LimiterOptions } from "./auth.js";
import { createApp } from "./app.js";
import { ChatHub } from "./chat.js";
import { createMainSocket } from "./main-socket.js";
import { createTerminalSocket, type TerminalSocketOptions } from "./terminal-socket.js";
import { routeUpgrades } from "./upgrade.js";

export interface BridgeOptions {
  session: CoreSession;
  passphrase: string;
  origins: readonly string[];
  buildId: string;
  /** Owns the agents socket. Without one the bridge has no chat. */
  chat?: ChatHub;
  maxBufferedBytes?: number;
  terminal?: Omit<TerminalSocketOptions, "session" | "auth">;
  now?: () => number;
  limiter?: LimiterOptions;
}

export interface Bridge {
  server: http.Server;
  chat: ChatHub;
  /** Listen on loopback; resolves with the port actually bound. */
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
  clientCount(): number;
  /** Open terminal views. */
  terminalCount(): number;
}

export function createBridge(opts: BridgeOptions): Bridge {
  const now = opts.now ?? Date.now;
  const auth = new Auth(opts.passphrase, now);
  const limiter = new LoginLimiter(now, opts.limiter);
  const chat = opts.chat ?? new ChatHub({ session: opts.session, socketPath: null });
  const server = http.createServer(createApp({ session: opts.session, auth, limiter, origins: opts.origins, chat }));
  const main = createMainSocket({
    session: opts.session,
    auth,
    origins: opts.origins,
    buildId: opts.buildId,
    chat,
    ...(opts.maxBufferedBytes !== undefined && { maxBufferedBytes: opts.maxBufferedBytes }),
  });
  const terminal = createTerminalSocket({ session: opts.session, auth, ...opts.terminal });
  routeUpgrades(server, { auth, origins: opts.origins, main, terminal });
  return {
    server,
    chat,
    listen: (port, host = "127.0.0.1") =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve((server.address() as AddressInfo).port);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        main.close();
        terminal.close();
        void chat.stop();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
    clientCount: () => main.clientCount(),
    terminalCount: () => terminal.clientCount(),
  };
}
