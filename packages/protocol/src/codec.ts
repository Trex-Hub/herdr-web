import { ClientMessageSchema, ServerMessageSchema, type ClientMessage, type ServerMessage } from "./schema.js";

export type Parsed<T> = { ok: true; message: T } | { ok: false; error: string };

function parse<T>(text: string, validate: (v: unknown) => { success: true; data: T } | { success: false; error: { message: string } }): Parsed<T> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "not valid JSON" };
  }
  const result = validate(json);
  return result.success ? { ok: true, message: result.data } : { ok: false, error: result.error.message };
}

/** Validate a text frame from the bridge. */
export function parseServerMessage(text: string): Parsed<ServerMessage> {
  return parse(text, (v) => ServerMessageSchema.safeParse(v));
}

/** Validate a text frame from the browser. */
export function parseClientMessage(text: string): Parsed<ClientMessage> {
  return parse(text, (v) => ClientMessageSchema.safeParse(v));
}

export function encodeMessage(message: ServerMessage | ClientMessage): string {
  return JSON.stringify(message);
}
