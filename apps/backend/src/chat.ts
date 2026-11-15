import { serveAgents, type AgentConnection, type AgentsServer, type Thread, type ThreadChange, type ThreadSnapshot } from "@herdr-web/agents";
import { isLocalTerminal } from "@herdr-web/protocol";
import type { CoreSession } from "@herdr-web/core-client";

/** What a chat subscriber hears about one terminal's thread. */
export type ChatEvent =
  | { type: "snapshot"; snapshot: ThreadSnapshot }
  | { type: "change"; change: ThreadChange }
  | { type: "unavailable"; reason: string };
export type ChatListener = (event: ChatEvent) => void;

export interface ChatHubOptions {
  session: CoreSession;
  /** Where the agents socket goes; null for none (no chat at all, as in tests of everything else). */
  socketPath: string | null;
  log?: (line: string) => void;
  /** How long a hello waits for core to be reachable before it is judged. Default 15 s. */
  coreWaitMs?: number;
  /** How long a hello waits for its terminal to show up in core's list once core is reachable. Default 2 s. */
  terminalWaitMs?: number;
  maxConnections?: number;
  /** Passed to each agent connection (timeouts; tests make them short). */
  accept?: NonNullable<Parameters<typeof serveAgents>[1]["accept"]>;
}

interface Active {
  thread: Thread;
  connection: AgentConnection;
  unsubscribe: () => void;
  /** Why it is being closed by us, for the sentence subscribers get. */
  why: string | null;
}

const NOT_CONNECTED = "No chat for this terminal: the agent has not connected to the bridge. pi needs the herdr-web extension (pi -e <path to packages/pi-extension>) and must have been started by herdr-core.";
const ENDED = "This terminal has ended.";
const GONE = "The agent in this terminal has disconnected from the bridge.";
export const NOT_RUNNING = "This terminal is not running.";
export const NOT_LOCAL = "Chat works only for terminals on this computer.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Owns the agents socket and what hangs off it: which terminal has a chat, who listens to it.
 * Chat belongs to a *terminal*: pi reloads its extension on /new, /resume, /fork and /reload, which
 * arrives here as a new connection for the same terminal; its listeners just get a `reset`.
 */
export class ChatHub {
  private readonly active = new Map<string, Active>();
  private readonly listeners = new Map<string, Set<ChatListener>>();
  private readonly availability = new Set<(terminal: string, available: boolean) => void>();
  private server: AgentsServer | null = null;
  private stopped = false;
  private readonly offSession: () => void;

  constructor(private readonly options: ChatHubOptions) {
    this.offSession = options.session.subscribe((change) => {
      if (change.type === "terminal" && change.terminal.state === "finished") this.end(change.terminal.address, ENDED);
      else if (change.type === "terminal-removed") this.end(change.address, ENDED);
    });
  }

  private log(line: string): void {
    this.options.log?.(line);
  }

