// pi-link in the chat: reading what pi-link writes (a batch of received messages, its tools' results) and the colour of a terminal's name.
import type { ToolRow } from "@herdr-web/agents/rows"

/** One item of a received batch: a message from another terminal, or the outcome of a compaction this agent asked for. */
export type LinkItem = { kind: "message"; from: string; body: string } | { kind: "compact"; target: string; outcome: string }

/** A received batch split into its items; or, when the split cannot be trusted, its whole text and the sender its first header names. */
export type LinkBatch = { split: true; items: LinkItem[] } | { split: false; text: string; from: string | null }

const HEADER = /^\[Link: (\d+) message\(s\) received\]\n\n/
// An item starts after a blank line with one of the two headers pi-link writes.
const ITEM_START = /\n\n(?=From "[^"\n]*":\n|link_compact "[^"\n]*" \[[^\]\n]*\]: )/
const MESSAGE = /^From "([^"\n]*)":\n([\s\S]*)$/
const COMPACT = /^link_compact "([^"\n]*)" \[[^\]\n]*\]: ([\s\S]*)$/

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/**
 * The items of a received batch (`[Link: N message(s) received]` and its items, joined by blank lines). A body can itself hold a
 * blank line and `From "…":`, so the split counts only when it gives the `details.count` pi-link recorded; otherwise the whole
 * text comes back, and none of it is lost.
 */
export function parseLinkBatch(text: string, details: unknown): LinkBatch {
  const header = HEADER.exec(text)
  const body = header ? text.slice(header[0].length) : text
  const whole: LinkBatch = { split: false, text: body, from: MESSAGE.exec(body)?.[1] ?? null }
  const count = isObj(details) && typeof details["count"] === "number" ? details["count"] : null
  if (!header || count === null || Number(header[1]) !== count) return whole
  const items: LinkItem[] = []
  for (const part of body.split(ITEM_START)) {
    const message = MESSAGE.exec(part)
    const compact = message ? null : COMPACT.exec(part)
    if (message) items.push({ kind: "message", from: message[1]!, body: message[2]! })
    else if (compact) items.push({ kind: "compact", target: compact[1]!, outcome: compact[2]! })
    else return whole
  }
  return items.length === count ? { split: true, items } : whole
}

/** What a compaction this agent asked for came to, as a line: "builder compacted", or the outcome pi-link gave. */
export function compactOutcomeText(target: string, outcome: string): string {
  return outcome === "compacted" ? `${target} compacted` : `Compaction of ${target}: ${outcome}`
}

/** A point on the colour wheel for a terminal's name (FNV-1a of the name), so a name has the same colour in every chat. */
export function nameHue(name: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0
  return h % 360
}

/** Up to two letters for an avatar: the first of each of the name's last two words (`herdr-web-builder` → `WB`). */
export function initials(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  return words.slice(-2).map((w) => [...w][0]!.toUpperCase()).join("") || "?"
}

/** `14:05`, in the browser's time zone; empty for no time. */
export function clock(at: number | null): string {
  return at === null ? "" : new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

/** Why a pi-link tool call did not do its job, or null when it did (or has not ended). pi-link reports most failures as a plain result with `details.error`. */
export function linkFailure(row: Pick<ToolRow, "status" | "result" | "details">): string | null {
  const text = row.result?.text.trim() || null
  if (row.status === "error") return text ?? "Failed."
  if (isObj(row.details) && typeof row.details["error"] === "string") return text ?? row.details["error"]
  return null
}

/** A `link_list` result's terminals, with each one's status where it has one, and which is this agent. Null for details in another shape. */
export function readLinkList(details: unknown): { terminals: string[]; statuses: ReadonlyMap<string, string>; self: string | null } | null {
  if (!isObj(details) || !Array.isArray(details["terminals"])) return null
  const terminals = details["terminals"].filter((t): t is string => typeof t === "string")
  // A Map: the names come from other terminals, and `__proto__` is a name.
  const statuses = new Map<string, string>()
  if (isObj(details["statuses"])) {
    for (const [name, status] of Object.entries(details["statuses"])) if (typeof status === "string") statuses.set(name, status)
  }
  return { terminals, statuses, self: typeof details["self"] === "string" ? details["self"] : null }
}
