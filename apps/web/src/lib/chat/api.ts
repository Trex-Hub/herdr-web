import {
  ChatAnswerResultSchema,
  ChatDoneSchema,
  ChatPageSchema,
  ChatSentSchema,
  ChatToolResultSchema,
  chatPath,
  type ChatOperationName,
} from "@herdr-web/protocol"
import { backendUrl } from "../backend"
import { request, type Fetch } from "../operations"
import type { ChatActions } from "./actions"

/** One `POST /api/chat/<name>`; a failure is thrown as its sentence, which is what the chat view shows. */
async function post<T>(base: string, fetchImpl: Fetch, name: ChatOperationName, input: unknown, schema: { parse(value: unknown): T }): Promise<T> {
  const result = await request(
    `${base}${chatPath(name)}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) },
    (body) => schema.parse(body),
    fetchImpl,
  )
  if (!result.ok) throw new Error(result.error)
  return result.value
}

/**
 * The chat view's actions for one terminal, as calls to the backend. Nothing is queued: a call made while the backend is away
 * is refused with a sentence.
 */
export function chatActions(terminal: string, base: string = backendUrl(), fetchImpl: Fetch = (...a) => fetch(...a)): ChatActions {
  return {
    send: async (text) => void (await post(base, fetchImpl, "send", { terminal, text }, ChatSentSchema)),
    stop: async () => void (await post(base, fetchImpl, "stop", { terminal }, ChatDoneSchema)),
    setModel: async (model) => void (await post(base, fetchImpl, "model", { terminal, model }, ChatDoneSchema)),
    setEffort: async (effort) => void (await post(base, fetchImpl, "effort", { terminal, effort }, ChatDoneSchema)),
    loadOlder: (before) => post(base, fetchImpl, "older", { terminal, before }, ChatPageSchema),
    fullToolResult: async (row) => (await post(base, fetchImpl, "result", { terminal, row }, ChatToolResultSchema)).text,
    answer: (id, answer) => post(base, fetchImpl, "answer", { terminal, id, answer }, ChatAnswerResultSchema),
  }
}