  /** Listen on the agents socket. Never throws: when another backend holds the socket, or it cannot be made, there is no chat. */
  async start(): Promise<void> {
    const socketPath = this.options.socketPath;
    if (socketPath === null || this.stopped) return;
    try {
      this.server = await serveAgents(socketPath, {
        log: (line) => this.log(line),
        ...(this.options.maxConnections !== undefined && { maxConnections: this.options.maxConnections }),
        ...(this.options.accept && { accept: this.options.accept }),
        onThread: (thread, connection) => void this.pair(thread, connection),
      });
      if (this.stopped) await this.server.close();
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      this.log(
        /already listening/.test(why)
          ? `chat: another backend is already listening on ${socketPath}; this one runs without chat.`
          : `chat: cannot open the agents socket ${socketPath} (${why}); running without chat.`,
      );
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.offSession();
    await this.server?.close();
    for (const a of this.active.values()) a.unsubscribe();
    this.active.clear();
    this.listeners.clear();
  }

  /** The thread of a terminal of this computer, when an agent is connected for it. */
  thread(terminal: string): Thread | undefined {
    return this.active.get(terminal)?.thread;
  }

  /** Listeners on a terminal's chat (for tests: a closed browser leaves none). */
  subscriberCount(terminal: string): number {
    return this.listeners.get(terminal)?.size ?? 0;
  }

  has(address: string): boolean {
    return this.active.has(address);
  }

  /** Called with a terminal's id each time chat becomes available for it or stops being. */
  onAvailability(listener: (terminal: string, available: boolean) => void): () => void {
    this.availability.add(listener);
    return () => this.availability.delete(listener);
  }

  /**
   * Hear a terminal's thread: first a `snapshot` (or `unavailable`), then changes in order. The
   * subscription outlives the thread: a new one arriving for the terminal gives a `reset`, and the
   * agent going away gives `unavailable`. Returns the unsubscribe.
   */
  subscribe(terminal: string, listener: ChatListener): () => void {
    let set = this.listeners.get(terminal);
    if (!set) this.listeners.set(terminal, (set = new Set()));
    set.add(listener);
    const active = this.active.get(terminal);
    if (active) listener({ type: "snapshot", snapshot: active.thread.snapshot() });
    else listener({ type: "unavailable", reason: this.whyNot(terminal) });
    return () => {
      const current = this.listeners.get(terminal);
      current?.delete(listener);
      if (current && current.size === 0) this.listeners.delete(terminal);
    };
  }

  /** The sentence for a terminal that has no chat. */
  whyNot(terminal: string): string {
    if (!isLocalTerminal(terminal)) return NOT_LOCAL;
    const t = this.options.session.store.get(terminal);
    if (!t || t.state !== "live") return NOT_RUNNING;
    return NOT_CONNECTED;
  }

  // ---- pairing --------------------------------------------------------------------------------

  private isLive(id: string): boolean {
    const t = this.options.session.store.get(id);
    return t !== undefined && t.state === "live";
  }

  /** Wait for core to say the terminal exists: pi can say hello before core's list has caught up, or before the bridge reached core. */
  private async waitLive(id: string): Promise<boolean> {
    if (!isLocalTerminal(id)) return false;
    const began = Date.now();
    let reached: number | null = null;
    for (;;) {
      if (this.stopped) return false;
      if (this.isLive(id)) return true;
      const now = Date.now();
      if (this.options.session.state === "connected") reached ??= now;
      const until = reached !== null ? reached + (this.options.terminalWaitMs ?? 2000) : began + (this.options.coreWaitMs ?? 15_000);
      if (now >= until) return false;
      await sleep(25);
    }
  }

  private async pair(thread: Thread, connection: AgentConnection): Promise<void> {
    const id = thread.terminalId;
    if (!(await this.waitLive(id))) {
      this.log(`chat: closed a connection from an agent that says it is in terminal ${JSON.stringify(id)}: that is not a live terminal of this computer`);
      connection.close();
      return;
    }
    if (thread.closed || this.stopped) return;
    const current = this.active.get(id);
    // Two connections racing for one terminal: the one accepted later wins, whichever identified first.
    if (current && current.connection.order > connection.order) {
      connection.close();
      return;
    }
    if (current) {
      current.unsubscribe();
      this.active.delete(id);
      current.connection.close();
    }
    const unsubscribe = thread.subscribe((change) => this.emit(id, { type: "change", change }));
    const entry: Active = { thread, connection, unsubscribe, why: null };
    this.active.set(id, entry);
    thread.onClose(() => this.gone(id, entry));
    const snapshot = thread.snapshot();
    this.emit(id, { type: "change", change: { type: "reset", seq: snapshot.seq, snapshot } });
    if (!current) this.announce(id, true);
  }

  private gone(id: string, entry: Active): void {
    if (this.active.get(id) !== entry) return; // replaced by a newer one
    this.active.delete(id);
    entry.unsubscribe();
    this.emit(id, { type: "unavailable", reason: entry.why ?? GONE });
    this.announce(id, false);
  }

  /** Close the agent of a terminal, for a reason the subscribers are told. */
  private end(id: string, why: string): void {
    const entry = this.active.get(id);
    if (!entry) return;
    entry.why = why;
    entry.connection.close();
  }

  private emit(id: string, event: ChatEvent): void {
    for (const listener of [...(this.listeners.get(id) ?? [])]) {
      try {
        listener(event);
      } catch (error) {
        this.log(`chat: a listener threw: ${String(error)}`);
      }
    }
  }

  private announce(id: string, available: boolean): void {
    for (const listener of [...this.availability]) {
      try {
        listener(id, available);
      } catch (error) {
        this.log(`chat: a listener threw: ${String(error)}`);
      }
    }
  }
}
