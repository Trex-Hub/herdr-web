import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { CoreSession } from "@herdr-web/core-client";
import { encodeMessage, MAX_CHAT_SUBSCRIPTIONS, parseClientMessage, type ServerMessage } from "@herdr-web/protocol";
import { WebSocket, WebSocketServer } from "ws";
import type { AppSharedSource } from "./app-shared.js";
import type { Auth } from "./auth.js";
import { renewedCookie } from "./upgrade.js";
import { NOT_RUNNING, type ChatEvent, type ChatHub } from "./chat.js";
import { changeMessage, helloMessage, snapshotMessage, toWireTerminal } from "./messages.js";

export const MAIN_SOCKET_PATH = "/api/ws";

export interface MainSocketOptions {
  session: CoreSession;
  auth: Auth;
  origins: readonly string[];
  buildId: string;
  chat: ChatHub;
  /** herdr-app's names and groups, read-only; without one every browser is told there are none. */
  appShared?: AppSharedSource;
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
    const chats = new Map<string, () => void>();
    const stop = () => {
      open = false;
      unsubscribe();
      offAvailability();
      offShared();
      for (const leave of chats.values()) leave();
      chats.clear();
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
    const hasChat = (address: string) => opts.chat.has(address);
    const unsubscribe = opts.session.subscribe((change) => send(changeMessage(change, hasChat), true));
    // A terminal gains or loses its chat without core saying anything: say so as a terminal change.
    const offAvailability = opts.chat.onAvailability((address) => {
      const t = opts.session.store.get(address);
      if (t) send({ type: "terminal", terminal: toWireTerminal(t, hasChat(address)) }, true);
    });
    const offShared = opts.appShared ? opts.appShared.onChange((shared) => send({ type: "app.shared", shared }, true)) : () => {};
    send(helloMessage(opts.buildId), false);
    send(snapshotMessage(opts.session, hasChat), false);
    const shared = opts.appShared?.current() ?? null;
    if (shared !== null) send({ type: "app.shared", shared }, false); // with no file there is nothing to say yet

    const chatMessage = (terminal: string, event: ChatEvent): ServerMessage =>
      event.type === "snapshot"
        ? { type: "chat.snapshot", terminal, snapshot: event.snapshot }
        : event.type === "change"
          ? { type: "chat.change", terminal, change: event.change }
          : { type: "chat.unavailable", terminal, reason: event.reason };
    const subscribeChat = (terminal: string): void => {
      chats.get(terminal)?.(); // asking again starts over with a fresh snapshot
      chats.delete(terminal);
      if (chats.size >= MAX_CHAT_SUBSCRIPTIONS) {
        send({ type: "chat.unavailable", terminal, reason: "Too many chats are open in this tab." }, true);
        return;
      }
      const t = opts.session.store.get(terminal);
      if (!t || t.state !== "live") {
        send({ type: "chat.unavailable", terminal, reason: NOT_RUNNING }, true);
        return;
      }
      chats.set(terminal, opts.chat.subscribe(terminal, (event) => send(chatMessage(terminal, event), true)));
    };

    ws.on("message", (data, isBinary) => {
      if (isBinary) return ws.close(1003, "text messages only");
      const parsed = parseClientMessage(data.toString());
      if (!parsed.ok) return ws.close(1008, "invalid message");
      const message = parsed.message;
      if (message.type === "ping") send({ type: "pong" }, true);
      else if (message.type === "chat.subscribe") subscribeChat(message.terminal);
      else {
        chats.get(message.terminal)?.();
        chats.delete(message.terminal);
      }
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

