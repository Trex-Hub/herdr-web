import { CoreConnection, type ConnectOptions } from "./connection.js";
import { resolveEndpoint } from "./endpoint.js";
import { TerminalStore } from "./store.js";
import type { CoreInfo, CoreNotification } from "./types.js";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "stopped";

export interface CoreSessionOptions {
  /** Where to connect; resolved again on every attempt. Defaults to the endpoint rules in `resolveEndpoint`. */
  endpoint?: () => string;
  /** Reconnect delay: starts at `initialMs`, doubles up to `maxMs`, resets after a good connection. */
  backoff?: { initialMs: number; maxMs: number };
  /** How often to re-read the machine list while connected (core sends no event for machine state). */
  machinePollMs?: number;
  idleTimeoutMs?: number;
  log?: (level: "info" | "warn", message: string) => void;
}

/**
 * Keeps one live subscription to core: connects, subscribes, mirrors the
 * terminals into a store, and reconnects with backoff (taking a fresh snapshot)
 * whenever the connection drops.
 */
export class CoreSession {
  readonly store = new TerminalStore();

  private currentState: ConnectionState = "connecting";
  private currentCore: { info: CoreInfo; version: string } | null = null;
  private currentError: string | null = null;
  private stopped = false;
  private readonly stopSignal = new AbortController();
  private active: CoreConnection | null = null;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(private readonly options: CoreSessionOptions = {}) {}

  get state(): ConnectionState {
    return this.currentState;
  }

  /** Identity and version from the last hello; kept while disconnected. */
  get core(): { info: CoreInfo; version: string } | null {
    return this.currentCore;
  }

  /** Why the last attempt or connection failed, until the next good connection. */
  get lastError(): string | null {
    return this.currentError;
  }

  start(): void {
    if (this.loop) return;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.currentState = "stopped";
    this.stopSignal.abort(); // also ends a connection still in its handshake
    this.active?.close();
    this.wake?.();
    await this.loop;
  }

  private log(level: "info" | "warn", message: string): void {
    this.options.log?.(level, message);
  }

  private async run(): Promise<void> {
    const { initialMs, maxMs } = this.options.backoff ?? { initialMs: 250, maxMs: 5000 };
    let delay = initialMs;
    let first = true;
    while (!this.stopped) {
      this.currentState = first ? "connecting" : "reconnecting";
      first = false;
      try {
        const reachedSnapshot = await this.connectOnce();
        if (reachedSnapshot) delay = initialMs;
      } catch (err) {
        if (this.stopped) break;
        this.currentError = err instanceof Error ? err.message : String(err);
        this.log("warn", `core connection failed: ${this.currentError}`);
      }
      if (this.stopped) break;
      this.currentState = "reconnecting";
      await this.sleep(delay);
      delay = Math.min(delay * 2, maxMs);
    }
  }

  /** One connection's life. Resolves when it ends; true if it got as far as a snapshot. */
  private async connectOnce(): Promise<boolean> {
    const endpoint = (this.options.endpoint ?? (() => resolveEndpoint()))();
    let live = true;
    let ready = false;
    let eventChannel: number | null = null;
    const early: CoreNotification[] = [];
    let ended!: () => void;
    const endedPromise = new Promise<void>((r) => (ended = r));

    const handle = (n: CoreNotification) => {
      if (n.method === "event") this.store.applyEvent(n.params);
      else if (n.method === "missed") {
        this.store.applyMissed(n.params.seq, n.params.terminals);
        void this.refreshMachines(conn);
      }
    };

    const opts: ConnectOptions = {
      path: endpoint,
      signal: this.stopSignal.signal,
      ...(this.options.idleTimeoutMs !== undefined && { idleTimeoutMs: this.options.idleTimeoutMs }),
      onNotification: (n) => {
        if (!live) return;
        if (ready) handle(n);
        else early.push(n); // arrived in the same read as the subscribe reply
      },
      onChannelClosed: (channel) => {
        if (channel === eventChannel) {
          this.log("warn", "core closed the event stream");
          conn.close();
        }
      },
      onClose: (error) => {
        live = false;
        if (error && !this.stopped) this.log("warn", `core connection lost: ${error.message}`);
        ended();
      },
    };

    const conn = await CoreConnection.connect(opts);
    this.active = conn;
    if (this.stopped) {
      conn.close();
      return false;
    }
    let poll: NodeJS.Timeout | undefined;
    try {
      const snapshot = await conn.call("events.subscribe", {});
      eventChannel = snapshot.channel ?? null;
      this.store.replaceSnapshot(snapshot.seq, snapshot.terminals);
      ready = true;
      for (const n of early.splice(0)) handle(n);
      this.currentCore = { info: conn.hello.core, version: conn.hello.version };
      this.currentError = null;
      this.currentState = "connected";
      this.log("info", `connected to core ${conn.hello.version} at ${endpoint}, seq ${snapshot.seq}, ${snapshot.terminals.length} terminals`);
      await this.refreshMachines(conn);
      poll = setInterval(() => void this.refreshMachines(conn), this.options.machinePollMs ?? 15_000);
      poll.unref();
      await endedPromise;
      return true;
    } finally {
      if (poll) clearInterval(poll);
      conn.close();
      if (this.active === conn) this.active = null;
    }
  }

  private async refreshMachines(conn: CoreConnection): Promise<void> {
    try {
      const { machines } = await conn.call("machine.list", {});
      if (!conn.isClosed) this.store.setMachines(machines);
    } catch (err) {
      this.log("warn", `machine.list failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(timer);
        self.wake = null;
        resolve();
      }
      this.wake = done;
    });
  }
}
