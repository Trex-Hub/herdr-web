import { CoreConnection, type ConnectOptions } from "./connection.js";
import { resolveEndpoint } from "./endpoint.js";
import { LAYOUT_DOCUMENT, parseLayout, unavailableLayout, type MachineLayout } from "./layout.js";
import { LayoutStore, type LayoutChange } from "./layout-store.js";
import { TerminalStore, type StoreChange } from "./store.js";
import type { CoreInfo, CoreNotification, MachineView } from "./types.js";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "stopped";

/** The connection to core as the browser sees it. */
export interface ConnectionInfo {
  state: ConnectionState;
  /** Why the last attempt or connection failed, until the next good connection. */
  error: string | null;
  core: { id: string; name: string; version: string } | null;
}

export type SessionChange = StoreChange | LayoutChange | { type: "connection"; connection: ConnectionInfo };

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
  /** Spaces, tabs and panes per machine, from each machine's `herdr-app` document. */
  readonly layouts = new LayoutStore();

  private listeners = new Set<(change: SessionChange) => void>();
  private layoutReads = new Map<string, { again: boolean }>();
  private currentState: ConnectionState = "connecting";
  private currentCore: { info: CoreInfo; version: string } | null = null;
  private currentError: string | null = null;
  private stopped = false;
  private readonly stopSignal = new AbortController();
  private active: CoreConnection | null = null;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(private readonly options: CoreSessionOptions = {}) {
    this.store.subscribe((c) => this.emit(c));
    this.layouts.subscribe((c) => this.emit(c));
  }

  get state(): ConnectionState {
    return this.currentState;
  }

  get connection(): ConnectionInfo {
    return {
      state: this.currentState,
      error: this.currentError,
      core: this.currentCore && { id: this.currentCore.info.id, name: this.currentCore.info.name, version: this.currentCore.version },
    };
  }

  /** Hear every change to terminals, machines, layouts and the connection, in order. Returns an unsubscribe function. */
  subscribe(listener: (change: SessionChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: SessionChange): void {
    for (const l of this.listeners) {
      try {
        l(change);
      } catch {
        // a faulty listener must not break the session or the other listeners
      }
    }
  }

  /** Set the state and error together, telling listeners when either changed. */
  private setConnection(state: ConnectionState, error: string | null = this.currentError): void {
    const changed = state !== this.currentState || error !== this.currentError;
    this.currentState = state;
    this.currentError = error;
    if (changed) this.emit({ type: "connection", connection: this.connection });
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
    this.setConnection("stopped");
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
      this.setConnection(first ? "connecting" : "reconnecting");
      first = false;
      try {
        const reachedSnapshot = await this.connectOnce();
        if (reachedSnapshot) delay = initialMs;
      } catch (err) {
        if (this.stopped) break;
        this.setConnection(this.currentState, err instanceof Error ? err.message : String(err));
        this.log("warn", `core connection failed: ${this.currentError}`);
      }
      if (this.stopped) break;
      this.setConnection("reconnecting");
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
      if (n.method === "event") {
        const ev = n.params;
        const before = this.store.seq;
        this.store.applyEvent(ev);
        // Events at or below the snapshot's seq are already covered by the layout read that follows it.
        if (ev.type === "doc" && ev.data.name === LAYOUT_DOCUMENT && before !== null && ev.seq > before) {
          void this.readLayout(conn, ev.machine ?? null);
        }
      } else if (n.method === "missed") {
        this.store.applyMissed(n.params.seq, n.params.terminals);
        void this.refreshMachines(conn, true);
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
      this.setConnection("connected", null);
      this.log("info", `connected to core ${conn.hello.version} at ${endpoint}, seq ${snapshot.seq}, ${snapshot.terminals.length} terminals`);
      await this.refreshMachines(conn, true);
      poll = setInterval(() => void this.refreshMachines(conn, false), this.options.machinePollMs ?? 15_000);
      poll.unref();
      await endedPromise;
      return true;
    } finally {
      if (poll) clearInterval(poll);
      conn.close();
      if (this.active === conn) this.active = null;
    }
  }

  /**
   * Re-read the machine list, then bring layouts in line with it. `all`: read every
   * layout again (after a subscribe or `missed`); otherwise only those of machines whose
   * line just came back, and any layout that is unavailable (a failed or unreadable read).
   */
  private async refreshMachines(conn: CoreConnection, all: boolean): Promise<void> {
    let machines: MachineView[];
    try {
      ({ machines } = await conn.call("machine.list", {}));
    } catch (err) {
      this.log("warn", `machine.list failed: ${err instanceof Error ? err.message : String(err)}`);
      if (all) await this.readLayout(conn, null);
      return;
    }
    if (conn.isClosed) return;
    const previous = new Map(this.store.machines.map((m) => [m.name, m.state]));
    this.store.setMachines(machines);
    const reads: Promise<void>[] = [];
    // On the poll, also try again a layout that is unavailable on a line that is up: a failed
    // read raises no event, so nothing else would retry it. The poll interval is the retry rate.
    const own = this.layouts.get(null);
    if (all || !own || own.status === "unavailable") reads.push(this.readLayout(conn, null));
    const names = new Set(machines.map((m) => m.name));
    for (const layout of this.layouts.list()) {
      if (layout.machine !== null && !names.has(layout.machine)) this.layouts.remove(layout.machine);
    }
    for (const m of machines) {
      if (m.state === "connected") {
        const stored = this.layouts.get(m.name);
        if (all || previous.get(m.name) !== "connected" || !stored || stored.status === "unavailable") reads.push(this.readLayout(conn, m.name));
      } else {
        this.layouts.set(unavailableLayout(m.name, `machine ${m.state}${m.why ? `: ${m.why}` : ""}`));
      }
    }
    await Promise.all(reads);
  }

  /**
   * Read one machine's `herdr-app` document (`on` for a machine; none for the core itself).
   * A read asked for while one is running is run again once it ends, so the last word wins.
   * Never throws: a failed read leaves the layout `unavailable` with the reason.
   */
  private async readLayout(conn: CoreConnection, machine: string | null): Promise<void> {
    const key = machine ?? "";
    const running = this.layoutReads.get(key);
    if (running) {
      running.again = true;
      return;
    }
    const state = { again: false };
    this.layoutReads.set(key, state);
    try {
      do {
        state.again = false;
        let layout: MachineLayout;
        try {
          const params = machine === null ? { name: LAYOUT_DOCUMENT } : { name: LAYOUT_DOCUMENT, on: machine };
          const result = await conn.call("doc.get", params);
          layout = parseLayout(machine, result?.value, result?.version);
        } catch (err) {
          layout = unavailableLayout(machine, err instanceof Error ? err.message : String(err));
        }
        if (conn.isClosed) return;
        this.layouts.set(layout);
      } while (state.again);
    } finally {
      this.layoutReads.delete(key);
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
