// What the backend holds for one agent in one terminal. An adapter is asked about a terminal and,
// when it recognises the agent, produces one of these; the backend only wires it to the main socket.
import type { Row, ThreadChange, ThreadSnapshot } from "./rows.js"

/** A failed action, whose message is a sentence the app can show as it is. */
export class ActionError extends Error {
  override name = "ActionError"
}

export interface Page {
  /** Oldest first, ending just before the row asked about. */
  rows: Row[]
  /** Whether still older rows exist. */
  hasMore: boolean
}

/** What pi-live said of an answer. `invalid` carries the parker's reason; the prompt stays open. */
export type AnswerResult = { status: "delivered" } | { status: "invalid"; reason: string } | { status: "closed" } | { status: "not_found" }

export interface Thread {
  /** The agent: "pi". */
  readonly kind: string
  /** The herdr-core terminal id the agent runs in (`t17`). */
  readonly terminalId: string
  /** Identity, the last page of rows, live state and capabilities, as of now. */
  snapshot(): ThreadSnapshot
  /**
   * Changes after `snapshot()`, in order, called synchronously as they happen. Take the snapshot and
   * subscribe in the same tick and nothing is lost: a change carries `seq`, one more than the last.
   * Returns the unsubscribe.
   */
  subscribe(listener: (change: ThreadChange) => void): () => void
  /** The page of rows before `beforeRowId`. Rejects with an ActionError when that row is no longer on the branch. */
  page(beforeRowId: string, limit?: number): Promise<Page>
  /** The whole result of a tool row, which its row may have cut. */
  toolResult(rowId: string): Promise<string>

  // Actions. Each resolves when the agent accepted it and rejects with an ActionError otherwise.
  /** Send a message; while the agent works it is queued as a steer. A leading "/" is not special here: route those yourself. */
  send(text: string): Promise<void>
  stop(): Promise<void>
  /** `provider/id`, one of `capabilities.models.list`. */
  setModel(id: string): Promise<void>
  setEffort(level: string): Promise<void>
  /** Empty the agent's input box, so a command typed into its terminal is not appended to a draft. */
  clearInput(): Promise<void>
  /** Name the session. */
  setName(name: string): Promise<void>
  /** Compact the session; a failure arrives later as a notice in `live`, not here. */
  compact(instructions?: string): Promise<void>

  /**
   * Answer an open prompt (`live.asks`). Not checked here: the agent's own rules decide, and say why not.
   * Needs no control. Rejects with an ActionError when there is no connection, or the agent does not reply in time.
   */
  answer(id: string, answer: unknown): Promise<AnswerResult>

  readonly closed: boolean
  /** Called once when the agent goes away (the connection closed). */
  onClose(listener: () => void): void
  close(): void
}
