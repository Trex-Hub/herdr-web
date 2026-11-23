import { z } from "zod";
import { RowSchema, ThreadChangeSchema, ThreadSnapshotSchema } from "@herdr-web/agents/rows";

// --- chat ---------------------------------------------------------------------------------------
// A chat is the conversation of an agent running in one terminal of the bridge's own computer.
// Reading it goes over the main socket (subscribe to a terminal, get its thread, then changes);
// acting on it is plain HTTP POSTs, like the operations. The rows, live state and capabilities
// are the schemas of `@herdr-web/agents/rows`, not copied here. See PROTOCOL.md ("Chat").

/** A terminal of the bridge's own computer: `t7`, never `machine/t7`. */
export const LOCAL_TERMINAL = /^t[0-9a-z]{1,9}$/;
export const isLocalTerminal = (address: string): boolean => LOCAL_TERMINAL.test(address);
const Local = z.string().refine(isLocalTerminal, "not a terminal of this computer (t7)");

/** Most chat threads one main socket may hold at once. */
export const MAX_CHAT_SUBSCRIPTIONS = 16;

// --- main socket --------------------------------------------------------------------------------

export const ChatSubscribeSchema = z.object({ type: z.literal("chat.subscribe"), terminal: Local }).strict();
export const ChatUnsubscribeSchema = z.object({ type: z.literal("chat.unsubscribe"), terminal: Local }).strict();

/** The thread as it is now: sent once after `chat.subscribe` when the terminal has chat. */
export const ChatSnapshotMessageSchema = z.object({ type: z.literal("chat.snapshot"), terminal: z.string(), snapshot: ThreadSnapshotSchema });
/** One change of a subscribed thread; a `reset` when the agent started a new thread or came back. */
export const ChatChangeMessageSchema = z.object({ type: z.literal("chat.change"), terminal: z.string(), change: ThreadChangeSchema });
/** The terminal has no chat (now): the agent is not connected, or is not one we know. A sentence. */
export const ChatUnavailableMessageSchema = z.object({ type: z.literal("chat.unavailable"), terminal: z.string(), reason: z.string() });

// --- operations ---------------------------------------------------------------------------------

/** `POST /api/chat/<name>`. */
export const CHAT_PREFIX = "/api/chat/";
export const CHAT_OPERATION_NAMES = ["send", "stop", "model", "effort", "older", "result", "answer"] as const;
export type ChatOperationName = (typeof CHAT_OPERATION_NAMES)[number];
export function chatPath(name: ChatOperationName): string {
  return CHAT_PREFIX + name;
}

/** The longest message the app may send. */
export const MAX_MESSAGE_CHARS = 100_000;
/** The most rows one `older` page may ask for. */
export const MAX_PAGE = 200;

export const ChatSendInputSchema = z.object({ terminal: Local, text: z.string().min(1).max(MAX_MESSAGE_CHARS) }).strict();
export const ChatStopInputSchema = z.object({ terminal: Local }).strict();
export const ChatModelInputSchema = z.object({ terminal: Local, model: z.string().min(1).max(300) }).strict();
export const ChatEffortInputSchema = z.object({ terminal: Local, effort: z.string().min(1).max(32) }).strict();
export const ChatOlderInputSchema = z
  .object({ terminal: Local, before: z.string().min(1).max(300), limit: z.number().int().min(1).max(MAX_PAGE).optional() })
  .strict();
export const ChatResultInputSchema = z.object({ terminal: Local, row: z.string().min(1).max(300) }).strict();

/** `answer`: the shape is all that is checked here; pi-ask-user decides whether the answer is valid. */
export const ChatAnswerInputSchema = z
  .object({ terminal: Local, id: z.string().min(1).max(300), answer: z.record(z.string(), z.unknown()) })
  .strict();

export type ChatSendInput = z.infer<typeof ChatSendInputSchema>;
export type ChatStopInput = z.infer<typeof ChatStopInputSchema>;
export type ChatModelInput = z.infer<typeof ChatModelInputSchema>;
export type ChatEffortInput = z.infer<typeof ChatEffortInputSchema>;
export type ChatOlderInput = z.infer<typeof ChatOlderInputSchema>;
export type ChatResultInput = z.infer<typeof ChatResultInputSchema>;
export type ChatAnswerInput = z.infer<typeof ChatAnswerInputSchema>;

/** `send`: how the message went in. `terminal`: it began with `/`, so it was typed into the agent's terminal. */
export const ChatSentSchema = z.object({ via: z.enum(["agent", "terminal"]) });
export const ChatDoneSchema = z.object({ ok: z.literal(true) });
export const ChatPageSchema = z.object({ rows: z.array(RowSchema), hasMore: z.boolean() });
export const ChatToolResultSchema = z.object({ text: z.string() });
/** `answer`: `delivered`, `invalid` (pi-ask-user's reason; the prompt stays open), `closed` (answered or closed already), `not_found`. */
export const ChatAnswerResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("delivered") }),
  z.object({ status: z.literal("invalid"), reason: z.string() }),
  z.object({ status: z.literal("closed") }),
  z.object({ status: z.literal("not_found") }),
]);

export type ChatSent = z.infer<typeof ChatSentSchema>;
export type ChatDone = z.infer<typeof ChatDoneSchema>;
export type ChatPage = z.infer<typeof ChatPageSchema>;
export type ChatToolResult = z.infer<typeof ChatToolResultSchema>;
export type ChatAnswerResult = z.infer<typeof ChatAnswerResultSchema>;
