import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { ConnectionClosedError, CoreError, type Attachment, type CoreConnection, type CoreSession, type StreamEnd } from "@herdr-web/core-client";
import {
  Tag,
  TerminalClose,
  encodeTerminalMessage,
  parseTerminalClientMessage,
  splitTagged,
  tagMessage,
  type TerminalClientMessage,
} from "@herdr-web/protocol";
import { WebSocket, WebSocketServer } from "ws";
import type { Auth } from "./auth.js";
import { renewedCookie } from "./upgrade.js";

export interface TerminalSocketOptions {
  session: CoreSession;
  auth: Auth;
  /** Most output bytes sent to a browser and not yet reported consumed. Past it the view is closed (4413). */
  maxOutstandingBytes?: number;
  /** Most bytes of input waiting to be written to core. Past it the view is closed (4413). */
  maxQueuedToCoreBytes?: number;
  /** A socket that sends no `attach` this soon is closed (4408). */
  attachTimeoutMs?: number;
  /** Ping interval for a browser that went away without closing. */
  keepaliveMs?: number;
}

export interface TerminalSocket {
  /** Complete an upgrade that has passed the path, origin and cookie checks. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, address: string): void;
  clientCount(): number;
  close(): void;
}

/** The longest message either way: a large paste fits, a flood of garbage does not. */
const MAX_MESSAGE_BYTES = 1024 * 1024;
/** Messages that may wait for the attach to finish. */
const MAX_WAITING = 64;

/**
 * One socket per terminal view. The bridge opens its own connection to core for it, attaches,
 * and relays: output goes out tagged, human input and automatic replies go back as core wants
 * them. Core is paid its CREDIT only once the browser says it parsed the bytes, so a browser
 * that stops reading stops core, and the bridge never holds more than `maxOutstandingBytes`.
 */
export function createTerminalSocket(opts: TerminalSocketOptions): TerminalSocket {
  const maxOutstanding = opts.maxOutstandingBytes ?? 8 * 1024 * 1024;
  const maxQueuedToCore = opts.maxQueuedToCoreBytes ?? 4 * 1024 * 1024;
  const attachTimeoutMs = opts.attachTimeoutMs ?? 10_000;
  const keepaliveMs = opts.keepaliveMs ?? 20_000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  wss.on("headers", (headers, req) => {
    headers.push(`Set-Cookie: ${renewedCookie(opts.auth, req)}`);
  });

  function onConnection(ws: WebSocket, address: string): void {
    let conn: CoreConnection | undefined;
    let attachment: Attachment | undefined;
    let finished = false;
    let outstanding = 0;
    const waiting: Array<{ data: Buffer; isBinary: boolean }> = [];
    let attachStarted = false;

    const timers: NodeJS.Timeout[] = [];
    const finish = (code: number, reason: string): void => {
      if (finished) return;
      finished = true;
      for (const t of timers) clearTimeout(t);
      attachment?.detach();
      conn?.close();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(code, reason.slice(0, 120));
      const t = setTimeout(() => ws.terminate(), 1000); // the peer may never answer the close
      t.unref();
    };
    const sendText = (message: Parameters<typeof encodeTerminalMessage>[0]): void => {
      if (!finished && ws.readyState === WebSocket.OPEN) ws.send(encodeTerminalMessage(message));
    };

    const attachTimer = setTimeout(() => finish(TerminalClose.NO_ATTACH, "no attach message"), attachTimeoutMs);
    timers.push(attachTimer);

    // Keepalive: a browser that vanished without a close frame must not hold a core connection.
    let alive = true;
    const keepalive = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, keepaliveMs);
    keepalive.unref();
    ws.on("pong", () => (alive = true));
    ws.on("close", () => {
      clearInterval(keepalive);
      finished = true;
      for (const t of timers) clearTimeout(t);
      attachment?.detach();
      conn?.close();
    });
    ws.on("error", () => ws.terminate());

    let endedEarly: StreamEnd | undefined;
    const onCoreEnd = (end: StreamEnd): void => {
      if (finished) return;
      if (!announced && attachStarted && !end.connectionLost) {
        endedEarly = end; // the program ended during the attach: say so after `attached` and what it wrote
        return;
      }
      if (end.connectionLost) return finish(TerminalClose.CORE_UNAVAILABLE, "the connection to core was lost");
      // A kept terminal whose program was lost (core stopping, the holder dying) is replaced in place: not over, attach again.
      if (opts.session.store.get(address)?.keep && end.reason !== "exited" && end.reason !== "killed") {
        return finish(TerminalClose.CORE_UNAVAILABLE, `the program was lost (${end.reason})`);
      }
      sendText({ type: "ended", reason: end.reason, exitCode: end.exit_code, signal: end.signal });
      finish(TerminalClose.ENDED, end.reason);
    };

    // The first paint can arrive in the same read as the attach reply, before `attached` is sent: hold it back until then.
    let announced = false;
    const held: Buffer[] = [];
    const sendOutput = (bytes: Buffer): void => {
      ws.send(tagMessage(Tag.OUTPUT, bytes), { binary: true }, (err) => {
        if (err) ws.terminate();
      });
    };
    const onCoreData = (bytes: Buffer): void => {
      if (finished) return;
      outstanding += bytes.length;
      if (outstanding > maxOutstanding) return finish(TerminalClose.TOO_SLOW, "the browser is too far behind");
      if (announced) sendOutput(bytes);
      else held.push(bytes);
    };

    async function start(first: Extract<TerminalClientMessage, { type: "attach" }>): Promise<void> {
      const known = opts.session.store.get(address);
      if (known?.state === "finished") {
        sendText({ type: "ended", reason: known.reason ?? "finished", exitCode: known.exit_code ?? null, signal: known.signal ?? null });
        return finish(TerminalClose.FINISHED, "the terminal has finished");
      }
      try {
        conn = await opts.session.openConnection({ onClose: () => finish(TerminalClose.CORE_UNAVAILABLE, "the connection to core was lost") });
        if (finished) return conn.close();
        const attached = await conn.attach(
          { terminal: address, cols: first.cols, rows: first.rows, history: first.history, display: first.display },
          { onData: onCoreData, onEnd: onCoreEnd },
        );
        attachment = attached;
        if (finished) return attached.detach();
      } catch (err) {
        if (finished) return;
        if (err instanceof CoreError && (err.kind === "not_found" || err.kind === "machine_unknown")) return finish(TerminalClose.NOT_FOUND, "no such terminal");
        if (err instanceof CoreError && err.kind === "finished") {
          sendText({ type: "ended", reason: "finished", exitCode: null, signal: null });
          return finish(TerminalClose.FINISHED, "the terminal has finished");
        }
        if (err instanceof CoreError && err.kind === "unavailable") return finish(TerminalClose.CORE_UNAVAILABLE, "the terminal cannot be reached");
        if (err instanceof ConnectionClosedError) return finish(TerminalClose.CORE_UNAVAILABLE, "core cannot be reached");
        return finish(TerminalClose.INTERNAL, "attach failed");
      }
      clearTimeout(attachTimer);
      announced = true;
      sendText({ type: "attached", cols: attachment.result.terminal.cols ?? first.cols, rows: attachment.result.terminal.rows ?? first.rows, automaticInput: attachment.result.automatic_input });
      for (const bytes of held.splice(0)) sendOutput(bytes);
      if (endedEarly) return onCoreEnd(endedEarly);
      for (const m of waiting.splice(0)) handle(m.data, m.isBinary);
    }

    function handle(data: Buffer, isBinary: boolean): void {
      if (finished) return;
      const att = attachment;
      if (!att) return finish(TerminalClose.INTERNAL, "not attached");
      if (isBinary) {
        const tagged = splitTagged(data);
        if (!tagged || tagged.tag === Tag.OUTPUT) return finish(TerminalClose.PROTOCOL, "invalid binary message");
        if (conn && conn.queuedBytes + tagged.bytes.length > maxQueuedToCore) return finish(TerminalClose.TOO_SLOW, "core is not reading input");
        if (tagged.tag === Tag.INPUT) att.sendInput(tagged.bytes);
        else att.sendAutomatic(tagged.bytes);
        return;
      }
      const parsed = parseTerminalClientMessage(data.toString("utf8"));
      if (!parsed.ok) return finish(TerminalClose.PROTOCOL, "invalid message");
      const m = parsed.message;
      switch (m.type) {
        case "attach":
          return finish(TerminalClose.PROTOCOL, "already attached");
        case "resize":
          return att.resize(m.cols, m.rows);
        case "focus":
          return att.focus(m.focused);
        case "display":
          return att.facts(m.display);
        case "consumed":
          if (m.bytes > outstanding) return finish(TerminalClose.PROTOCOL, "consumed more than was sent");
          outstanding -= m.bytes;
          return att.credit(m.bytes);
      }
    }

    ws.on("message", (data, isBinary) => {
      if (finished) return;
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      if (!attachStarted) {
        if (isBinary) return finish(TerminalClose.PROTOCOL, "attach first");
        const parsed = parseTerminalClientMessage(buf.toString("utf8"));
        if (!parsed.ok || parsed.message.type !== "attach") return finish(TerminalClose.PROTOCOL, "the first message must be attach");
        attachStarted = true;
        void start(parsed.message);
        return;
      }
      if (!attachment) {
        if (waiting.length >= MAX_WAITING) return finish(TerminalClose.PROTOCOL, "too many messages before attached");
        waiting.push({ data: buf, isBinary });
        return;
      }
      handle(buf, isBinary);
    });
  }

  return {
    handleUpgrade: (req, socket, head, address) => wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, address)),
    clientCount: () => wss.clients.size,
    close: () => {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
