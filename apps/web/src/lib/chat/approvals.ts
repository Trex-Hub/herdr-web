import type { Approval, ApprovalOption, ApprovalRecord, Live } from "@herdr-web/agents/rows"

// What the approval card offers for a guardrails prompt, and what the line under its call says. Pure: no React.

/** How long Allow stays off after a card appears, so a tap meant for something else cannot approve. */
export const APPROVAL_GUARD_MS = 600

/** Where a long command folds until the reader opens it. */
export const COMMAND_LINES = 12

/** The options as the card lays them out: the one-tap allow, the wider grants behind its arrow, Deny, and Decline and stop. Order is the prompt's. */
export interface ApprovalChoices {
  primary: ApprovalOption | null
  grants: ApprovalOption[]
  deny: ApprovalOption | null
  stop: ApprovalOption | null
}

const isOnce = (o: ApprovalOption) => o.result === "allow" || o.result.endsWith("-once")

export function approvalChoices(approval: Approval): ApprovalChoices {
  const options = approval.view.options
  const deny = options.find((o) => o.result === "deny") ?? null
  const stop = options.find((o) => o.result === "stop") ?? null
  const allows = options.filter((o) => o !== deny && o !== stop)
  const primary = allows.find((o) => isOnce(o) && !o.disabled) ?? null
  return { primary, grants: allows.filter((o) => o !== primary), deny, stop }
}

/** The second line of a grant in the menu: what it covers, and where an "always" one is saved. */
export function grantDetail(approval: Approval, option: ApprovalOption): string {
  if (option.disabled) return option.disabledReason ? `Not available: ${option.disabledReason}` : "Not available"
  const r = option.result
  if (approval.kind === "guardrails.command") return r === "allow-session" ? "This exact command, until this pi session ends" : ""
  const v = approval.view
  const where = v.alwaysSavedTo === "global" ? "Saved to your global guardrails settings" : "Saved to this project's guardrails settings"
  if (r.endsWith("-always")) return `${r.includes("-dir-") ? v.directory : v.path} · ${where}`
  if (r.endsWith("-session")) return `${r.includes("-dir-") ? v.directory : v.path} · until this pi session ends`
  if (r.endsWith("-once")) return r.includes("-dir-") ? v.directory : v.path
  return ""
}

/** The card's question. */
export function approvalQuestion(approval: Approval): string {
  if (approval.kind === "guardrails.command") return "Run this command?"
  return approval.view.target === "directory" ? "Open a folder outside the workspace?" : "Use a file outside the workspace?"
}

/** The command as numbered lines; one line has no number. */
export function commandLines(command: string): string[] {
  return command.split("\n")
}

/** The row an approval's line goes under: the parent's call for one another tool made. Null when the prompt does not say. */
export function approvalCallId(approval: Approval): string | null {
  return approval.view.parentToolCallId ?? approval.view.toolCallId ?? null
}

/** What a result was, in the past tense, for the line under the call. */
const DONE: Record<string, string> = {
  allow: "Allowed once",
  "allow-session": "Allowed for this session",
  deny: "Denied",
  stop: "Denied and stopped",
  "allow-file-once": "Allowed once",
  "allow-dir-once": "Allowed once",
  "allow-file-session": "Allowed this file for this session",
  "allow-dir-session": "Allowed this folder for this session",
  "allow-file-always": "Always allowed this file",
  "allow-dir-always": "Always allowed this folder",
}

/**
 * The line under a call a guardrails prompt was about: waiting while it is open, then how it ended. A result this app sent
 * is named; one given elsewhere is not known here (pi-live does not say), and the call's own row shows whether it ran.
 */
export function approvalLineText(line: ApprovalLine): { text: string; tone: "waiting" | "allowed" | "denied" | "muted" } {
  if (line.kind === "open") return { text: "Awaiting approval", tone: "waiting" }
  const { by, result, label } = line.record
  if (by === "client" && result !== null) {
    const text = Object.hasOwn(DONE, result) ? DONE[result]! : `Answered: ${label ?? result}`
    return { text, tone: result === "deny" || result === "stop" ? "denied" : "allowed" }
  }
  if (by === "client") return { text: "Answered in another window", tone: "muted" }
  if (by === "keyboard") return { text: "Answered in the terminal", tone: "muted" }
  if (by === "abort") return { text: "Denied: the agent was stopped", tone: "denied" }
  if (by === "error") return { text: "Not answered: the prompt failed", tone: "muted" }
  return { text: "Not answered: pi closed the prompt", tone: "muted" }
}

export type ApprovalLine = { kind: "open"; id: string } | { kind: "record"; record: ApprovalRecord }

/** The line for a call: its open prompt first, else the newest record of one. Null when guardrails never asked about it. */
export function approvalLineFor(live: Pick<Live, "approvals" | "approved">, callId: string): ApprovalLine | null {
  const open = live.approvals.find((a) => approvalCallId(a) === callId)
  if (open) return { kind: "open", id: open.id }
  for (let i = live.approved.length - 1; i >= 0; i--) if (live.approved[i]!.callId === callId) return { kind: "record", record: live.approved[i]! }
  return null
}

/** A key for `approvalLineFor` that compares equal while the line is unchanged (the live part is replaced on every update). */
export function approvalLineKey(live: Pick<Live, "approvals" | "approved">, callId: string): string {
  const line = approvalLineFor(live, callId)
  if (!line) return ""
  return line.kind === "open" ? `open:${line.id}` : `record:${JSON.stringify(line.record)}`
}

export function approvalLineFromKey(key: string): ApprovalLine | null {
  if (key === "") return null
  if (key.startsWith("open:")) return { kind: "open", id: key.slice(5) }
  return { kind: "record", record: JSON.parse(key.slice(7)) as ApprovalRecord }
}
