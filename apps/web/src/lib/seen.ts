/**
 * When to write `herdr.seen` for the agent on screen (docs/labels.md of herdr-app): once per turn,
 * only while a person is really looking, only to raise it, and never over a "mark unread".
 */
export class SeenTracker {
  /** Per terminal: the latest turn already dealt with, written or not. */
  private handled = new Map<string, number>()

  /**
   * `attending`: the page is visible and focused, and this agent's pane is the one shown.
   * Returns the turn to write, or null. Call it again whenever the turn, the label, or `attending` changes.
   */
  decide(t: { address: string; turn: number; seen: number | null }, attending: boolean): number | null {
    if (!attending) return null // nothing is decided while nobody looks: the turn is still owed
    if ((this.handled.get(t.address) ?? -1) >= t.turn) return null
    this.handled.set(t.address, t.turn)
    if (t.seen !== null && t.seen >= t.turn) return null // never lowers, never repeats
    return t.turn
  }

  /** Our own "mark unread": the turn it was made for must not be overruled by the screen that is still showing it. */
  markedUnread(address: string, turn: number): void {
    this.handled.set(address, Math.max(this.handled.get(address) ?? -1, turn))
  }

  /** A write that failed: look again at the next change. */
  failed(address: string, turn: number): void {
    if (this.handled.get(address) === turn) this.handled.delete(address)
  }
}
