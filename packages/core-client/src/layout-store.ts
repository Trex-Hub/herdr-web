import type { MachineLayout } from "./layout.js";

export type LayoutChange =
  | { type: "layout"; layout: MachineLayout }
  | { type: "layout-removed"; machine: string | null };

const key = (machine: string | null): string => machine ?? "";

/** The latest layout per machine (the core itself, then each added machine). */
export class LayoutStore {
  private layouts = new Map<string, MachineLayout>();
  private listeners = new Set<(change: LayoutChange) => void>();

  /** The core's own layout first, then the others in the order they were first set. */
  list(): MachineLayout[] {
    const local = this.layouts.get("");
    const rest = [...this.layouts.entries()].filter(([k]) => k !== "").map(([, l]) => l);
    return local ? [local, ...rest] : rest;
  }

  get(machine: string | null): MachineLayout | undefined {
    return this.layouts.get(key(machine));
  }

  /** Store a layout; notifies only when something other than the document version changed. */
  set(layout: MachineLayout): void {
    const old = this.layouts.get(key(layout.machine));
    this.layouts.set(key(layout.machine), layout);
    if (!old || differs(old, layout)) this.emit({ type: "layout", layout });
  }

  remove(machine: string | null): void {
    if (this.layouts.delete(key(machine))) this.emit({ type: "layout-removed", machine });
  }

  subscribe(listener: (change: LayoutChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: LayoutChange): void {
    for (const l of this.listeners) {
      try {
        l(change);
      } catch {
        // a faulty listener must not stop the others
      }
    }
  }
}

function differs(a: MachineLayout, b: MachineLayout): boolean {
  return JSON.stringify({ ...a, version: 0 }) !== JSON.stringify({ ...b, version: 0 });
}
