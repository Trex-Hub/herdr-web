import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeFrame, FrameDecoder, FrameKind, type Frame } from "../src/frame.js";
import type { MachineView, Terminal } from "../src/types.js";

export interface Call {
  id: number;
  method: string;
  params: unknown;
}

/** One accepted connection, after the plain-mode hello. */
export class RawConn {
  /** Every frame the client sent after the hello. */
  readonly frames: Frame[] = [];
  constructor(readonly socket: net.Socket) {}

  write(data: Uint8Array): void {
    this.socket.write(data);
  }

  /** A JSON-RPC result on channel 0. */
  reply(id: number, result: unknown): void {
    this.write(encodeFrame(0, FrameKind.DATA, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result }))));
  }

  /** Bytes as one DATA frame on a stream channel. */
  stream(channel: number, bytes: string | Uint8Array): void {
    this.write(encodeFrame(channel, FrameKind.DATA, typeof bytes === "string" ? Buffer.from(bytes) : bytes));
  }

  /** One event notification as a JSON line in its own DATA frame on channel 1. */
  event(seq: number, type: string, terminal: string | undefined, data: unknown): void {
    this.stream(1, eventLine(seq, type, terminal, data));
  }

  /** Credit bytes the client sent on `channel`. */
  credited(channel: number): number {
    return this.frames
      .filter((f) => f.channel === channel && f.kind === FrameKind.CREDIT)
      .reduce((n, f) => n + f.payload.readUInt32LE(0), 0);
  }

  destroy(): void {
    this.socket.destroy();
  }
}

export function eventLine(seq: number, type: string, terminal: string | undefined, data: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", method: "event", params: { seq, type, terminal, data } }) + "\n";
}

/**
 * A scriptable stand-in for core's socket, for the cases `FakeCore` does not
 * cover: hand-built frames, half frames, silence, delayed replies. Answers the
 * plain-mode hello itself (unless `silentHello`), then hands every call to `onCall`.
 */
export class RawCore {
  readonly dir = mkdtempSync(path.join(tmpdir(), "rc-"));
  readonly path = path.join(this.dir, "core.sock");
  readonly connections: RawConn[] = [];
  seq = 0;
  terminals: Terminal[] = [];
  machines: MachineView[] = [];
  /** Accept connections and never answer the hello. */
  silentHello = false;
  /** Called for each call; the default answers `events.subscribe` and `machine.list`. */
  onCall: (conn: RawConn, call: Call) => void = (conn, call) => this.defaultCall(conn, call);
  private server: net.Server | undefined;

  async listen(): Promise<void> {
    this.server = net.createServer((s) => this.accept(s));
    await new Promise<void>((r) => this.server!.listen(this.path, r));
  }

  async stop(): Promise<void> {
    for (const c of this.connections) c.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = undefined;
  }

  async dispose(): Promise<void> {
    await this.stop();
    rmSync(this.dir, { recursive: true, force: true });
  }

  get last(): RawConn {
    const c = this.connections.at(-1);
    if (!c) throw new Error("no connection yet");
    return c;
  }

  defaultCall(conn: RawConn, call: Call): void {
    if (call.method === "events.subscribe") conn.reply(call.id, { seq: this.seq, terminals: this.terminals, channel: 1 });
    else if (call.method === "machine.list") conn.reply(call.id, { machines: this.machines });
    else conn.reply(call.id, {});
  }

  private accept(s: net.Socket): void {
    s.on("error", () => {});
    const conn = new RawConn(s);
    this.connections.push(conn);
    let plain: Buffer = Buffer.alloc(0);
    let framed = false;
    const decoder = new FrameDecoder();
    s.on("data", (chunk) => {
      let data: Buffer = chunk;
      if (!framed) {
        if (this.silentHello) return;
        plain = Buffer.concat([plain, chunk]);
        const nl = plain.indexOf(10);
        if (nl < 0) return;
        const hello = JSON.parse(plain.subarray(0, nl).toString()) as { id: number };
        data = plain.subarray(nl + 1);
        framed = true;
        s.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: hello.id,
            result: { generation: 1, version: "9.9.9", core: { id: "abc", name: "raw" }, framed: true, methods: [], features: ["framed"] },
          }) + "\n",
        );
      }
      for (const f of decoder.push(data)) {
        conn.frames.push(f);
        if (f.channel === 0 && f.kind === FrameKind.DATA) {
          const req = JSON.parse(f.payload.toString()) as { id: number; method: string; params: unknown };
          this.onCall(conn, { id: req.id, method: req.method, params: req.params });
        }
      }
    });
  }
}
