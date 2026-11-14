import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { CoreSession } from "@herdr-web/core-client";
import { encodeMessage, parseClientMessage, type ServerMessage } from "@herdr-web/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { sessionCookie, type Auth } from "./auth.js";
import { changeMessage, helloMessage, snapshotMessage } from "./messages.js";

export const MAIN_SOCKET_PATH = "/api/ws";

export interface MainSocketOptions {
  session: CoreSession;
  auth: Auth;
  origins: readonly string[];
  buildId: string;
  /** A browser with more than this queued unsent is closed; it reconnects and gets a fresh snapshot. */
  maxBufferedBytes?: number;
}

export interface MainSocket {
  clientCount(): number;
  close(): void;
}

function refuse(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * The main socket: on connect `hello` then a `snapshot`, after that one small message per
 * change. Nothing is remembered between connections, so there is no resume.
 */
export function attachMainSocket(server: Server, opts: MainSocketOptions): MainSocket {
  const maxBuffered = opts.maxBufferedBytes ?? 4 * 1024 * 1024;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => {});
    const path = new URL(req.url ?? "/", "http://bridge").pathname;
    if (path !== MAIN_SOCKET_PATH) return refuse(socket, 404, "Not Found");
    // Browsers always send Origin on a WebSocket upgrade; a missing one is not an allowed one.
    if (!req.headers.origin || !opts.origins.includes(req.headers.origin)) return refuse(socket, 403, "Forbidden");
    if (!opts.auth.isSignedIn(req)) return refuse(socket, 401, "Unauthorized");
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  });

  // Renew the cookie on use, as plain requests do.
  wss.on("headers", (headers, req) => {
    const secure = req.headers["x-forwarded-proto"] === "https" && isLoopback(req.socket.remoteAddress);
    headers.push(`Set-Cookie: ${sessionCookie(opts.auth.issueToken(), secure)}`);
  });

  function onConnection(ws: WebSocket): void {
    let open = true;
    const stop = () => {
      open = false;
      unsubscribe();
    };

    const send = (message: ServerMessage, checked: boolean): void => {
      if (!open || ws.readyState !== WebSocket.OPEN) return;
      const text = encodeMessage(message);
      if (checked && ws.bufferedAmount + text.length > maxBuffered) {
        stop();
        ws.close(1013, "too slow"); // try again later
        setTimeout(() => ws.terminate(), 1000).unref(); // the peer may never answer the close
        return;
      }
      ws.send(text, (err) => {
        if (err) ws.terminate();
      });
    };

    // Subscribe and build the snapshot in one go, so no change falls between them.
    const unsubscribe = opts.session.subscribe((change) => send(changeMessage(change), true));
    send(helloMessage(opts.buildId), false);
    send(snapshotMessage(opts.session), false);

    ws.on("message", (data, isBinary) => {
      if (isBinary) return ws.close(1003, "text messages only");
      const parsed = parseClientMessage(data.toString());
      if (!parsed.ok) return ws.close(1008, "invalid message");
      send({ type: "pong" }, true);
    });
    ws.on("close", stop);
    ws.on("error", () => {
      stop();
      ws.terminate();
    });
  }

  return {
    clientCount: () => wss.clients.size,
    close: () => {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
