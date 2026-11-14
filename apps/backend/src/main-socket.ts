import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { CoreSession } from "@herdr-web/core-client";
import { encodeMessage, parseClientMessage, type ServerMessage } from "@herdr-web/protocol";
import { WebSocket, WebSocketServer } from "ws";
import type { Auth } from "./auth.js";
import { renewedCookie } from "./upgrade.js";
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
  /** Complete an upgrade that has passed the origin and cookie checks. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  clientCount(): number;
  close(): void;
}

/**
 * The main socket: on connect `hello` then a `snapshot`, after that one small message per
 * change. Nothing is remembered between connections, so there is no resume.
 */
export function createMainSocket(opts: MainSocketOptions): MainSocket {
  const maxBuffered = opts.maxBufferedBytes ?? 4 * 1024 * 1024;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  // Renew the cookie on use, as plain requests do.
  wss.on("headers", (headers, req) => {
    headers.push(`Set-Cookie: ${renewedCookie(opts.auth, req)}`);
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
    handleUpgrade: (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws)),
    clientCount: () => wss.clients.size,
    close: () => {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}

