import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeFrame, FrameDecoder, FrameKind } from "../src/frame.js";
import type { MachineView, Terminal } from "../src/types.js";

/** A stand-in for core's socket: plain hello, then framed mode, events on channel 1. */
export class FakeCore {
  readonly dir = mkdtempSync(path.join(tmpdir(), "fc-"));
  readonly path = path.join(this.dir, "core.sock");
  seq = 0;
  terminals: Terminal[] = [];
  machines: MachineView[] = [];
  /** Frames the client sent that were not calls (CREDIT etc.), as `[channel, kind]`. */
  clientFrames: Array<[number, number]> = [];
  private server: net.Server | undefined;
  private sockets = new Set<net.Socket>();
  private subscribers = new Set<net.Socket>();
  /** Write the subscribe reply and the next pushed event in a single socket write. */
  glueNextEventToReply: string | undefined;
  /** Dribble every outgoing byte separately. */
  byteAtATime = false;
  /** Stay silent: no replies and no events, but keep the sockets open. */
  muted = false;

  async listen(): Promise<void> {
    this.server = net.createServer((s) => this.onConnection(s));
    await new Promise<void>((r) => this.server!.listen(this.path, r));
  }

  /** Stop listening and drop every connection, as a core stopping would. */
  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = undefined;
  }

  async dispose(): Promise<void> {
    await this.stop();
    rmSync(this.dir, { recursive: true, force: true });
  }

  /** Close the events channel (channel 1) without dropping the connection. */
  closeEventChannels(): void {
    for (const s of this.subscribers) s.write(encodeFrame(1, FrameKind.CLOSE, Buffer.from('{"reason":"server_stop"}')));
  }

  dropConnections(): void {
    for (const s of this.sockets) s.destroy();
  }

  event(type: string, terminal: string | undefined, data: unknown): void {
    this.seq += 1;
    const line = JSON.stringify({ jsonrpc: "2.0", method: "event", params: { seq: this.seq, type, terminal, data } }) + "\n";
    this.push(Buffer.from(line));
  }

  raw(method: "heartbeat" | "missed", params: unknown): void {
    this.push(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"));
  }

  private push(line: Buffer): void {
    for (const s of this.subscribers) this.send(s, encodeFrame(1, FrameKind.DATA, line));
  }

  private send(s: net.Socket, data: Buffer): void {
    if (this.muted) return;
    if (!this.byteAtATime) s.write(data);
    else for (const b of data) s.write(Buffer.from([b]));
  }

  private onConnection(s: net.Socket): void {
    this.sockets.add(s);
    s.on("close", () => {
      this.sockets.delete(s);
      this.subscribers.delete(s);
    });
    s.on("error", () => {});
    let plain = Buffer.alloc(0);
    let framed = false;
    const decoder = new FrameDecoder();
    s.on("data", (chunk) => {
      if (!framed) {
        plain = Buffer.concat([plain, chunk]);
        const nl = plain.indexOf(10);
        if (nl < 0) return;
        const hello = JSON.parse(plain.subarray(0, nl).toString());
        const rest = plain.subarray(nl + 1);
        framed = true;
        s.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: hello.id,
            result: { generation: 1, version: "9.9.9", core: { id: "abc", name: "fake" }, framed: true, methods: [], features: ["framed"] },
          }) + "\n",
        );
        if (rest.length) chunk = rest;
        else return;
      }
      for (const f of decoder.push(chunk)) {
        if (f.channel !== 0 || f.kind !== FrameKind.DATA) {
          this.clientFrames.push([f.channel, f.kind]);
          continue;
        }
        this.onCall(s, JSON.parse(f.payload.toString()));
      }
    });
  }

  private onCall(s: net.Socket, req: { id: number; method: string; params: unknown }): void {
    const reply = (result: unknown) =>
      encodeFrame(0, FrameKind.DATA, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: req.id, result })));
    switch (req.method) {
      case "events.subscribe": {
        this.subscribers.add(s);
        let out = reply({ seq: this.seq, terminals: this.terminals, channel: 1 });
        if (this.glueNextEventToReply !== undefined) {
          this.seq += 1;
          const line = JSON.stringify({ jsonrpc: "2.0", method: "event", params: { seq: this.seq, type: "title", terminal: this.glueNextEventToReply, data: { title: "glued" } } }) + "\n";
          out = Buffer.concat([out, encodeFrame(1, FrameKind.DATA, Buffer.from(line))]);
          this.glueNextEventToReply = undefined;
        }
        this.send(s, out);
        return;
      }
      case "machine.list":
        this.send(s, reply({ machines: this.machines }));
        return;
      case "boom":
        this.send(
          s,
          encodeFrame(
            0,
            FrameKind.DATA,
            Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "no terminal t9", data: { kind: "not_found", hint: "try ls" } } })),
          ),
        );
        return;
      case "slow": // answered after "fast", to prove calls are matched by id
        setTimeout(() => this.send(s, reply("slow")), 50);
        return;
      case "fast":
        this.send(s, reply("fast"));
        return;
      default:
        this.send(s, reply({}));
    }
  }
}
