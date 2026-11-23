// pi-live items that are ask_user prompts, as the thread's `live.asks` holds them.
import { AskSchema, type Ask } from "../rows.js"
import type { PiLiveItem } from "../pi-live/wire.js"

/** The owner pi-ask-user parks its prompts under. */
export const ASK_OWNER = "ask_user"

/** The ask an item is, or why it is not one: another owner, a kind or view we do not know. */
export function askOf(item: PiLiveItem): { ask: Ask } | { left: string } {
  if (item.owner !== ASK_OWNER) return { left: `an item of ${item.owner} (${item.kind})` }
  const parsed = AskSchema.safeParse({ id: item.id, kind: item.kind, title: item.title, view: item.view, openedAt: item.openedAt, expiresAt: item.expiresAt ?? null })
  if (!parsed.success) return { left: `an ask_user item ${item.kind} that does not fit (${parsed.error.issues[0]?.path.join(".") || "shape"})` }
  return { ask: parsed.data }
}
