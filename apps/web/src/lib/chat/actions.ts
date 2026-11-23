import type { ChatAnswerResult } from "@herdr-web/protocol"

/** What the chat view can ask of the backend. Each rejects with a sentence the view shows as it is. */
export interface ChatActions {
  send(text: string): Promise<void>
  stop(): Promise<void>
  /** `provider/id` from `capabilities.models.list`. */
  setModel(id: string): Promise<void>
  setEffort(level: string): Promise<void>
  /** The page of rows before `beforeRowId`, oldest first. */
  loadOlder(beforeRowId: string): Promise<{ rows: import("@herdr-web/agents/rows").Row[]; hasMore: boolean }>
  /** The whole result of a tool row whose result was cut. */
  fullToolResult(rowId: string): Promise<string>
  /** Answer an open prompt (`live.asks`). The agent says whether it took it; a rejection is a sentence, as for the others. */
  answer(id: string, answer: Record<string, unknown>): Promise<ChatAnswerResult>
}

/** Turn whatever a rejected action threw into a sentence. */
export function sentence(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return "That did not work."
}
