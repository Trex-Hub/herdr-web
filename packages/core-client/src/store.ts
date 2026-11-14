import type { MachineView, Terminal, TerminalEvent } from "./types.js";

export type StoreChange =
  | { type: "terminal"; terminal: Terminal }
  | { type: "terminal-removed"; address: string }
  | { type: "machines"; machines: MachineView[] };

/**
 * The terminals core knows about, kept current by applying its events.
 * Terminals are replaced, never mutated, so a reader holding one sees a consistent record.
 */
export class TerminalStore {
  private terminals = new Map<string, Terminal>();
  private machineList: MachineView[] = [];
  private currentSeq: number | null = null;
  private listeners = new Set<(change: StoreChange) => void>();

  /** Called for every terminal added or changed, every terminal removed, and when the machine list changes. */
  subscribe(listener: (change: StoreChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: StoreChange): void {
    for (const l of this.listeners) {
      try {
        l(change);
      } catch {
        // a faulty listener must not break the store or the other listeners
      }
    }
  }

  /** Sequence number of the last snapshot or event applied; null before the first snapshot. */
  get seq(): number | null {
    return this.currentSeq;
  }

  get machines(): MachineView[] {
    return this.machineList;
  }

  /** Every terminal, finished ones included, in core's order. */
  list(): Terminal[] {
    return [...this.terminals.values()];
  }

  get(address: string): Terminal | undefined {
    return this.terminals.get(address);
  }

  setMachines(machines: MachineView[]): void {
    const changed = JSON.stringify(machines) !== JSON.stringify(this.machineList);
    this.machineList = machines;
    if (changed) this.emit({ type: "machines", machines });
  }

  /** Replace everything with a snapshot (first subscribe, reconnect, or `missed`). */
  replaceSnapshot(seq: number, terminals: Terminal[]): void {
    const old = this.terminals;
    this.terminals = new Map(terminals.map((t) => [t.address, t]));
    this.currentSeq = seq;
    // Listeners hear only what differs from what they had.
    for (const t of this.terminals.values()) {
      const before = old.get(t.address);
      if (!before || JSON.stringify(before) !== JSON.stringify(t)) this.emit({ type: "terminal", terminal: t });
    }
    for (const address of old.keys()) {
      if (!this.terminals.has(address)) this.emit({ type: "terminal-removed", address });
    }
  }

  /** Forget everything (before a fresh snapshot from a new core process). */
  clear(): void {
    this.terminals = new Map();
    this.currentSeq = null;
  }

  /**
   * Apply one event. Returns false when it was not applied: before a snapshot,
   * at or below the current seq (already in the snapshot), or naming a terminal we do not hold.
   */
  applyEvent(event: TerminalEvent): boolean {
    if (this.currentSeq === null || event.seq <= this.currentSeq) return false;
    this.currentSeq = event.seq;
    return this.apply(event);
  }

  /** `missed`: take the new snapshot; events at or below its seq are dropped by `applyEvent`. */
  applyMissed(seq: number, terminals: Terminal[]): void {
    this.replaceSnapshot(seq, terminals);
  }

  private apply(event: TerminalEvent): boolean {
    switch (event.type) {
      case "created":
      case "restarted":
        this.put(event.data);
        return true;
      case "removed": {
        if (event.terminal === undefined || !this.terminals.delete(event.terminal)) return false;
        this.emit({ type: "terminal-removed", address: event.terminal });
        return true;
      }
      case "labels": {
        if (event.data.record) {
          this.put(event.data.record);
          return true;
        }
        return this.update(event.terminal, (t) => ({ ...t, labels: event.data.labels }));
      }
      case "lost":
        return this.update(event.terminal, (t) => {
          const { pid: _pid, foreground: _fg, ...rest } = t;
          return {
            ...rest,
            reason: event.data.reason,
            exit_code: event.data.exit_code,
            signal: event.data.signal,
            finished_ms: event.data.finished_ms,
          };
        });
      case "finished":
        return this.update(event.terminal, (t) => {
          const { foreground: _fg, ...rest } = t;
          return {
            ...rest,
            state: "finished",
            reason: event.data.reason,
            exit_code: event.data.exit_code,
            signal: event.data.signal,
            finished_ms: event.data.finished_ms,
          };
        });
      case "keep":
        return this.update(event.terminal, (t) => ({ ...t, keep: event.data.keep }));
      case "status":
        return this.update(event.terminal, (t) => ({
          ...t,
          status: event.data.status,
          records: event.data.records,
          reported: event.data.reported,
        }));
      case "turn":
        return this.update(event.terminal, (t) => ({ ...t, turn: event.data.turn }));
      case "title":
        return this.update(event.terminal, (t) => ({ ...t, title: event.data.title }));
      case "size":
        return this.update(event.terminal, (t) => ({ ...t, cols: event.data.cols, rows: event.data.rows }));
      case "foreground":
        return this.update(event.terminal, (t) => ({ ...t, foreground: event.data }));
      default:
        // `doc` and anything newer than this client: nothing to do for the terminal list.
        return false;
    }
  }

  private put(terminal: Terminal): void {
    this.terminals.set(terminal.address, terminal);
    this.emit({ type: "terminal", terminal });
  }

  private update(address: string | undefined, fn: (t: Terminal) => Terminal): boolean {
    if (address === undefined) return false;
    const current = this.terminals.get(address);
    if (!current) return false;
    this.put(fn(current));
    return true;
  }
}
