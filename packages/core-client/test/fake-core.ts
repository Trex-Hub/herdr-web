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
  /** `herdr-app` documents by machine name ("" for the core itself); an unwritten one is `{value: null, version: 0}`. */
  docs = new Map<string, { value: unknown; version: number }>();
  /** Machines whose `doc.get` fails with this message. */
  docErrors = new Map<string, string>();
  /** Every `doc.get` params received. */
  docGets: Array<{ name: string; on?: string }> = [];
  /** Every method called, in order. */
  methodsCalled: string[] = [];
  /** Features the hello advertises. */
  features: string[] = ["framed", "automatic_input"];
  /** Whether attach confirms `automatic_input: true`. */
  attachAutomatic = true;
  /** `terminal.attach` params received. */
  attaches: Array<Record<string, unknown>> = [];
  /** Attach errors by terminal: `kind` is the error data kind. */
  attachErrors = new Map<string, { kind: string; message: string }>();
  /** What to send right after an attach reply, as one or more frames (in the same write as the reply when `paintWithReply`). */
  firstPaint: Buffer[] = [Buffer.from("\x18first-paint")];
  paintWithReply = true;
  /** Frames of attach streams received from viewers: [channel, kind, payload]. */
  streamFrames: Array<[number, number, Buffer]> = [];
  /** Close the stream in the same write as the reply and first paint. */
  endWithPaint: { reason: string; exitCode: number | null } | undefined;
  private nextChannel = 2;
  private streamOwners = new Map<number, net.Socket>();
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

  event(type: string, terminal: string | undefined, data: unknown, machine?: string): void {
    this.seq += 1;
    const line = JSON.stringify({ jsonrpc: "2.0", method: "event", params: { seq: this.seq, type, terminal, data, ...(machine && { machine }) } }) + "\n";
    this.push(Buffer.from(line));
  }

  /** Write a document and announce it, as core does (the event carries no value). */
  setDoc(value: unknown, machine = ""): void {
    const version = (this.docs.get(machine)?.version ?? 0) + 1;
    this.docs.set(machine, { value, version });
    this.event("doc", undefined, { name: "herdr-app", version }, machine || undefined);
  }

  /** Send output bytes on an attach stream. */
  streamOut(channel: number, bytes: Uint8Array): void {
    const s = this.streamOwners.get(channel);
    if (s) this.send(s, encodeFrame(channel, FrameKind.DATA, bytes));
  }

  /** End an attach stream as core does when the program ends. */
  streamEnd(channel: number, reason = "exited", exitCode: number | null = 0, signal: number | null = null): void {
    const s = this.streamOwners.get(channel);
    if (!s) return;
    this.streamOwners.delete(channel);
    this.send(s, encodeFrame(channel, FrameKind.CLOSE, Buffer.from(JSON.stringify({ reason, exit_code: exitCode, signal }))));
  }

  /** Channels currently attached. */
  get attachedChannels(): number[] {
    return [...this.streamOwners.keys()];
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
            result: { generation: 1, version: "9.9.9", core: { id: "abc", name: "fake" }, framed: true, methods: [], features: this.features },
          }) + "\n",
        );
        if (rest.length) chunk = rest;
        else return;
      }
      for (const f of decoder.push(chunk)) {
        if (f.channel !== 0 || f.kind !== FrameKind.DATA) {
          this.clientFrames.push([f.channel, f.kind]);
          if (f.channel !== 0) this.streamFrames.push([f.channel, f.kind, f.payload]);
          if (f.channel !== 0 && f.kind === FrameKind.CLOSE && this.streamOwners.delete(f.channel)) {
            s.write(encodeFrame(f.channel, FrameKind.CLOSE, Buffer.alloc(0)));
          }
          continue;
        }
        this.onCall(s, JSON.parse(f.payload.toString()));
      }
    });
  }

  /** Every call on channel 0 with its params, in order (methodsCalled has the names only). */
  calls: Array<{ method: string; params: unknown }> = [];
  /** Answers for other methods: a result, or a thrown/returned `{ error }` turned into a JSON-RPC error. */
  rpc = new Map<string, (params: any) => unknown>();

  private onCall(s: net.Socket, req: { id: number; method: string; params: unknown }): void {
    this.methodsCalled.push(req.method);
    this.calls.push({ method: req.method, params: req.params });
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
      case "terminal.attach": {
        const p = req.params as Record<string, unknown>;
        this.attaches.push(p);
        const failure = this.attachErrors.get(String(p["terminal"]));
        if (failure) {
          this.send(s, encodeFrame(0, FrameKind.DATA, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: failure.message, data: { kind: failure.kind } } }))));
          return;
        }
        const channel = this.nextChannel++;
        this.streamOwners.set(channel, s);
        const terminal = this.terminals.find((t) => t.address === p["terminal"]) ?? { address: p["terminal"] };
        let out = reply({ channel, terminal, resize_notifications: false, automatic_input: this.attachAutomatic });
        if (this.paintWithReply) out = Buffer.concat([out, ...this.firstPaint.map((b) => encodeFrame(channel, FrameKind.DATA, b))]);
        if (this.endWithPaint) {
          const end = this.endWithPaint;
          out = Buffer.concat([out, encodeFrame(channel, FrameKind.CLOSE, Buffer.from(JSON.stringify({ reason: end.reason, exit_code: end.exitCode, signal: null })))]);
          this.streamOwners.delete(channel);
        }
        this.send(s, out);
        if (!this.paintWithReply) for (const b of this.firstPaint) this.send(s, encodeFrame(channel, FrameKind.DATA, b));
        return;
      }
      case "machine.list":
        this.send(s, reply({ machines: this.machines }));
        return;
      case "doc.get": {
        const p = req.params as { name: string; on?: string };
        this.docGets.push(p);
        const failure = this.docErrors.get(p.on ?? "");
        if (failure !== undefined) {
          this.send(s, encodeFrame(0, FrameKind.DATA, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: failure, data: { kind: "machine_unknown" } } }))));
          return;
        }
        this.send(s, reply(this.docs.get(p.on ?? "") ?? { value: null, version: 0 }));
        return;
      }
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
      default: {
        const handler = this.rpc.get(req.method);
        const answer = handler ? handler(req.params) : {};
        if (answer && typeof answer === "object" && "error" in answer) {
          const e = (answer as { error: { message: string; kind?: string } }).error;
          this.send(s, encodeFrame(0, FrameKind.DATA, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: e.message, data: { kind: e.kind } } }))));
        } else this.send(s, reply(answer));
      }
    }
  }
}
