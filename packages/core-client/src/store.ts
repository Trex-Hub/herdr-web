import type { MachineView, Terminal, TerminalEvent } from "./types.js";

/**
 * The terminals core knows about, kept current by applying its events.
 * Terminals are replaced, never mutated, so a reader holding one sees a consistent record.
 */
export class TerminalStore {
  private terminals = new Map<string, Terminal>();
  private machineList: MachineView[] = [];
  private currentSeq: number | null = null;

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
    this.machineList = machines;
  }

  /** Replace everything with a snapshot (first subscribe, reconnect, or `missed`). */
  replaceSnapshot(seq: number, terminals: Terminal[]): void {
    this.terminals = new Map(terminals.map((t) => [t.address, t]));
    this.currentSeq = seq;
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
        this.terminals.set(event.data.address, event.data);
        return true;
      case "removed":
        return event.terminal !== undefined && this.terminals.delete(event.terminal);
      case "labels": {
        if (event.data.record) {
          this.terminals.set(event.data.record.address, event.data.record);
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

  private update(address: string | undefined, fn: (t: Terminal) => Terminal): boolean {
    if (address === undefined) return false;
    const current = this.terminals.get(address);
    if (!current) return false;
    this.terminals.set(address, fn(current));
    return true;
  }
}
