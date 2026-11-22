import type { Terminal } from "@herdr-web/protocol"

export type View = "chat" | "terminal"

export const viewKey = (address: string): string => `herdr-web.view.${address}`
export const HINT_KEY = "herdr-web.hint.pi-extension" // the key stays: a reader who dismissed the hint before has dismissed this one

/** What a pane opens on. Chat when the terminal has one, unless the reader chose Terminal for it before; no chat: the terminal. */
export function initialView(chat: boolean, stored: View | null): View {
  return chat ? (stored ?? "chat") : "terminal"
}

export function readView(address: string): View | null {
  try {
    const raw = localStorage.getItem(viewKey(address))
    return raw === "chat" || raw === "terminal" ? raw : null
  } catch {
    return null
  }
}

export function writeView(address: string, view: View): void {
  try {
    localStorage.setItem(viewKey(address), view)
  } catch {
    // storage blocked: the choice holds for this page
  }
}

/**
 * Whether to tell the reader that chat needs pi-live: a live terminal of the bridge's own computer whose status says
 * its program is pi, and which has no chat.
 */
export function wantsChatHint(t: Terminal): boolean {
  return t.state === "live" && !t.chat && !t.address.includes("/") && t.status?.app === "pi"
}

/** What the composer says is the matter when the page cannot reach the agent through the backend. */
export function awayReason(away: "backend" | "core" | null): string | null {
  if (away === "backend") return "The link to the backend is down. Nothing can be sent until it is back."
  if (away === "core") return "The backend has lost its link to core. Nothing can be sent until it is back."
  return null
}

export const PI_GONE = "pi-live is not connected to this agent, so nothing can be sent. The rows shown are the last it reported."
