import type { ClientMessage, ServerMessage } from "@herdr-web/protocol"
import { ThreadStore } from "./thread-store"

/** Where one terminal's chat stands on this page. */
export interface ChatEntry {
  /**
   * `loading`: asked for, no thread yet. `ready`: a thread, and the agent is connected.
   * `unavailable`: the agent's extension is not connected; the rows of the last thread stay (`store`), stale.
   */
  phase: "loading" | "ready" | "unavailable"
  /** The thread; the same object for as long as the terminal is watched, whatever happens to the agent. */
  store: ThreadStore | null
  /** A sentence, when unavailable. */
  reason: string | null
}

const NONE: ChatEntry = { phase: "loading", store: null, reason: null }

/**
 * The chat threads this page watches, fed from the main socket. A view `watch`es a terminal while it shows its chat and
 * lets go when it does not; the feed subscribes and unsubscribes with it, and subscribes again after every reconnect
 * (each new main socket starts with nothing subscribed, and the answer is a new snapshot).
 */
export class ChatFeed {
  private entries = new Map<string, ChatEntry>()
  private watching = new Map<string, number>()
  private listeners = new Set<() => void>()
  private open = false

  constructor(private readonly send: (message: ClientMessage) => boolean) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  entry = (address: string): ChatEntry => this.entries.get(address) ?? NONE

  /** Start watching a terminal's chat; the returned function stops. Several views may watch the same one. */
  watch(address: string): () => void {
    const count = this.watching.get(address) ?? 0
    this.watching.set(address, count + 1)
    if (count === 0) this.ask(address)
    let done = false
    return () => {
      if (done) return
      done = true
      const left = (this.watching.get(address) ?? 1) - 1
      if (left > 0) {
        this.watching.set(address, left)
        return
      }
      this.watching.delete(address)
      // What was held goes with the last view: the next one starts from a snapshot.
      this.entries.delete(address)
      if (this.open) this.send({ type: "chat.unsubscribe", terminal: address })
      this.changed()
    }
  }

  /** The main socket opened (its snapshot arrived) or was lost. */
  setOpen(open: boolean): void {
    this.open = open
    if (open) for (const address of this.watching.keys()) this.ask(address)
  }

  /** One message from the backend; anything that is not about a chat is ignored. */
  handle(message: ServerMessage): void {
    switch (message.type) {
      case "chat.snapshot": {
        if (!this.watching.has(message.terminal)) return
        const held = this.entries.get(message.terminal)?.store
        if (held) held.replace(message.snapshot)
        this.put(message.terminal, { phase: "ready", store: held ?? new ThreadStore(message.snapshot), reason: null })
        return
      }
      case "chat.change": {
        if (!this.watching.has(message.terminal)) return
        const held = this.entries.get(message.terminal)?.store ?? null
        const change = message.change
        if (change.type === "reset") {
          // The agent started a new thread, or came back: whatever seq it carries, this is not the thread that was held.
          if (held) held.replace(change.snapshot)
          this.put(message.terminal, { phase: "ready", store: held ?? new ThreadStore(change.snapshot), reason: null })
          return
        }
        if (!held) return this.ask(message.terminal)
        if (held.apply(change) === "gap") this.ask(message.terminal) // changes were missed: a new snapshot
        return
      }
      case "chat.unavailable": {
        if (!this.watching.has(message.terminal)) return
        const held = this.entries.get(message.terminal)?.store ?? null
        this.put(message.terminal, { phase: "unavailable", store: held, reason: message.reason })
        return
      }
      default:
        return
    }
  }

  private put(address: string, entry: ChatEntry): void {
    const was = this.entries.get(address)
    if (was && was.phase === entry.phase && was.store === entry.store && was.reason === entry.reason) return
    this.entries.set(address, entry)
    this.changed()
  }

  private ask(address: string): void {
    if (!this.open) return
    // The backend keeps one subscription per terminal and socket: asking again replaces it and is answered with a snapshot.
    this.send({ type: "chat.subscribe", terminal: address })
  }

  private changed(): void {
    for (const l of [...this.listeners]) l()
  }
}
