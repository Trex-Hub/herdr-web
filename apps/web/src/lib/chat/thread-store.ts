import type { Capabilities, Identity, Live, Row, ThreadChange, ThreadSnapshot } from "@herdr-web/agents/rows"

export interface ThreadState {
  /** The `seq` of the last snapshot or change applied. */
  seq: number
  identity: Identity
  /** Oldest first. Rows are replaced only when they changed, so an unchanged row keeps its object. */
  rows: Row[]
  /** Older rows exist than the ones held. */
  hasMore: boolean
  live: Live
  capabilities: Capabilities
  /** Counts snapshots taken: a `reset` makes the thread a different one, and the view starts at its end again. */
  generation: number
  loadingOlder: boolean
  /** Why the last attempt to load older rows failed. */
  olderError: string | null
  /** Call ids of the prompts that have been open on this thread, kept after they close: a running `ask_user` call that is no longer open but was has been answered and waits for its row. */
  seenAsks: ReadonlySet<string>
}

/** What happened to a change: applied, ignored because it was already applied, or a gap (changes missing: ask for a new snapshot). */
export type ApplyResult = "applied" | "stale" | "gap"

export type Schedule = (run: () => void) => () => void

const frame: Schedule = (run) => {
  if (typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(run)
    return () => cancelAnimationFrame(id)
  }
  const id = setTimeout(run, 16)
  return () => clearTimeout(id)
}

const same = (a: Row, b: Row): boolean => a === b || JSON.stringify(a) === JSON.stringify(b)

/**
 * A browser-side copy of one agent's thread: a snapshot, then ordered changes. Listeners are told
 * at most once per animation frame, however many changes arrived, so a reply streaming in costs
 * one render per frame at most. `getState()` is always the latest.
 */
export class ThreadStore {
  private state: ThreadState
  private listeners = new Set<() => void>()
  private cancel: (() => void) | null = null
  private ids = new Map<string, number>()

  constructor(snapshot: ThreadSnapshot, private readonly schedule: Schedule = frame) {
    this.state = this.fromSnapshot(snapshot, 0)
  }

  getState = (): ThreadState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private fromSnapshot(s: ThreadSnapshot, generation: number): ThreadState {
    this.indexRows(s.rows)
    return { seq: s.seq, identity: s.identity, rows: s.rows, hasMore: s.hasMore, live: s.live, capabilities: s.capabilities, generation, loadingOlder: false, olderError: null, seenAsks: new Set(s.live.asks.map((a) => a.id)) }
  }

  private indexRows(rows: Row[]): void {
    this.ids = new Map(rows.map((r, i) => [r.id, i]))
  }

  /** Apply the next change from the socket. */
  apply(change: ThreadChange): ApplyResult {
    const s = this.state
    if (change.seq <= s.seq) return "stale"
    if (change.type === "reset") {
      this.set(this.fromSnapshot(change.snapshot, s.generation + 1))
      return "applied"
    }
    if (change.seq !== s.seq + 1) return "gap"
    let rows = s.rows
    if (change.rows && change.rows.length > 0) {
      let copy: Row[] | null = null
      for (const row of change.rows) {
        const at = this.ids.get(row.id)
        if (at === undefined) {
          copy ??= rows.slice()
          this.ids.set(row.id, copy.length)
          copy.push(row)
        } else if (!same((copy ?? rows)[at]!, row)) {
          copy ??= rows.slice()
          copy[at] = row
        }
      }
      if (copy) rows = copy
    }
    const live = change.live ?? s.live
    const fresh = live.asks.filter((a) => !s.seenAsks.has(a.id))
    this.set({
      ...s,
      seq: change.seq,
      rows,
      live,
      seenAsks: fresh.length > 0 ? new Set([...s.seenAsks, ...fresh.map((a) => a.id)]) : s.seenAsks,
      capabilities: change.capabilities ?? s.capabilities,
      identity: change.identity ?? s.identity,
    })
    return "applied"
  }

  /** Take a whole new thread (a new snapshot, or a `reset` of any seq): everything held goes, and the view starts at its end. */
  replace(snapshot: ThreadSnapshot): void {
    this.set(this.fromSnapshot(snapshot, this.state.generation + 1))
  }

  /** Put an older page before the rows held. Rows already held are skipped. */
  prepend(older: Row[], hasMore: boolean): void {
    const s = this.state
    const fresh = older.filter((r) => !this.ids.has(r.id))
    const rows = fresh.length > 0 ? [...fresh, ...s.rows] : s.rows
    this.indexRows(rows)
    this.set({ ...s, rows, hasMore, loadingOlder: false, olderError: null })
  }

  setLoadingOlder(loading: boolean, error: string | null = null): void {
    this.set({ ...this.state, loadingOlder: loading, olderError: error })
  }

  /** Tell listeners now, without waiting for the frame (tests, and teardown). */
  flush(): void {
    this.cancel?.()
    this.cancel = null
    for (const l of [...this.listeners]) l()
  }

  private set(next: ThreadState): void {
    this.state = next
    if (this.cancel) return
    this.cancel = this.schedule(() => {
      this.cancel = null
      for (const l of [...this.listeners]) l()
    })
  }
}
