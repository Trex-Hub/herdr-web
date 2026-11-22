import fs from "node:fs";
import { connectPiLive, type PiLiveConnection, type PiLiveEnd, type PiLiveOptions, type PiThread, type Thread, type ThreadChange, type ThreadSnapshot } from "@herdr-web/agents";
import { isLocalTerminal } from "@herdr-web/protocol";
import type { CoreSession } from "@herdr-web/core-client";
import { readPiSessions, type PiSession } from "./pi-sessions.js";

/** What a chat subscriber hears about one terminal's thread. */
export type ChatEvent =
  | { type: "snapshot"; snapshot: ThreadSnapshot }
  | { type: "change"; change: ThreadChange }
  | { type: "unavailable"; reason: string };
export type ChatListener = (event: ChatEvent) => void;

export interface ChatHubOptions {
  session: CoreSession;
  /** pi-live's folder of session files (`piLiveDir()` says which); null for none (no chat at all, as in tests of everything else). */
  liveDir: string | null;
  log?: (line: string) => void;
  /** How long a pi waits for core to be reachable before its terminal is judged. Default 15 s. */
  coreWaitMs?: number;
  /** How long a pi waits for its terminal to show up in core's list once core is reachable. Default 2 s. */
  terminalWaitMs?: number;
  /** How often the folder is read whatever the file watcher says. Default 3 s. */
  rescanMs?: number;
  /** How long a chat is kept while its pi is between sessions or reconnecting, before subscribers are told it is gone. Default 10 s. */
  followMs?: number;
  /** Whether a process is there. Default: signal 0 (a process of another user counts as there). */
  alive?: (pid: number) => boolean;
  /** Passed to each pi-live connection (timeouts and limits; tests make them short). */
  connection?: Partial<Pick<PiLiveOptions, "welcomeTimeoutMs" | "maxLineBytes" | "thread">>;
}

/** One pi holding one terminal's chat. */
/** Whether a file of the same pi as `link` names a later start than the file `link` was connected from. */
const newer = (s: PiSession, link: { startedMs: number }): boolean => Date.parse(s.startedAt) > link.startedMs;

interface Link {
  terminal: string;
  pid: number;
  /** `PiSession.key` of the file it was connected from. */
  key: string;
  /** `startedAt` of that file, in ms (NaN when it names none): of two files of one pi, the newer is the session. */
  startedMs: number;
  file: string;
  connection: PiLiveConnection;
  thread: PiThread;
  unsubscribe: () => void;
  /**
   * live: connected. reloading: pi said goodbye and is opening another session; wait for its new file. dropped: the connection
   * ended without a goodbye and pi is still there; reconnect to the same file.
   */
  state: "live" | "reloading" | "dropped";
  /** Ends the wait of a reloading or dropped link. */
  timer: ReturnType<typeof setTimeout> | null;
  /** The next reconnect, for a dropped link. */
  retryAt: number;
  retryEveryMs: number;
  /** Why it is being closed by us, for the sentence subscribers get. */
  why: string | null;
  retired: boolean;
}

export const NOT_CONNECTED = "No chat for this terminal: the backend found no pi-live session in it. pi needs pi-ask-user (which brings pi-live) and must have been started by herdr-core.";
export const RELOADING = "pi is opening another session in this terminal. Try again in a moment.";
export const RECONNECTING = "The connection to pi dropped. Trying to reconnect.";
const ENDED = "This terminal has ended.";
const GONE = "The agent in this terminal has disconnected from the bridge.";
export const NOT_RUNNING = "This terminal is not running.";
export const NOT_LOCAL = "Chat works only for terminals on this computer.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Watches pi-live's folder and holds a connection to each pi in a terminal of this computer: which terminal has a chat, who
 * listens to it. Chat belongs to a *terminal*: a pi that opens another session (`/new`, `/resume`, `/fork`, `/reload`) says goodbye
 * and writes a new file, which arrives here as a new connection for the same terminal; its listeners just get a `reset`.
 */
export class ChatHub {
  private readonly active = new Map<string, Link>();
  private readonly listeners = new Map<string, Set<ChatListener>>();
  private readonly availability = new Set<(terminal: string, available: boolean) => void>();
  /** Sessions being connected right now: one connection per session id. */
  private readonly connecting = new Set<string>();
  /** Files already reported in the log, so a file that stays wrong is said once. */
  private readonly noted = new Set<string>();
  /** Files whose pi has said goodbye: never connected to again, though the file may still be there a moment (a new session is a new file). */
  private readonly dead = new Set<string>();
  /** Files that could not be used (a terminal that is not live, a socket that does not answer): not tried again for a while, longer each time. */
  private readonly skipped = new Map<string, { until: number; stepMs: number }>();
  private stopped = false;
  private watcher: fs.FSWatcher | null = null;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private nudge: ReturnType<typeof setTimeout> | null = null;
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

  private alive(pid: number): boolean {
    return (this.options.alive ?? pidAlive)(pid);
  }

