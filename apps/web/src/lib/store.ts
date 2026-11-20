import { PROTOCOL_VERSION } from "@herdr-web/protocol"
import type { AppShared, Connection, Layout, Machine, ServerMessage, Terminal } from "@herdr-web/protocol"

/** The browser's link to the backend. */
export type Link = "connecting" | "open" | "reconnecting"

export interface LiveState {
  /** Set once the first snapshot of the current socket has arrived; data is empty until then. */
  ready: boolean
  link: Link
  /** The backend's connection to core, as of the last message; null before the first snapshot. */
  connection: Connection | null
  terminals: Record<string, Terminal>
  machines: Machine[]
  /** One per machine, keyed by the machine's name, or "" for the backend's own core. */
  layouts: Record<string, Layout>
  /** herdr-app's names and groups, read-only; null when the backend has none. */
  appShared: AppShared | null
  /** The backend's build id the first time this page heard it. */
  loadedBuild: string | null
  /** Why the page should be reloaded, once it should. */
  reload: string | null
}

export const initialState: LiveState = {
  ready: false,
  link: "connecting",
  connection: null,
  terminals: {},
  machines: [],
  layouts: {},
  appShared: null,
  loadedBuild: null,
  reload: null,
}

const layoutKey = (machine: string | null): string => machine ?? ""

/** Apply one message from the backend. Pure: returns the same object when nothing changed. */
export function applyMessage(state: LiveState, message: ServerMessage): LiveState {
  switch (message.type) {
    case "hello": {
      if (message.protocol !== PROTOCOL_VERSION) {
        return { ...state, reload: "The backend speaks a different protocol version than this page." }
      }
      if (state.loadedBuild !== null && state.loadedBuild !== message.build) {
        return { ...state, reload: "The backend was updated since this page was loaded." }
      }
      return state.loadedBuild === message.build ? state : { ...state, loadedBuild: message.build }
    }
    case "snapshot":
      return {
        ...state,
        ready: true,
        connection: message.connection,
        terminals: Object.fromEntries(message.terminals.map((t) => [t.address, t])),
        machines: message.machines,
        layouts: Object.fromEntries(message.layouts.map((l) => [layoutKey(l.machine), l])),
        // `app.shared` follows a snapshot when there is a file; one from an earlier connection is no longer known.
        appShared: null,
      }
    case "terminal":
      return { ...state, terminals: { ...state.terminals, [message.terminal.address]: message.terminal } }
    case "terminal.removed": {
      if (!(message.address in state.terminals)) return state
      const { [message.address]: _gone, ...rest } = state.terminals
      return { ...state, terminals: rest }
    }
    case "machines":
      return { ...state, machines: message.machines }
    case "layout":
      return { ...state, layouts: { ...state.layouts, [layoutKey(message.layout.machine)]: message.layout } }
    case "layout.removed": {
      const key = layoutKey(message.machine)
      if (!(key in state.layouts)) return state
      const { [key]: _gone, ...rest } = state.layouts
      return { ...state, layouts: rest }
    }
    case "connection":
      return { ...state, connection: message.connection }
    case "app.shared":
      return { ...state, appShared: message.shared }
    case "pong":
      return state
    case "chat.snapshot":
    case "chat.change":
    case "chat.unavailable":
      return state // the chat store takes these (they belong to one thread, not to the shell's state)
  }
}

export function setLink(state: LiveState, link: Link): LiveState {
  return state.link === link ? state : { ...state, link }
}

/** Why what is on screen may be out of date; null when it is current. */
export type Staleness = "backend" | "core" | null

export function staleness(state: LiveState): Staleness {
  if (state.link !== "open") return "backend"
  if (state.connection && state.connection.state !== "connected") return "core"
  return null
}

/** A tiny external store for useSyncExternalStore. */
export class Store<T> {
  private listeners = new Set<() => void>()
  constructor(private state: T) {}
  getState = (): T => this.state
  setState(update: (state: T) => T): void {
    const next = update(this.state)
    if (next === this.state) return
    this.state = next
    for (const l of this.listeners) l()
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
