import fs from "node:fs";
import path from "node:path";
import { FakePi, type FakeConfig } from "../../../packages/agents/test/fake-pi-live.js";

let counter = 0;

export interface LivePiOptions {
  terminal: string | null;
  /** The pid in the session file (and the welcome). Default 4242. */
  pid?: number;
  sessionId?: string;
  /** The session file pi reports in its welcome (the rows come from it). */
  file?: string | null;
  mode?: string;
  /** Write the session file at once. Default true. */
  publish?: boolean;
  config?: FakeConfig;
  /** Extra fields of the session file. */
  sidecar?: Record<string, unknown>;
}

/** The test's clock: one tick per file written. */
let clock = 0;

/**
 * A pi as the backend meets it: a pi-live socket (the fake of packages/agents) and the `<sessionId>.json` pi-live writes beside it,
 * in the folder the harness's hub watches.
 */
export class LivePi {
  readonly pid: number;
  readonly sessionId: string;
  readonly jsonPath: string;

  private constructor(
    readonly dir: string,
    readonly fake: FakePi,
    private readonly options: LivePiOptions,
  ) {
    this.pid = options.pid ?? 4242;
    this.sessionId = options.sessionId ?? `s-${process.pid}-${counter++}`;
    this.jsonPath = path.join(dir, `${this.sessionId}.json`);
  }

  static async start(dir: string, options: LivePiOptions): Promise<LivePi> {
    const sessionId = options.sessionId ?? `s-${process.pid}-${counter++}`;
    const config: FakeConfig = {
      ...options.config,
      session: { id: sessionId, pid: options.pid ?? 4242, mode: options.mode ?? "tui", ...(options.terminal !== null && { terminal: options.terminal }), file: options.file ?? undefined, ...options.config?.session },
    };
    const pi = new LivePi(dir, await FakePi.start(config), { ...options, sessionId });
    if (options.publish !== false) pi.publish();
    return pi;
  }

  /** Write the session file, atomically as pi-live does. Each call is a later `startedAt` than any before it, from any pi, as the clock gives. */
  publish(extra: Record<string, unknown> = {}): void {
    const tmp = `${this.jsonPath}.${this.pid}.tmp`;
    const body = {
      protocol: 1,
      sessionId: this.sessionId,
      ...(this.options.file ? { sessionFile: this.options.file } : {}),
      cwd: "/tmp",
      pid: this.pid,
      startedAt: new Date(1_800_000_000_000 + ++clock * 1000).toISOString(),
      socketPath: this.fake.path,
      mode: this.options.mode ?? "tui",
      ...(this.options.terminal !== null && { terminal: this.options.terminal }),
      version: "0.2.0",
      ...this.options.sidecar,
      ...extra,
    };
    fs.writeFileSync(tmp, JSON.stringify(body) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.jsonPath);
  }

  unpublish(): void {
    fs.rmSync(this.jsonPath, { force: true });
  }

  /** What the backend sent as actions, in order. */
  get actions(): any[] {
    return this.fake.actions();
  }

  /** Every line the backend sent. */
  get lines(): any[] {
    return this.fake.received;
  }

  send(message: object): void {
    this.fake.send(message);
  }

  /** pi-live ending the session: goodbye, then the close. */
  goodbye(shutdown?: string): void {
    this.fake.goodbye(shutdown);
  }

  /** The socket ends with no word, as a killed pi's does. */
  crash(): void {
    this.fake.crash();
  }

  /** Connections the backend holds open to this pi. */
  get connections(): number {
    return this.fake.connections;
  }

  /** Hellos received so far: connections the backend has made (a closed one counts). */
  get hellos(): number {
    return this.fake.received.filter((m) => m.type === "hello").length;
  }

  async stop(): Promise<void> {
    this.unpublish();
    await this.fake.stop();
  }
}