  /** Start watching the folder. Never throws: with no folder there is simply no chat yet. */
  async start(): Promise<void> {
    if (this.options.liveDir === null || this.stopped) return;
    this.scanTimer = setInterval(() => this.scan(), this.options.rescanMs ?? 3000);
    this.scanTimer.unref();
    this.scan();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.offSession();
    this.watcher?.close();
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.nudge) clearTimeout(this.nudge);
    for (const link of this.active.values()) {
      if (link.timer) clearTimeout(link.timer);
      link.retired = true;
      link.unsubscribe();
      link.connection.close();
    }
    this.active.clear();
    this.listeners.clear();
  }

  /** The thread of a terminal of this computer, when a pi is connected for it (closed while its pi is between sessions). */
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
   * pi going away gives `unavailable`. Returns the unsubscribe.
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
    const state = this.active.get(terminal)?.state;
    return state === "reloading" ? RELOADING : state === "dropped" ? RECONNECTING : NOT_CONNECTED;
  }

  // ---- finding and linking pis -------------------------------------------------------------------

  /** Read the folder and look at each pi it names. Whatever it finds, it must not take the backend down. */
  private scan(): void {
    const dir = this.options.liveDir;
    if (dir === null || this.stopped) return;
    if (this.watcher === null && fs.existsSync(dir)) {
      try {
        const watcher = fs.watch(dir, { persistent: false }, () => this.later());
        watcher.on("error", () => {
          watcher.close();
          if (this.watcher === watcher) this.watcher = null;
        });
        this.watcher = watcher;
      } catch {
        this.watcher = null; // the timer covers it
      }
    }
    let sessions: PiSession[];
    try {
      sessions = readPiSessions(dir, (file, why) => this.once(`bad:${file}:${why}`, `chat: ignored ${file}: ${why}`));
    } catch (error) {
      this.log(`chat: cannot read ${dir}: ${String(error)}`);
      return;
    }
    // what is no longer in the folder is forgotten, so a file that comes back is judged again
    const keys = new Set(sessions.map((s) => `key:${s.key}`));
    for (const k of [...this.noted]) if (k.startsWith("key:") && !keys.has(k)) this.noted.delete(k);
    for (const k of [...this.dead]) if (!keys.has(k)) this.dead.delete(k);
    for (const k of [...this.skipped.keys()]) if (!keys.has(k)) this.skipped.delete(k);
    if (this.noted.size > 1000) this.noted.clear();
    for (const session of sessions) void this.consider(session).catch((error) => this.log(`chat: ${session.file}: ${String(error)}`));
    if ([...this.active.values()].some((l) => l.state !== "live")) this.later(100); // a chat waits for its pi: look often
  }

  /** A change in the folder: read it in a moment, once for a burst. */
  private later(delayMs = 25): void {
    if (this.nudge || this.stopped) return;
    this.nudge = setTimeout(() => {
      this.nudge = null;
      this.scan();
    }, delayMs);
    this.nudge.unref();
  }

  private once(key: string, line: string): void {
    if (this.noted.has(key)) return;
    this.noted.add(key);
    this.log(line);
  }

  /** Leave a file alone for a while: `firstMs`, then twice as long each time, up to a minute. */
  private skip(s: PiSession, firstMs: number): void {
    const stepMs = Math.min((this.skipped.get(`key:${s.key}`)?.stepMs ?? firstMs / 2) * 2, 60_000);
    this.skipped.set(`key:${s.key}`, { until: Date.now() + stepMs, stepMs });
  }

  private async consider(s: PiSession): Promise<void> {
    if (this.stopped || this.dead.has(`key:${s.key}`) || (this.skipped.get(`key:${s.key}`)?.until ?? 0) > Date.now()) return;
    if (!isLocalTerminal(s.terminal)) {
      this.once(`key:${s.key}`, `chat: ${s.file} says its pi is in ${JSON.stringify(s.terminal)}, which is not a terminal of this computer`);
      return;
    }
    let holder = this.active.get(s.terminal);
    if (holder && holder.pid !== s.pid) {
      if (holder.state !== "live" && !this.alive(holder.pid)) {
        this.finish(holder, GONE); // its pi is gone: the terminal is free
        holder = undefined;
      } else {
        this.once(`key:${s.key}`, `chat: refused a pi in terminal ${JSON.stringify(s.terminal)} (process ${s.pid}): process ${holder.pid} holds it`);
        return;
      }
    }
    if (holder && holder.key === s.key && holder.state === "live") return; // already ours
    if (holder && holder.key !== s.key && !newer(s, holder)) return; // an older file of the same pi (one nobody removed) must not take the terminal back
    if (holder?.state === "dropped" && Date.now() < holder.retryAt) return;
    if (this.connecting.has(s.sessionId)) return;
    if (!this.alive(s.pid)) return; // a file left behind by a pi that is gone
    this.connecting.add(s.sessionId);
    try {
      if (!holder && !(await this.waitLive(s.terminal))) {
        this.skip(s, 5000);
        this.once(`key:${s.key}`, `chat: ignored a pi that says it is in terminal ${JSON.stringify(s.terminal)}: that is not a live terminal of this computer`);
        return;
      }
      await this.connect(s);
    } finally {
      this.connecting.delete(s.sessionId);
    }
  }

  private async connect(s: PiSession): Promise<void> {
    if (this.stopped) return;
    const connection = connectPiLive(s.socketPath, {
      terminalId: s.terminal,
      log: (line) => this.log(`chat: ${s.file}: ${line}`),
      ...this.options.connection,
    });
    let ready;
    try {
      ready = await connection.ready;
    } catch {
      const end = await connection.closed;
      const held = this.active.get(s.terminal);
      if (held?.state === "dropped") {
        held.retryEveryMs = Math.min(held.retryEveryMs * 2, 2000);
        held.retryAt = Date.now() + held.retryEveryMs;
      } else {
        this.skip(s, 1000);
        this.once(`key:${s.key}`, `chat: could not connect to the pi of ${s.file} in terminal ${JSON.stringify(s.terminal)} (${end.why})`);
      }
      return;
    }
    const held = this.active.get(s.terminal);
    if (this.stopped || !fs.existsSync(s.file)) {
      connection.close(); // the file was read, and the pi went, while this was connecting: not a pi any more
      return;
    }
    if (held && held.pid !== s.pid) {
      connection.close();
      this.once(`key:${s.key}`, `chat: refused a pi in terminal ${JSON.stringify(s.terminal)} (process ${s.pid}): process ${held.pid} holds it`);
      return;
    }
    if (held && held.key !== s.key && !newer(s, held)) {
      connection.close(); // another file of this pi was linked while this was connecting, and it is the newer
      return;
    }
    if (held) this.retire(held);
    const thread = ready.thread;
    const unsubscribe = thread.subscribe((change) => this.emit(s.terminal, { type: "change", change }));
    const link: Link = { terminal: s.terminal, pid: s.pid, key: s.key, startedMs: Date.parse(s.startedAt), file: s.file, connection, thread, unsubscribe, state: "live", timer: null, retryAt: 0, retryEveryMs: 100, why: null, retired: false };
    this.active.set(s.terminal, link);
    void connection.closed.then((end) => this.ended(link, end));
    const snapshot = thread.snapshot();
    this.emit(s.terminal, { type: "change", change: { type: "reset", seq: snapshot.seq, snapshot } });
    if (!held) this.announce(s.terminal, true);
  }

  /** A link replaced by a newer one of the same pi leaves without a word to the subscribers: they get a `reset`. */
  private retire(link: Link): void {
    if (link.timer) clearTimeout(link.timer);
    link.timer = null;
    link.retired = true;
    link.unsubscribe();
    this.active.delete(link.terminal);
    link.connection.close();
  }

  /** A pi's connection ended. Goodbye to quit, or no pi any more: the chat is over. A new session or a dropped line is waited out. */
  private ended(link: Link, end: PiLiveEnd): void {
    if (link.retired || this.active.get(link.terminal) !== link) return;
    this.log(`chat: terminal ${JSON.stringify(link.terminal)}: ${end.why}`);
    if (end.shutdown !== null) this.dead.add(`key:${link.key}`); // its file is not a new session, however recently it was read
    if (end.shutdown === "quit") return this.finish(link, GONE);
    if (end.shutdown !== null) {
      link.state = "reloading";
    } else if (!this.alive(link.pid) || !fs.existsSync(link.file)) {
      return this.finish(link, GONE);
    } else {
      link.state = "dropped";
      link.retryAt = Date.now() + link.retryEveryMs;
    }
    link.timer = setTimeout(() => {
      link.timer = null;
      this.finish(link, GONE);
    }, this.options.followMs ?? 10_000);
    this.later(50);
  }

  /** The chat of a terminal is over: subscribers are told and the terminal has none. */
  private finish(link: Link, why: string): void {
    if (this.active.get(link.terminal) !== link) return;
    if (link.timer) clearTimeout(link.timer);
    link.timer = null;
    link.retired = true;
    this.active.delete(link.terminal);
    link.unsubscribe();
    link.connection.close();
    this.emit(link.terminal, { type: "unavailable", reason: link.why ?? why });
    this.announce(link.terminal, false);
  }

  /** The terminal of a chat ended in core: its pi is let go, for a reason the subscribers are told. */
  private end(id: string, why: string): void {
    const link = this.active.get(id);
    if (!link) return;
    link.why = why;
    this.finish(link, why);
  }

  private isLive(id: string): boolean {
    const t = this.options.session.store.get(id);
    return t !== undefined && t.state === "live";
  }

  /** Wait for core to say the terminal exists: a pi can write its file before core's list has caught up, or before the bridge reached core. */
  private async waitLive(id: string): Promise<boolean> {
    if (!isLocalTerminal(id)) return false;
    const began = Date.now();
    let reached: number | null = null;
    for (;;) {
      if (this.stopped) return false;
      if (this.isLive(id)) return true;
      if (this.options.session.store.get(id) !== undefined) return false; // finished: it does not come back
      const now = Date.now();
      if (this.options.session.state === "connected") reached ??= now;
      const until = reached !== null ? reached + (this.options.terminalWaitMs ?? 2000) : began + (this.options.coreWaitMs ?? 15_000);
      if (now >= until) return false;
      await sleep(25);
    }
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
