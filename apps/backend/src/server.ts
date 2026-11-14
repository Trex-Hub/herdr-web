import http from "node:http";
import type { AddressInfo } from "node:net";
import type { CoreSession } from "@herdr-web/core-client";
import { Auth, LoginLimiter, type LimiterOptions } from "./auth.js";
import { createApp } from "./app.js";
import { attachMainSocket } from "./main-socket.js";

export interface BridgeOptions {
  session: CoreSession;
  passphrase: string;
  origins: readonly string[];
  buildId: string;
  maxBufferedBytes?: number;
  now?: () => number;
  limiter?: LimiterOptions;
}

export interface Bridge {
  server: http.Server;
  /** Listen on loopback; resolves with the port actually bound. */
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
  clientCount(): number;
}

export function createBridge(opts: BridgeOptions): Bridge {
  const now = opts.now ?? Date.now;
  const auth = new Auth(opts.passphrase, now);
  const limiter = new LoginLimiter(now, opts.limiter);
  const server = http.createServer(createApp({ session: opts.session, auth, limiter, origins: opts.origins }));
  const sockets = attachMainSocket(server, {
    session: opts.session,
    auth,
    origins: opts.origins,
    buildId: opts.buildId,
    ...(opts.maxBufferedBytes !== undefined && { maxBufferedBytes: opts.maxBufferedBytes }),
  });
  return {
    server,
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
        sockets.close();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
    clientCount: () => sockets.clientCount(),
  };
}
