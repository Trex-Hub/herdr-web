// pi-live items that are guardrails prompts (Trex-Hub/pi-guardrails), as the thread's `live.approvals` holds them,
// and what is kept of one once it closes (`live.approved`).
import { ApprovalSchema, type Approval, type ApprovalRecord } from "../rows.js"
import type { PiLiveItem } from "../pi-live/wire.js"

/** The owner guardrails parks its prompts under. */
export const APPROVAL_OWNER = "guardrails"

/** How long a record's subject may be: one line. */
const SUBJECT_CUT = 160

/** The approval an item is, or why it is not one: another owner, a kind or view we do not know. */
export function approvalOf(item: PiLiveItem): { approval: Approval } | { left: string } {
  if (item.owner !== APPROVAL_OWNER) return { left: `an item of ${item.owner} (${item.kind})` }
  const parsed = ApprovalSchema.safeParse({ id: item.id, kind: item.kind, title: item.title, view: item.view, openedAt: item.openedAt })
  if (!parsed.success) return { left: `a guardrails item ${item.kind} that does not fit (${parsed.error.issues[0]?.path.join(".") || "shape"})` }
  return { approval: parsed.data }
}

/** The row a prompt's line goes under: the parent's call for one another tool made. Null when the prompt does not say. */
export function approvalCallId(approval: Approval): string | null {
  return approval.view.parentToolCallId ?? approval.view.toolCallId ?? null
}

/** What a prompt is about, on one line: the command's first line, or the path as the terminal shows it. */
export function approvalSubject(approval: Approval): string {
  const whole = approval.kind === "guardrails.command" ? approval.view.command : approval.view.displayPath
  const lines = whole.trim().split("\n")
  const first = lines[0] ?? ""
  const cut = first.length > SUBJECT_CUT ? `${first.slice(0, SUBJECT_CUT - 1)}…` : first
  return lines.length > 1 && cut === first ? `${cut} …` : cut
}

/** The record of a prompt that closed. `answered` is the result this app sent and pi took, when it did. */
export function approvalRecord(approval: Approval, by: ApprovalRecord["by"], answered: string | null): ApprovalRecord {
  const option = answered === null ? undefined : approval.view.options.find((o) => o.result === answered)
  return {
    id: approval.id,
    kind: approval.kind,
    callId: approvalCallId(approval),
    subject: approvalSubject(approval),
    by,
    result: option ? option.result : null,
    label: option ? option.label : null,
  }
}

/** pi-live's `outcome.by` as a record's. One we do not know (a newer pi-live), or none, is `gone`. */
export function closedBy(by: string | undefined): ApprovalRecord["by"] {
  return by === "client" || by === "keyboard" || by === "abort" || by === "error" || by === "shutdown" ? by : "gone"
}
