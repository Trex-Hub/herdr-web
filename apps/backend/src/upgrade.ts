import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { parseTerminalSocketPath } from "@herdr-web/protocol";
import { sessionCookie, type Auth } from "./auth.js";
import { MAIN_SOCKET_PATH, type MainSocket } from "./main-socket.js";
import type { TerminalSocket } from "./terminal-socket.js";

function refuse(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** A fresh session cookie for a request, as every authenticated use renews it. */
export function renewedCookie(auth: Auth, req: IncomingMessage): string {
  const secure = req.headers["x-forwarded-proto"] === "https" && isLoopback(req.socket.remoteAddress);
  return sessionCookie(auth.issueToken(), secure);
}

export interface UpgradeOptions {
  auth: Auth;
  origins: readonly string[];
  main: MainSocket;
  terminal: TerminalSocket;
}

/**
 * The one place every WebSocket upgrade is judged: a known path, an allowed Origin and a
 * valid cookie, in that order. Only then is it handed to the main or the terminal socket.
 */
export function routeUpgrades(server: Server, opts: UpgradeOptions): void {
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => {});
    const path = new URL(req.url ?? "/", "http://bridge").pathname;
    const isMain = path === MAIN_SOCKET_PATH;
    const address = parseTerminalSocketPath(path);
    if (!isMain && address === null) return refuse(socket, 404, "Not Found");
    // Browsers always send Origin on a WebSocket upgrade; a missing one is not an allowed one.
    if (!req.headers.origin || !opts.origins.includes(req.headers.origin)) return refuse(socket, 403, "Forbidden");
    if (!opts.auth.isSignedIn(req)) return refuse(socket, 401, "Unauthorized");
    if (isMain) opts.main.handleUpgrade(req, socket, head);
    else opts.terminal.handleUpgrade(req, socket, head, address!);
  });
}
