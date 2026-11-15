import net from "node:net";
import { hello, state } from "../../../packages/agents/test/helpers.js";

type Json = Record<string, unknown>;

/** What a pi extension looks like from the agents socket: speaks the wire by hand, answers actions as told. */
export class FakeAgent {
  /** Every line the backend sent, parsed. */
  readonly lines: Json[] = [];
  /** The actions among them. */
  readonly actions: Json[] = [];
  closed = false;
  /** How to answer an action: ok, an error sentence, or null for silence. */
  answer: (action: Json) => { ok: true } | { ok: false; error: string } | null = () => ({ ok: true });
  private buffer = "";

  private constructor(readonly socket: net.Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (let at = this.buffer.indexOf("\n"); at >= 0; at = this.buffer.indexOf("\n")) {
        const line = JSON.parse(this.buffer.slice(0, at)) as Json;
        this.buffer = this.buffer.slice(at + 1);
        this.lines.push(line);
        if (line["type"] === "action") {
          this.actions.push(line);
          const reply = this.answer(line);
          if (reply) this.send({ type: "result", id: line["id"], ...reply });
        }
      }
    });
    socket.on("close", () => (this.closed = true));
    socket.on("error", () => {});
  }

  static connect(path: string): Promise<FakeAgent> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(path);
      const agent = new FakeAgent(socket);
      socket.once("connect", () => resolve(agent));
      socket.once("error", reject);
    });
  }

  send(message: Json): void {
    this.socket.write(JSON.stringify({ v: 1, ...message }) + "\n");
  }

  /** Hello, models and the first state: what the extension sends on connecting. */
  open(terminalId: string, file: string | null, overrides: Json = {}): void {
    this.send({ ...hello(file, { terminalId }) });
    this.send({
      type: "models",
      list: [
        { provider: "p", id: "m", name: "M", reasoning: true, efforts: ["off", "low", "high"] },
        { provider: "p", id: "n", name: "N", reasoning: false, efforts: ["off"] },
      ],
    });
    this.send({ ...state({ model: { provider: "p", id: "m", name: "M", reasoning: true }, effort: "off", efforts: ["off", "low", "high"] }), ...overrides });
  }

  close(): void {
    this.socket.destroy();
  }
}
