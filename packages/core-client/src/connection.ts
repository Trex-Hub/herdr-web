import net from "node:net";
import { ConnectionClosedError, CoreError } from "./errors.js";
import { encodeCredit, encodeFrame, FrameDecoder, FrameKind } from "./frame.js";
import type { CoreNotification, HelloResult, Methods } from "./types.js";

const NEWLINE = 0x0a;

export interface ConnectionHandlers {
  /** `event`, `heartbeat` and `missed` notifications, from any channel. */
  onNotification?: (n: CoreNotification) => void;
  /** A channel other than 0 was closed by the core. */
  onChannelClosed?: (channel: number) => void;
  /** The connection ended; `error` is set when it was not a clean `close()`. */
  onClose?: (error?: Error) => void;
}

export interface ConnectOptions extends ConnectionHandlers {
  /** Unix socket path (named pipe on Windows). */
  path: string;
  connectTimeoutMs?: number;
  /** Treat the connection as dead after this long without any traffic. Core sends a heartbeat every 15 s. */
  idleTimeoutMs?: number;
  generation?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: { kind?: string; hint?: string } };
}

/**
 * One framed-mode connection to core. Calls run on channel 0 side by side and
 * are matched by id; notifications from any channel go to `onNotification`.
 */
export class CoreConnection {
  private readonly decoder = new FrameDecoder();
  private readonly pending = new Map<number, Pending>();
  private readonly lineBuffers = new Map<number, Buffer>();
  private nextId = 2; // 1 is the hello
  private closed = false;
  private lastRx = Date.now();
  private watchdog: NodeJS.Timeout | undefined;

  private constructor(
    private readonly socket: net.Socket,
    readonly hello: HelloResult,
    private readonly handlers: ConnectionHandlers,
    idleTimeoutMs: number,
  ) {
    socket.on("data", (chunk) => this.onData(chunk));
    socket.resume();
    socket.on("error", (err) => this.shutdown(new ConnectionClosedError(`socket error: ${err.message}`, { cause: err })));
    socket.on("close", () => this.shutdown(new ConnectionClosedError()));
    if (idleTimeoutMs > 0) {
      this.watchdog = setInterval(() => {
        if (Date.now() - this.lastRx > idleTimeoutMs) {
          this.shutdown(new ConnectionClosedError(`no traffic from core for ${idleTimeoutMs} ms`));
        }
      }, Math.max(250, Math.floor(idleTimeoutMs / 3)));
      this.watchdog.unref();
    }
    if (socket.destroyed) this.shutdown(new ConnectionClosedError());
  }

  /** Connect, send `hello` with `framed: true`, and return a connection already in framed mode. */
  static async connect(opts: ConnectOptions): Promise<CoreConnection> {
    const socket = net.createConnection(opts.path);
    socket.on("error", () => {}); // errors are reported by the handshake and the connection; never uncaught
    const timeoutMs = opts.connectTimeoutMs ?? 5000;
    try {
      const { hello, rest } = await handshake(socket, timeoutMs, opts.generation ?? 1);
      const conn = new CoreConnection(socket, hello, opts, opts.idleTimeoutMs ?? 45_000);
      // The core may already have sent frames in the same read as the hello reply.
      if (rest.length > 0) conn.onData(rest);
      return conn;
    } catch (err) {
      socket.destroy();
      throw err;
    }
  }

  call<M extends keyof Omit<Methods, "hello">>(method: M, params: Methods[M]["params"]): Promise<Methods[M]["result"]>;
  call(method: string, params: unknown): Promise<unknown>;
  call(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new ConnectionClosedError());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      this.socket.write(encodeFrame(0, FrameKind.DATA, body), (err) => {
        if (err && this.pending.delete(id)) reject(new ConnectionClosedError(`write failed: ${err.message}`, { cause: err }));
      });
    });
  }

  close(): void {
    this.shutdown(undefined);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private onData(chunk: Buffer): void {
    this.lastRx = Date.now();
    let frames;
    try {
      frames = this.decoder.push(chunk);
    } catch (err) {
      this.shutdown(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    for (const frame of frames) {
      if (this.closed) return;
      if (frame.kind === FrameKind.DATA) {
        if (frame.channel === 0) this.handleMessage(frame.payload);
        else this.handleStream(frame.channel, frame.payload);
      } else if (frame.kind === FrameKind.CLOSE && frame.channel !== 0) {
        this.lineBuffers.delete(frame.channel);
        this.handlers.onChannelClosed?.(frame.channel);
      }
    }
  }

  /** Channel 0: one JSON-RPC message per DATA frame. */
  private handleMessage(payload: Buffer): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(payload.toString("utf8")) as JsonRpcMessage;
    } catch (err) {
      this.shutdown(new Error(`invalid JSON from core: ${(err as Error).message}`));
      return;
    }
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new CoreError(msg.error));
      else p.resolve(msg.result);
    } else if (msg.method) {
      this.handlers.onNotification?.({ method: msg.method, params: msg.params } as CoreNotification);
    }
  }

  /** Other channels (events): JSON lines. Credit the bytes back so the stream keeps flowing. */
  private handleStream(channel: number, payload: Buffer): void {
    if (payload.length > 0) this.socket.write(encodeCredit(channel, payload.length));
    let buf = Buffer.concat([this.lineBuffers.get(channel) ?? Buffer.alloc(0), payload]);
    let nl: number;
    while ((nl = buf.indexOf(NEWLINE)) >= 0) {
      const line = buf.subarray(0, nl).toString("utf8").trim();
      buf = buf.subarray(nl + 1);
      if (line) this.handleMessage(Buffer.from(line));
      if (this.closed) return;
    }
    this.lineBuffers.set(channel, Buffer.from(buf));
  }

  private shutdown(error: Error | undefined): void {
    if (this.closed) return;
    this.closed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.socket.destroy();
    const reason = error ?? new ConnectionClosedError("connection closed by client");
    for (const p of this.pending.values()) p.reject(reason);
    this.pending.clear();
    this.handlers.onClose?.(error);
  }
}

/** Plain-mode hello: one JSON line out, one line back; bytes after it belong to framed mode. */
function handshake(socket: net.Socket, timeoutMs: number, generation: number): Promise<{ hello: HelloResult; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buf: Buffer = Buffer.alloc(0);
    const timer = setTimeout(() => fail(new ConnectionClosedError(`no hello reply within ${timeoutMs} ms`)), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onEnd);
    };
    const fail = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onError = (err: Error) => fail(new ConnectionClosedError(`cannot connect: ${err.message}`, { cause: err }));
    const onEnd = () => fail(new ConnectionClosedError("core closed the connection during hello"));
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(NEWLINE);
      if (nl < 0) return;
      cleanup();
      socket.pause(); // hold further bytes until the connection takes over
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(buf.subarray(0, nl).toString("utf8")) as JsonRpcMessage;
      } catch (err) {
        reject(new Error(`invalid hello reply: ${(err as Error).message}`));
        return;
      }
      if (msg.error) reject(new CoreError(msg.error));
      else if (!(msg.result as HelloResult | undefined)?.framed) reject(new Error("core did not switch to framed mode"));
      else resolve({ hello: msg.result as HelloResult, rest: Buffer.from(buf.subarray(nl + 1)) });
    };
    socket.on("error", onError);
    socket.on("close", onEnd);
    socket.on("data", onData);
    socket.on("connect", () => {
      const hello = { jsonrpc: "2.0", id: 1, method: "hello", params: { framed: true, generation } };
      socket.write(JSON.stringify(hello) + "\n");
    });
  });
}
