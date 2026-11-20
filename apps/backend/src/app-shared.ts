import fs from "node:fs";
import path from "node:path";
import { AppSharedSchema, type AppShared } from "@herdr-web/protocol";

/** Where the browser gets herdr-app's names and groups from. */
export interface AppSharedSource {
  /** The last good contents; null when there is no file. */
  current(): AppShared | null;
  /** Called with the new contents when they change. Returns a function that stops listening. */
  onChange(listener: (shared: AppShared | null) => void): () => void;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `{ key: "string" }` with every other entry dropped. */
function strings(v: unknown): Record<string, string> {
  if (!isObject(v)) return {};
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""));
}

/** The groups that have an id and a name, the first of each id. */
function groups(v: unknown): AppShared["agents.groups"] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: AppShared["agents.groups"] = [];
  for (const g of v) {
    if (!isObject(g) || typeof g["id"] !== "string" || typeof g["name"] !== "string" || g["id"] === "" || g["name"] === "" || seen.has(g["id"])) continue;
    seen.add(g["id"]);
    out.push({ id: g["id"], name: g["name"] });
  }
  return out;
}

/**
 * The six keys the browser may have, from whatever `shared.json` held: each one's malformed entries are dropped, a
 * missing or malformed key becomes empty, and nothing else is kept (the file also holds layout, panels and the like).
 */
export function sanitizeShared(raw: Record<string, unknown>): AppShared {
  return AppSharedSchema.parse({
    "agents.groups": groups(raw["agents.groups"]),
    "agents.groupLabel": strings(raw["agents.groupLabel"]),
    "agents.agentGroup": strings(raw["agents.agentGroup"]),
    "agents.agentLabel": strings(raw["agents.agentLabel"]),
    "agents.spaceGroup": strings(raw["agents.spaceGroup"]),
    "space.colors": strings(raw["space.colors"]),
  });
}

export interface AppSharedFileOptions {
  /** `~/.config/herdr-app/shared.json`, or where `HW_HERDR_APP_SHARED` points. */
  path: string;
  /** Quiet time after a change before the file is read again. */
  debounceMs?: number;
  /** How often to look for the folder when it does not exist yet, or its watch broke. */
  retryMs?: number;
  /** How often the file is read again whatever the watch said: a watch can miss an event (it does, under load). */
  pollMs?: number;
}

/**
 * herdr-app's `shared.json`, read and never written. It is read again when it changes (a watch on its folder, since an
 * editor or the app may replace the file rather than write into it). A file that is briefly invalid or half written keeps
 * the last good contents; a missing file is `null`, not an error.
 */
export class AppSharedFile implements AppSharedSource {
  private value: AppShared | null = null;
  private listeners = new Set<(shared: AppShared | null) => void>();
  private watcher: fs.FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private poll: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly opts: AppSharedFileOptions) {}

  /** Read the file once and start watching it. */
  start(): void {
    this.stopped = false;
    this.read();
    this.watch();
    this.poll = setInterval(() => this.read(), this.opts.pollMs ?? 2000);
    this.poll.unref();
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
    if (this.retry) clearTimeout(this.retry);
    if (this.poll) clearInterval(this.poll);
    this.timer = this.retry = this.poll = null;
  }

  current(): AppShared | null {
    return this.value;
  }

  onChange(listener: (shared: AppShared | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private watch(): void {
    if (this.stopped) return;
    const dir = path.dirname(this.opts.path);
    const name = path.basename(this.opts.path);
    try {
      this.watcher = fs.watch(dir, (_event, file) => {
        if (file === null || file === name || file === undefined) this.later();
      });
      this.watcher.on("error", () => this.rewatch());
      this.watcher.on("close", () => {
        if (!this.stopped) this.rewatch();
      });
    } catch {
      this.rewatch(); // the folder is not there (yet)
    }
  }

  private rewatch(): void {
    this.watcher?.removeAllListeners();
    this.watcher?.close();
    this.watcher = null;
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.read();
      this.watch();
    }, this.opts.retryMs ?? 5000);
    this.retry.unref();
  }

  private later(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.read();
    }, this.opts.debounceMs ?? 150);
    this.timer.unref();
  }

  private read(): void {
    let next: AppShared | null;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.opts.path, "utf8"));
      if (!isObject(parsed)) return; // not what herdr-app writes: keep the last good contents
      next = sanitizeShared(parsed);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return; // half written, or unreadable for now: keep the last good contents
      next = null;
    }
    if (JSON.stringify(next) === JSON.stringify(this.value)) return;
    this.value = next;
    for (const l of this.listeners) l(next);
  }
}
