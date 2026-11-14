import type { Terminal } from "@herdr-web/protocol"

/** What the sidebar shows for an agent. */
export type AgentState = "needs_you" | "working" | "done" | "idle"

/** An agent is a live terminal whose program has reported status. */
export function isAgent(t: Terminal): boolean {
  return t.state === "live" && t.status !== null
}

/** The `herdr.seen` label as a turn number; null when missing or not a number. */
export function seenTurn(t: Terminal): number | null {
  const raw = t.labels["herdr.seen"]
  if (raw === undefined || raw.trim() === "") return null
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : null
}

export function isPinned(t: Terminal): boolean {
  return (t.labels["herdr.pinned"] ?? "") !== ""
}

/**
 * Blocked or error needs you; working is working; otherwise done when the turn is above the
 * seen turn, else idle. A missing (or unreadable) seen label counts as 0, so any turn above 0
 * is done until it has been looked at (docs/labels.md of herdr-app).
 */
export function agentState(t: Terminal): AgentState {
  const state = t.status?.state.toLowerCase()
  if (state === "blocked" || state === "error") return "needs_you"
  if (state === "working") return "working"
  return t.turn > (seenTurn(t) ?? 0) ? "done" : "idle"
}

export const stateLabel: Record<AgentState, string> = {
  needs_you: "Needs you",
  working: "Working",
  done: "Done",
  idle: "Idle",
}

/** The name an agent goes by: its name, else its title, else its program, else its address. */
export function agentName(t: Terminal): string {
  return t.name || t.title || t.status?.app || t.foreground?.name || t.address
}

/** "now", "39m", "3h", "2d": how long ago, for a row. */
export function formatAge(nowMs: number, thenMs: number | null): string {
  if (thenMs === null) return ""
  const s = Math.max(0, Math.floor((nowMs - thenMs) / 1000))
  if (s < 45) return "now"
  const m = Math.floor(s / 60)
  if (m < 60) return `${Math.max(m, 1)}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}
